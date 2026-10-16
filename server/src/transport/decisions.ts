import {
  createEgressPolicy,
  egressTrustOptions,
  resolveAndValidateHost,
  SsrfValidationError,
} from "../plugins/ssrf.ts";
import type { EgressPolicy, LookupFn, Mode } from "../plugins/ssrf.ts";
import { createPinnedEgressClient } from "../egress/client.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";

/**
 * Decision client: the outbound path to an internal decision model (Kev-4B).
 *
 * It speaks the "System One" wire contract implemented by the homelab POC
 * (`semantic_eval.py`): the caller provides a `state` string plus a map of
 * question id -> `{type: "noul", instructions}`, and the server answers with a
 * per-question probability. Because batching non-causal (encoder) prompts
 * corrupts their scores upstream, the client sends ONE request PER QUESTION —
 * never a batch body — and always posts to `{baseUrl}/v1/systemone`.
 *
 * Every failure is classified so callers (the Sentinel semantic wiring, added
 * in a later step) can report orthogonal outcomes instead of a collapsed
 * success flag.
 *
 * EGRESS: this module performs no egress itself. It builds the same
 * manifest-derived `EgressPolicy` the model path uses and routes every request
 * through the shared pinned egress client (`policyFetch` under the hood), so a
 * private `http:` endpoint is reachable ONLY when the admin vouches for the
 * host through `egressTrustOptions` (range bypass + production `http:` carve-out
 * move together). There is no raw fetch here, and no per-call trust parameter:
 * the trust list is captured at construction.
 */

/** The one path the internal decision server exposes. */
export const DECISION_ENDPOINT_PATH = "/v1/systemone";

export const DEFAULT_DECISION_TIMEOUT_MS = 2_000;
export const DEFAULT_DECISION_MAX_CONCURRENCY = 4;

/**
 * Orthogonal failure classes. A caller reads `error` directly; nothing is
 * nested inside another outcome's branch.
 *
 * - `timeout`          per-request deadline elapsed
 * - `egress_rejected`  SSRF facade refused the destination (scheme/range/redirect)
 * - `network`          request reached the network and failed (connect/reset/...)
 * - `http_status`      the server answered with a non-2xx status
 * - `invalid_response` the server answered 2xx but the body was not the
 *                      expected `{answers: {<id>: {noul: <probability>}}}`
 *                      shape, or the probability was not a finite number in
 *                      `[0, 1]`
 */
export type DecisionErrorCode =
  | "timeout"
  | "egress_rejected"
  | "network"
  | "http_status"
  | "invalid_response";

/**
 * The one question kind the System One endpoint accepts: a `noul` head scored
 * against a natural-language instruction. The instruction is caller-authored
 * (e.g. "Does the text concern self-harm?").
 */
export type DecisionQuestion = {
  readonly type: "noul";
  readonly instructions: string;
};

/** One question's outcome. `probability` is the validated `noul` score. */
export type DecisionAnswer =
  | {
      readonly ok: true;
      readonly probability: number;
    }
  | {
      readonly ok: false;
      readonly error: DecisionErrorCode;
      /** Present for `http_status`. */
      readonly status?: number;
      /** Server-side diagnostic; never carries credentials. */
      readonly detail?: string;
    };

/**
 * One entry per requested question id, in request order. A failed question
 * yields a classified `ok: false` entry rather than collapsing the whole call,
 * so a caller can act on the questions that answered.
 */
export type DecisionAnswers = Readonly<Record<string, DecisionAnswer>>;

export type DecisionClient = {
  /** Resolved `{plugin.inference.endpoint}${DECISION_ENDPOINT_PATH}`. */
  readonly endpoint: string;
  /**
   * The plugin's inference token budget (its context window). Exposed so a
   * caller can size an input cap from the model it is actually talking to; the
   * Sentinel semantic wrapper uses it to bound `state` before `decide`.
   */
  readonly tokenLimit: number;
  /**
   * Ask every question against one `state`. One POST PER QUESTION, bounded to
   * `maxConcurrency` in flight, with answers keyed in the SAME order as the
   * input. Never batches multiple questions into one request body.
   */
  decide(
    state: string,
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Promise<DecisionAnswers>;
};

export type DecisionClientOptions = {
  /**
   * Admin-vouched hosts for this destination. Paired internally with the
   * production `http:` carve-out via `egressTrustOptions`, so an internal
   * `http:` decision server works in production while every other scheme/range
   * defense stays intact. Defaults to empty (nothing private is reachable).
   */
  trustedHosts?: readonly string[];
  /** Retained validated pins for the endpoint; when absent the host is resolved. */
  pinnedIps?: readonly string[];
  /** Scheme-enforcement override (defaults to the process `NODE_ENV`). */
  mode?: Mode;
  /** Injectable A/AAAA resolver (tests); defaults to `node:dns/promises`. */
  lookup?: LookupFn;
  /** Injectable network caller (tests); defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-question deadline (ms). Defaults to {@link DEFAULT_DECISION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Max in-flight POSTs. Defaults to {@link DEFAULT_DECISION_MAX_CONCURRENCY}. */
  maxConcurrency?: number;
};

function normalizeBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    throw new SsrfValidationError("INVALID_URL", "decision client requires a non-empty endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrfValidationError("INVALID_URL", `decision client endpoint is not a URL: ${baseUrl}`);
  }
  return parsed;
}

