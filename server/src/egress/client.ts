import {
  authorizeEgressRequest,
  buildPinnedAgent,
  createEgressPolicy,
  isRedirectStatus,
  normalizeHostname,
  policyFetch,
  resolveAndValidateHost,
  SsrfValidationError,
  validateStaticUrl,
  validatedFetch,
} from "../plugins/ssrf.ts";
import type { EgressPolicy, LookupFn, Mode } from "../plugins/ssrf.ts";

/**
 * Egress seam: the one module that owns "can this process make this outbound
 * request".
 *
 * This is a FACADE over `plugins/ssrf.ts`. It does not reimplement URL
 * validation, IP-range checks, DNS pinning, redirect refusal, or agent
 * construction — it composes the existing primitives:
 *
 *  - `fetch(url)`                     → `validatedFetch` (no policy)
 *  - `fetch(url, init, policy)`       → `policyFetch` (policy)
 *  - `openPinned(url, opts)`          → `validateStaticUrl` + retained-pin
 *        re-authorization (`createEgressPolicy` + `authorizeEgressRequest`) or
 *        `resolveAndValidateHost` + `buildPinnedAgent`, with a per-request
 *        `validateStaticUrl` re-check, a host/scheme/port equality assertion
 *        against the pinned URL, forced `redirect: "manual"`, and refusal of
 *        any 3xx via `isRedirectStatus`.
 *
 * `resolvePins(url, opts)` exposes the same static validation + pin resolution
 * that `openPinned` uses internally, so install-time / binding-time callers do
 * not re-inline the `trustedHosts` / `httpAllowedHosts` pairing.
 *
 * Per-domain trust is modelled by CONSTRUCTION, not by request. The three
 * egress domains have different admin-vouched host lists
 * (`PLUGINS_TRUSTED_HOSTS`, `MCP_TRUSTED_HOSTS`, `NOTIFY_TRUSTED_HOSTS`); each
 * builds its own client with its own list. There is no per-call trust
 * parameter and no shared/global list, so a call site cannot accidentally
 * apply another domain's admin-vouched hosts.
 */

/** Structural view of the undici agent `openPinned` owns and disposes. */
export type PinnedAgent = {
  destroy(): Promise<void>;
};

/**
 * A long-lived pinned stream (MCP SSE). The caller owns disposal. `fetch`
 * RE-VALIDATES the URL on every call — an SSE reconnect must not bypass
 * validation — asserts the request targets the pinned host/scheme/port, always
 * forces `redirect: "manual"` against the pinned agent built at `openPinned`
 * time, and REFUSES any 3xx with `REDIRECT_REFUSED`.
 */
export type PinnedStream = {
  /** Re-validates the URL on EVERY call (SSE reconnects must not bypass validation). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Idempotent: destroys the pinned agent exactly once. */
  dispose(): Promise<void>;
};

export type EgressClient = {
  /** With a policy: authorize against it, then pin. Without: validate + resolve + pin ad hoc. */
  fetch(url: string, init?: RequestInit, policy?: EgressPolicy): Promise<Response>;
  /** Long-lived stream; the caller owns disposal. */
  openPinned(url: string, opts?: OpenPinnedStreamOptions): Promise<PinnedStream>;
};

export type OpenPinnedStreamOptions = {
  /**
   * Retained, admin-validated address pins (e.g. a plugin/catalog store pin).
   * When supplied the host is NOT re-resolved: the pins are re-authorized
   * through `createEgressPolicy` + `authorizeEgressRequest`, mirroring MCP's
   * `validateMcpRetainedPins`. When omitted the host is resolved and validated
   * through `resolveAndValidateHost`.
   */
  readonly pinnedIps?: readonly string[];
  /**
   * TEST-ONLY seam: overrides the pinned-agent factory. Defaults to
   * `buildPinnedAgent` for the exact host/scheme/port. NEVER pass this in
   * production: a custom agent can target an arbitrary destination, bypassing
   * the connector-level pin. The stream's own host/scheme/port assertion and
   * per-request `validateStaticUrl` re-check still apply, but the agent is what
   * actually enforces the pin on the wire — so production must use the default.
   */
  readonly createAgent?: (
    hostname: string,
    parsed: URL,
    pinned: readonly string[],
  ) => PinnedAgent;
  /** Test seam: overrides the client's `fetchFn` for this stream only. */
  readonly fetchFn?: typeof fetch;
};

