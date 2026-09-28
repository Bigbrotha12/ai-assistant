import type { NotificationHook } from "../jobs/runner.ts";
import type { NotifyCredentials } from "./store.ts";
import { egressTrustOptions, isIpAllowed, isTrustedHost, normalizeHostname, NODE_ENV, validatedFetch } from "../plugins/ssrf.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import { isIP } from "node:net";

/**
 * Real ntfy push behind the job runner's {@link NotificationHook} DI seam.
 *
 * SECURITY CONTRACT
 *  - Outbound delivery is SSRF-validated via `validatedFetch` (plugin/LLM
 *    egress primitive): the ntfy URL is validated, its DNS records resolved and
 *    pinned, and any 3xx redirect refused. A private-address ntfy (loopback,
 *    RFC1918) requires its host in `NOTIFY_TRUSTED_HOSTS`; an admin-listed host
 *    is also granted the production `http:` carve-out.
 *  - The access token is read from the encrypted-at-rest notify store and used
 *    ONLY in the `Authorization: Bearer` header. It is never logged, never
 *    echoed into the summary, and never returned.
 *  - Best-effort delivery: any network/validation/store failure is swallowed
 *    (a log without the token, at most) so a push failure can never break job
 *    completion. `notifyJobComplete` always resolves.
 *  - Disabled by default: an empty `baseUrl` (NOTIFY_BASE_URL) turns every call
 *    into a silent no-op, as does an owner with no stored credentials.
 */

/** The slice of `NotifyStore` the hook needs (kept structural for test seams). */
export type NotificationCredentialSource = {
  get(owner: string): Promise<NotifyCredentials | undefined>;
};

export type NtfyNotificationHookOptions = {
  store: NotificationCredentialSource;
  /** ntfy base URL, e.g. `https://ntfy.example.com`. Empty = disabled. */
  baseUrl: string;
  /** Test seam forwarded to `validatedFetch` as its `fetchFn` (defaults to the global `fetch` when omitted). */
  fetchImpl?: typeof fetch;
  /**
   * Admin-vouched notify hosts. Passed to `validatedFetch` as BOTH
   * `trustedHosts` (private-range bypass) and `httpAllowedHosts` (production
   * `http:` carve-out) — mirroring the MCP path.
   */
  trustedHosts?: readonly string[];
  /** Test seam: injectable A/AAAA resolver for `validatedFetch`. */
  lookup?: LookupFn;
  /** Test seam: overrides NODE_ENV for `validatedFetch` scheme enforcement. */
  mode?: Mode;
};

/** Strips trailing slashes so `${base}/${topic}` never doubles a slash. */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export type NotifyEgressConfigWarningOptions = {
  /** Admin-vouched notify hosts (`NOTIFY_TRUSTED_HOSTS`). */
  trustedHosts?: readonly string[];
  /** Effective runtime mode; defaults to the process `NODE_ENV`. */
  mode?: Mode;
};

/**
 * Boot-time, side-effect-free check for a `NOTIFY_BASE_URL` the SSRF layer will
 * reject: returns a loud warning string, or `null` when nothing is wrong.
 *
 * Deliberately does NOT resolve DNS: only the two cases knowable from the URL
 * alone are reported, so a normal public `https:` host never warns.
 *  - the URL host is a LITERAL private/reserved IP (loopback, RFC1918,
 *    link-local, unique-local v6, ...) not covered by `trustedHosts`; and
 *  - the scheme is `http:` while the effective mode is `production` and the
 *    host is not trusted (mirrors `validateStaticUrl`'s http carve-out).
 *
 * Returns `null` when `NOTIFY_BASE_URL` is empty (notifications disabled) or the
 * host is trusted. The caller logs it (best-effort notifications must never
 * hard-fail the gateway on misconfiguration).
 */
export function notifyEgressConfigWarning(
  baseUrl: string,
  opts: NotifyEgressConfigWarningOptions = {},
): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // env.ts validation rejects a malformed NOTIFY_BASE_URL at load; stay
    // quiet here rather than throwing from a best-effort warning helper.
    return null;
  }

  const trustedHosts = opts.trustedHosts ?? [];
  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === "") return null;
  if (isTrustedHost(hostname, trustedHosts)) return null;

  const reasons: string[] = [];
  if (isIP(hostname) !== 0 && !isIpAllowed(hostname, { trustedHosts })) {
    reasons.push(`the host '${hostname}' is a private/reserved address`);
  }
  const mode = opts.mode ?? NODE_ENV;
  if (parsed.protocol === "http:" && mode === "production") {
    reasons.push(`the host '${hostname}' uses http: in production`);
  }
  if (reasons.length === 0) return null;

  return (
    `[notify] NOTIFY_BASE_URL will be refused by SSRF validation: ${reasons.join(" and ")}. ` +
    `Add the host to NOTIFY_TRUSTED_HOSTS to allow it; until then ntfy pushes are ` +
    `silently dropped. Note: trusting the host also lets the notify bearer token ` +
    `travel in cleartext when the URL scheme is http.`
  );
}

export function createNtfyNotificationHook(
  opts: NtfyNotificationHookOptions,
): NotificationHook {
  const base = trimTrailingSlashes(opts.baseUrl.trim());
  const trustedHosts = opts.trustedHosts ?? [];

  return {
    async notifyJobComplete(owner, taskId, summary) {
      if (base === "") return;

      let credentials: NotifyCredentials | undefined;
      try {
        credentials = await opts.store.get(owner);
      } catch {
        // A store read failure (corrupt file, wrong key) must not break the
        // job. Error text from the store never carries credential material.
        console.warn(`[notify] credential lookup failed for task ${taskId}`);
        return;
      }
      if (!credentials) return;

      try {
        await validatedFetch(
          `${base}/${encodeURIComponent(credentials.topic)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              "Content-Type": "text/plain",
              Title: `Job ${taskId}`,
            },
            body: summary,
          },
          {
            fetchFn: opts.fetchImpl,
            ...egressTrustOptions(trustedHosts),
            lookup: opts.lookup,
            mode: opts.mode,
          },
        );
      } catch (err) {
        // Best-effort: log a generic reason only. `err` may embed the request
        // URL/topic, but never the token; keep the message token-free anyway.
        const reason = err instanceof Error ? err.name : "unknown";
        console.warn(`[notify] push failed for task ${taskId}: ${reason}`);
      }
    },
  };
}
