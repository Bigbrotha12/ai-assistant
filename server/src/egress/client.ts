import {
  authorizeEgressRequest,
  buildPinnedAgent,
  createEgressPolicy,
  normalizeHostname,
  policyFetch,
  resolveAndValidateHost,
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
 *        `validateStaticUrl` re-check and forced `redirect: "manual"`.
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
 * validation — and always forces `redirect: "manual"` against the pinned
 * agent built at `openPinned` time.
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
   * Test seam: overrides the pinned-agent factory. Defaults to
   * `buildPinnedAgent` for the exact host/scheme/port.
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
      const pinned = streamOpts?.pinnedIps === undefined
        ? await resolveAndValidateHost(hostname, { trustedHosts, lookup })
        : await authorizeRetainedPins(parsed, streamOpts.pinnedIps, {
            trustedHosts,
            httpAllowedHosts,
            mode,
            subject,
          });
      const agent = streamOpts?.createAgent?.(hostname, parsed, pinned)
        ?? buildPinnedAgent(hostname, parsed, pinned);

      const streamFetch = (requestUrl: string, init?: RequestInit): Promise<Response> => {
        // Re-validate on EVERY request: a reconnect (or a different URL) must
        // not reuse the first call's static decision. The pinned agent still
        // refuses any destination other than the exact host/scheme/port.
        validateStaticUrl(requestUrl, { mode, trustedHosts, httpAllowedHosts });
        const activeFetch = streamOpts?.fetchFn ?? fetchFn ?? globalThis.fetch;
        const requestInit = {
          ...init,
          redirect: "manual",
          dispatcher: agent,
        } as unknown as RequestInit;
        return activeFetch(requestUrl, requestInit);
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