function decisionEgressPolicy(input: {
  baseUrl: string;
  pluginId: string;
  pinnedIps: readonly string[];
  trustedHosts: readonly string[];
  mode: Mode | undefined;
  lookup: LookupFn | undefined;
}): EgressPolicy {
  const trust = egressTrustOptions(input.trustedHosts);
  const hasPins = input.pinnedIps.length > 0;
  return createEgressPolicy({
    subject: `decisions:${input.pluginId}`,
    destinations: [{
      baseUrl: input.baseUrl,
      pinnedIps: hasPins ? input.pinnedIps : [],
      resolvePins: hasPins
        ? undefined
        : (hostname) =>
            resolveAndValidateHost(hostname, {
              trustedHosts: input.trustedHosts,
              lookup: input.lookup,
            }),
      methods: ["POST"],
      exactPaths: [DECISION_ENDPOINT_PATH],
    }],
    trustedHosts: trust.trustedHosts,
    httpAllowedHosts: trust.httpAllowedHosts,
    mode: input.mode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the System One answer for ONE question. The endpoint echoes the
 * question id it was asked, so only that id is read; any other shape (missing
 * answers object, missing id, non-finite probability, probability outside
 * `[0, 1]`) is an `invalid_response`.
 */
function parseAnswer(body: unknown, questionId: string): DecisionAnswer {
  if (!isRecord(body) || !isRecord(body.answers)) {
    return { ok: false, error: "invalid_response" };
  }
  const entry = body.answers[questionId];
  if (!isRecord(entry)) {
    return { ok: false, error: "invalid_response" };
  }
  const probability = entry.noul;
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    return { ok: false, error: "invalid_response" };
  }
  return { ok: true, probability };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, returning results
 * in input order regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build a decision client bound to ONE decision plugin and ONE trust list. The
 * policy is built once (construction is where trust is fixed), so a call site
 * cannot widen trust per request.
 */
export function buildDecisionClient(
  plugin: ModelPluginDefinition,
  options: DecisionClientOptions = {},
): DecisionClient {
  const base = normalizeBaseUrl(plugin.inference.endpoint);
  const endpoint = new URL(DECISION_ENDPOINT_PATH, base).href;
  const pluginId = plugin.id;
  const pinnedIps = options.pinnedIps ?? [];
  const requestedTimeout = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.floor(requestedTimeout))
    : DEFAULT_DECISION_TIMEOUT_MS;
  const requestedConcurrency = options.maxConcurrency ?? DEFAULT_DECISION_MAX_CONCURRENCY;
  const maxConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : DEFAULT_DECISION_MAX_CONCURRENCY;

  const policy = decisionEgressPolicy({
    baseUrl: plugin.inference.endpoint,
    pluginId,
    pinnedIps,
    trustedHosts: options.trustedHosts ?? [],
    mode: options.mode,
    lookup: options.lookup,
  });
  const egress = createPinnedEgressClient({ fetchFn: options.fetchFn });

  function failure(
    error: DecisionErrorCode,
    extra: { status?: number; detail?: string } = {},
  ): DecisionAnswer {
    return { ok: false, error, ...extra };
  }

  async function askOne(
    state: string,
    questionId: string,
    question: DecisionQuestion,
  ): Promise<DecisionAnswer> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The deadline bounds the WHOLE operation, not just the network fetch:
    // `authorizeEgressRequest` resolves DNS through a `LookupFn` that is not
    // abortable, so `controller.abort()` cannot unblock a stalled resolver.
    // Racing the request promise is what keeps a hung lookup (or a stalled
    // response body) from outliving the deadline and blocking the serial
    // shadow drain.
    const request = (async (): Promise<DecisionAnswer> => {
      // Exactly one question per request: batching encoder prompts corrupts
      // their scores upstream.
      const body = JSON.stringify({ state, questions: { [questionId]: question } });
      const response = await egress.fetch(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          signal: controller.signal,
        },
        policy,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return failure("http_status", { status: response.status });
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        // Aborting the signal on deadline can reject an in-flight body read;
        // that is still a timeout, not malformed output.
        if (timedOut) {
          return failure("timeout", { detail: `no response within ${timeoutMs}ms` });
        }
        return failure("invalid_response", { status: response.status });
      }
      return parseAnswer(answer, questionId);
    })();

    const deadline = new Promise<DecisionAnswer>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(failure("timeout", { detail: `no response within ${timeoutMs}ms` }));
      }, timeoutMs);
    });

    // Once the deadline wins, `request` is abandoned but may still settle later:
    // the resolver cannot be cancelled, and an in-flight fetch/body read rejects
    // when the signal aborts. Consume it so it never surfaces as an unhandled
    // rejection.
    void request.catch(() => {});

    try {
      return await Promise.race([request, deadline]);
    } catch (err) {
      if (err instanceof SsrfValidationError) {
        return failure("egress_rejected", { detail: err.message });
      }
      // `timedOut` is set before `abort()`, so a rejection the abort itself
      // triggers is classified as the timeout it is.
      if (timedOut) {
        return failure("timeout", { detail: `no response within ${timeoutMs}ms` });
      }
      return failure("network", { detail: (err as Error).message });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function decide(
    state: string,
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Promise<DecisionAnswers> {
    const ids = Object.keys(questions);
    const answers = await mapWithConcurrency(ids, maxConcurrency, (id) =>
      askOne(state, id, questions[id]!));
    const result: Record<string, DecisionAnswer> = {};
    for (let index = 0; index < ids.length; index += 1) {
      result[ids[index]!] = answers[index]!;
    }
    return result;
  }

  return { endpoint, tokenLimit: plugin.inference.tokenLimit, decide };
}
