import { ToolResourceError } from "../tools/bounds.ts";

/**
 * `read_only_retry.ts` — Phase 7.2's read-only retry-with-backoff policy
 * (plan M5 / R7).
 *
 * This is deliberately NOT a pipeline interceptor. The pipeline contract
 * (`tools/pipeline.ts`) allows `next()` to be called EXACTLY ONCE per
 * interceptor per dispatch, so a retrying interceptor cannot re-enter the
 * onion; and re-running the whole onion would take a second `reserve` (goal
 * at-most-once transaction) and a second `execution` bound for one logical
 * call. Instead the retry wraps the raw outbound invoke: for the plugin
 * channels via `makeToolBodies`/`makePluginBodies` (`tools/bind.ts`), and for
 * MCP inside `runMcpOperation` (`agents/mcp.ts`, finding H1 — one `mcp.tool`
 * audit and one circuit classification per dispatch). In both cases ONE
 * dispatch still performs exactly one reservation and one execution bound, and
 * only the outbound attempt is repeated.
 *
 * Retrying is gated on `ToolCall.readOnly`: a read-only tool is safe to repeat
 * because it cannot mutate provider or goal state. A mutating call is never
 * retried here — at-most-once is owned by the goal `reserve` interceptor and
 * the job replay/idempotency rules, not by this helper.
 *
 * ## What is retried (and what is not)
 *
 * Only TRANSPORT-LEVEL failures are retried: an error that carries a transient
 * transport marker (an allowlisted `code` like `ECONNRESET`, or a 502/503/504
 * `status`), including a marker on a nested `cause`. These are the failures a
 * second outbound attempt can plausibly fix.
 *
 * Handler/model timeouts and MCP wrapper errors are intentionally NOT retried:
 *   - the `execution` interceptor's bound (`invokeBoundedToolHandler`,
 *     `tool_bounds.ts`) wraps OUTSIDE the body. On a timeout it aborts the
 *     composed signal with a `tool_timeout` reason and rejects the dispatch with
 *     its OWN `ToolResourceError`; the BODY never sees that object — it sees an
 *     aborted signal / `AbortError`, which the predicate deliberately rejects
 *     (an abort is indistinguishable from a caller cancellation, and retrying it
 *     could re-run a call the caller cancelled). The timeout branch below is
 *     therefore unreachable by design for the pipeline timeout;
 *   - an MCP wrapper error (`MCP_TIMEOUT`, `MCP_CIRCUIT_OPEN`, `MCP_DISPOSED`,
 *     the eviction codes, `MCP_ERROR`) carries no allowlisted transport marker,
 *     so it is never retried. The still-present `ToolResourceError` check covers
 *     only a DIRECT throw of `tool_timeout` at the body seam (e.g. a caller that
 *     invokes the body helper outside the `execution` bound), not the pipeline
 *     timeout path.
 *
 * ## Conservative transient predicate
 *
 * `isTransientToolFailure` is an ALLOWLIST, never a denylist. A **false
 * negative** (we decline to retry something transient) costs one missed retry;
 * a **false positive** (we retry something that was not transient) re-runs an
 * outbound call. Even though this helper is only reached for read-only calls,
 * the predicate stays conservative: when in doubt, do not retry.
 */

/**
 * Total attempts for a retryable read-only call: the first try plus exactly ONE
 * retry. Kept as a named constant so the attempt cap and the backoff schedule
 * cannot drift.
 */
export const READ_ONLY_RETRY_MAX_ATTEMPTS = 2;

/**
 * Backoff before the next attempt, indexed by the attempt that just failed:
 * `READ_ONLY_RETRY_BACKOFF_MS[0]` is the delay after attempt 1. With
 * `READ_ONLY_RETRY_MAX_ATTEMPTS = 2` only the first entry is currently used;
 * the second is kept so raising the attempt cap does not require re-deriving
 * the schedule.
 */
export const READ_ONLY_RETRY_BACKOFF_MS = [250, 1000] as const;

/** Transient transport error codes (Node/undici and common fetch wrappers). */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "timeout",
  "network_error",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
]);

/** Transient HTTP statuses (gateway/unavailable class). */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Max `cause` chain depth inspected for a nested transport marker. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Conservative transient-failure allowlist. Returns `true` ONLY for failures
 * we are confident a retry can plausibly fix:
 *
 *   - a `ToolResourceError` with code `tool_timeout`. This covers only a DIRECT
 *     throw of the timeout error at the body seam; the pipeline's own
 *     `execution` timeout wraps OUTSIDE the body and surfaces to the body as an
 *     `AbortError` (see the module doc's "What is retried"), so this arm is
 *     unreachable for the normal bound and deliberately stays for a direct
 *     throw;
 *   - a transport error whose `code` is one of {@link TRANSIENT_ERROR_CODES},
 *     including a code carried on a nested `cause` (Node's `fetch` wraps socket
 *     failures in `TypeError: fetch failed` with the real `code` on `.cause`);
 *   - an error carrying a transient `status`/`statusCode`
 *     (502/503/504).
 *
 * Everything else — including every `AbortError` — is `false`. The bare
 * `AbortError` DOMException does not carry the abort reason, so a caller
 * cancellation and the `execution` interceptor's timeout are indistinguishable
 * from the error alone (the MCP body distinguishes them by inspecting
 * `bodySignal.reason` via `isToolTimeoutAbort`, which this error-only helper
 * cannot do). Retrying an abort could therefore re-run a call the caller
 * cancelled, so we never retry one.
 */
export function isTransientToolFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  // The ONE ToolResourceError worth retrying. The other codes
  // (`tool_result_too_large`, `tool_args_*`) are deterministic properties of
  // the request/response size and would fail identically on retry.
  if (error instanceof ToolResourceError) {
    return error.code === "tool_timeout";
  }

  // Any `AbortError` (DOMException or Error) is excluded for the reason above.
  if (error instanceof Error && error.name === "AbortError") return false;

  return hasTransientTransportMarker(error);
}