export type EgressClientOptions = {
  /**
   * Admin-vouched hostnames/IPs for ONE egress domain only. Bypasses range
   * checks (never scheme checks). Defaults to empty.
   */
  readonly trustedHosts?: readonly string[];
  /**
   * Admin-vouched hosts permitted to use `http:` in production for this
   * domain (mirrors `UrlValidateOptions.httpAllowedHosts`). Defaults to empty,
   * which keeps plugin/model egress https-only; MCP/notify pass their trusted
   * list here too (`egressTrustOptions`).
   *
   * NOTE: this type deliberately has NO `allowHttp` field. The blanket
   * `allowHttp: true` switch (`UrlValidateOptions.allowHttp`) would be a
   * fail-OPEN hole in production, so it is not reachable through the facade at
   * all: production `http:` is possible ONLY per-host, via `httpAllowedHosts`.
   * Do not reintroduce `allowHttp` here.
   */
  readonly httpAllowedHosts?: readonly string[];
  /** Scheme-enforcement override (defaults to the process `NODE_ENV`). */
  readonly mode?: Mode;
  /** Injectable A/AAAA resolver (tests); defaults to `node:dns/promises`. */
  readonly lookup?: LookupFn;
  /** Injectable network caller (tests); defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;
  /** Policy subject used only in validation error messages. */
  readonly subject?: string;
};

/**
 * Re-authorizes retained pins exactly as `agents/mcp.ts`'s
 * `validateMcpRetainedPins` does today: build a single-destination policy over
 * the pinned URL and run `authorizeEgressRequest`, which re-checks scheme,
 * range and pin validity but performs no DNS lookup.
 */
async function authorizeRetainedPins(
  parsed: URL,
  pinnedIps: readonly string[],
  opts: {
    readonly trustedHosts: readonly string[];
    readonly httpAllowedHosts: readonly string[];
    readonly mode: Mode | undefined;
    readonly subject: string;
  },
): Promise<readonly string[]> {
  const validationUrl = new URL(`${parsed.origin}${parsed.pathname}`);
  const policy = createEgressPolicy({
    subject: opts.subject,
    destinations: [{
      baseUrl: validationUrl.href,
      pinnedIps,
      methods: ["GET", "POST"],
      exactPaths: [validationUrl.pathname],
    }],
    trustedHosts: opts.trustedHosts,
    httpAllowedHosts: opts.httpAllowedHosts,
    mode: opts.mode,
  });
  const authorized = await authorizeEgressRequest(policy, validationUrl.href, "GET");
  return authorized.pinnedIps;
}