function hasTransientTransportMarker(root: object): boolean {
  const seen = new Set<object>();
  let current: unknown = root;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const record = current as {
      readonly code?: unknown;
      readonly status?: unknown;
      readonly statusCode?: unknown;
      readonly cause?: unknown;
    };
    if (
      typeof record.code === "string" &&
      TRANSIENT_ERROR_CODES.has(record.code)
    ) {
      return true;
    }
    if (
      typeof record.status === "number" &&
      TRANSIENT_HTTP_STATUSES.has(record.status)
    ) {
      return true;
    }
    if (
      typeof record.statusCode === "number" &&
      TRANSIENT_HTTP_STATUSES.has(record.statusCode)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export type ReadOnlyRetryOptions = {
  /**
   * The ACTUAL read-only classification of the operation. A mutating call
   * (`false`) is invoked exactly once. Callers must pass the real value (never
   * a hardcoded `true`): a future mutating caller cannot be silently retried.
   */
  readOnly: boolean;
  signal: AbortSignal;
  /**
   * Optional teardown hook invoked EXACTLY ONCE before each retry backoff —
   * after the decision to retry, before waiting. A dead transport (a stale MCP
   * connection, an evicted client) is fixed here so the next attempt reuses a
   * live one instead of the same stale handle (finding H1 follow-up, B).
   *
   * The hook is contained: a synchronous throw or a rejected promise is
   * swallowed so a broken teardown cannot break the retry it prepares for. The
   * hook MUST NOT count a failure or take a circuit permit — it is teardown,
   * not classification: the single classification happens after the final
   * attempt.
   */
  onRetry?: () => void | Promise<void>;
};

/**
 * Invoke a read-only operation with at most one backoff retry for a transient
 * failure. A mutating call (`readOnly: false`) is invoked exactly once.
 *
 * Rules:
 *   - The retry decision requires ALL of: a transient error, attempts remain,
 *     and `signal` not already aborted. A caller cancellation therefore never
 *     starts another attempt.
 *   - Before each retry backoff `onRetry` (when given) runs once, contained.
 *   - On abort DURING the backoff the sleep wakes early, clears its timer, and
 *     the last thrown error propagates unchanged.
 *   - After the final attempt the LAST error is rethrown unchanged: this helper
 *     never swallows an error and never wraps it in a new type.
 */
export function withReadOnlyRetry<T>(
  invoke: () => Promise<T>,
  opts: ReadOnlyRetryOptions,
): Promise<T> {
  if (!opts.readOnly) return invoke();
  return retryTransientReadOnly(invoke, opts.signal, opts.onRetry);
}

async function retryTransientReadOnly<T>(
  invoke: () => Promise<T>,
  signal: AbortSignal,
  onRetry: (() => void | Promise<void>) | undefined,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READ_ONLY_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await invoke();
    } catch (error) {
      lastError = error;
      const attemptsRemain = attempt < READ_ONLY_RETRY_MAX_ATTEMPTS;
      if (!attemptsRemain || signal.aborted || !isTransientToolFailure(error)) {
        throw error;
      }
      // B: tear down the dead transport BEFORE the wait so the next attempt
      // reconnects instead of reusing the stale handle. Contained: a throwing
      // or rejecting hook must not break the retry it prepares for.
      if (onRetry !== undefined) {
        try {
          await onRetry();
        } catch {
          // Swallow: teardown must never mask the original transient failure.
        }
      }
      const backoff = READ_ONLY_RETRY_BACKOFF_MS[attempt - 1];
      if (backoff !== undefined) {
        const slept = await sleepUnlessAborted(backoff, signal);
        if (!slept) {
          // Aborted during the backoff: stop, surface the original failure.
          throw error;
        }
      }
    }
  }
  // Unreachable while READ_ONLY_RETRY_MAX_ATTEMPTS >= 1; satisfies the compiler.
  throw lastError;
}

/**
 * Abort-aware backoff. Resolves `true` when the delay elapses, `false` when
 * `signal` aborts first. The timer is always cleared exactly once, the abort
 * listener fires at most once, and an already-aborted signal resolves without
 * arming a timer — so no timer or listener outlives the wait.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