function effectivePort(parsed: URL): number {
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

type PinResolutionOptions = {
  readonly pinnedIps?: readonly string[];
  readonly trustedHosts: readonly string[];
  readonly httpAllowedHosts: readonly string[];
  readonly mode: Mode | undefined;
  readonly lookup: LookupFn | undefined;
  readonly subject: string;
};

/**
 * The single pin-resolution path every egress entry point uses: retained pins
 * are RE-authorized (no DNS), otherwise the host is resolved and every A/AAAA
 * record validated. `openPinned` and the exported `resolvePins` both route
 * through here, so "which addresses may this host connect to" is decided in
 * exactly one place.
 */
async function resolvePinsInternal(
  parsed: URL,
  opts: PinResolutionOptions,
): Promise<readonly string[]> {
  if (opts.pinnedIps !== undefined) {
    return authorizeRetainedPins(parsed, opts.pinnedIps, opts);
  }
  return resolveAndValidateHost(normalizeHostname(parsed.hostname), {
    trustedHosts: opts.trustedHosts,
    lookup: opts.lookup,
  });
}

export type ResolvePinsOptions = {
  /**
   * Retained, admin-validated address pins. When supplied the host is NOT
   * re-resolved: the pins are re-authorized through `createEgressPolicy` +
   * `authorizeEgressRequest`, exactly as `openPinned` does.
   */
  readonly pinnedIps?: readonly string[];
  /** Admin-vouched hostnames/IPs that bypass range checks (never scheme). */
  readonly trustedHosts?: readonly string[];
  /**
   * Per-host production `http:` carve-out. Callers that need it (MCP, notify)
   * pass `egressTrustOptions(list)` so the pairing can never drift; plugin /
   * model egress omits it and stays https-only.
   */
  readonly httpAllowedHosts?: readonly string[];
  /** Scheme-enforcement override (defaults to the process `NODE_ENV`). */
  readonly mode?: Mode;
  /** Injectable A/AAAA resolver (tests); defaults to `node:dns/promises`. */
  readonly lookup?: LookupFn;
  /** Policy subject used only in validation error messages. */
  readonly subject?: string;
};

/**
 * Validate a URL and resolve the address pins an outbound connection must be
 * bound to — the same static validation + pin resolution `openPinned`
 * performs, exposed so install-time / binding-time callers (MCP catalog, MCP
 * binding, plugin store) share ONE trust-construction path instead of
 * re-inlining the `trustedHosts` / `httpAllowedHosts` pairing (plan Phase 2,
 * M1). Throws `SsrfValidationError` on any static or DNS rejection.
 */
export async function resolvePins(
  url: string,
  opts: ResolvePinsOptions = {},
): Promise<readonly string[]> {
  const parsed = validateStaticUrl(url, {
    mode: opts.mode,
    trustedHosts: opts.trustedHosts,
    httpAllowedHosts: opts.httpAllowedHosts,
  });
  return resolvePinsInternal(parsed, {
    pinnedIps: opts.pinnedIps,
    trustedHosts: opts.trustedHosts ?? [],
    httpAllowedHosts: opts.httpAllowedHosts ?? [],
    mode: opts.mode,
    lookup: opts.lookup,
    subject: opts.subject ?? "egress",
  });
}

/**
 * Build an egress client bound to one domain's trust/mode/fetch deps. The
 * trust list is captured here and never accepted per call.
 */
export function createPinnedEgressClient(opts: EgressClientOptions = {}): EgressClient {
  const trustedHosts = opts.trustedHosts ?? [];
  const httpAllowedHosts = opts.httpAllowedHosts ?? [];
  const mode = opts.mode;
  const lookup = opts.lookup;
  const fetchFn = opts.fetchFn;
  const subject = opts.subject ?? "egress";

  return {
    fetch(url, init, policy) {
      if (policy) {
        return policyFetch(url, init, { policy, fetchFn });
      }
      return validatedFetch(url, init, {
        mode,
        trustedHosts,
        httpAllowedHosts,
        lookup,
        fetchFn,
      });
    },

    async openPinned(url, streamOpts) {
      const parsed = validateStaticUrl(url, {
        mode,
        trustedHosts,
        httpAllowedHosts,
      });
      const hostname = normalizeHostname(parsed.hostname);
      const pinned = await resolvePinsInternal(parsed, {
        pinnedIps: streamOpts?.pinnedIps,
        trustedHosts,
        httpAllowedHosts,
        mode,
        lookup,
        subject,
      });
      const agent = streamOpts?.createAgent?.(hostname, parsed, pinned)
        ?? buildPinnedAgent(hostname, parsed, pinned);
      const expectedPort = effectivePort(parsed);

      const streamFetch = async (
        requestUrl: string,
        init?: RequestInit,
      ): Promise<Response> => {
        // Re-validate on EVERY request: a reconnect (or a different URL) must
        // not reuse the first call's static decision.
        const requestParsed = validateStaticUrl(requestUrl, {
          mode,
          trustedHosts,
          httpAllowedHosts,
        });
        // Safety must not rest on the pinned agent. Assert the request targets
        // the EXACT host/scheme/port that was pinned, so the exported
        // `createAgent` seam cannot be used to re-point the stream at a
        // different destination. The agent stays as defence in depth.
        if (
          normalizeHostname(requestParsed.hostname) !== hostname ||
          requestParsed.protocol !== parsed.protocol ||
          effectivePort(requestParsed) !== expectedPort
        ) {
          throw new SsrfValidationError(
            "DISALLOWED_HOST",
            `pinned stream for ${hostname} cannot be re-pointed at ` +
              `${requestParsed.hostname} (${requestParsed.protocol})`,
          );
        }
        const activeFetch = streamOpts?.fetchFn ?? fetchFn ?? globalThis.fetch;
        const requestInit = {
          ...init,
          redirect: "manual",
          dispatcher: agent,
        } as unknown as RequestInit;
        const response = await activeFetch(requestUrl, requestInit);
        // Documented redirect policy: every outbound request is sent with
        // `redirect: "manual"` and any 3xx is refused. A pinned stream has no
        // legitimate use for a 3xx, so refuse it here exactly as the short
        // path (`validatedFetch`/`policyFetch`) does.
        if (isRedirectStatus(response.status)) {
          void response.body?.cancel().catch(() => {});
          throw new SsrfValidationError(
            "REDIRECT_REFUSED",
            `redirect (${response.status}) refused for ${hostname}; pinned streams ` +
              "never follow redirects",
          );
        }
        return response;
      };

      let disposed: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        // Memoized: the agent is destroyed at most once, and a failing destroy
        // never rejects `dispose` (matches MCP's `closeClient` allSettled).
        disposed ??= Promise.resolve()
          .then(() => agent.destroy())
          .then(() => undefined)
          .catch(() => undefined);
        return disposed;
      };

      return { fetch: streamFetch, dispose };
    },
  };
}
