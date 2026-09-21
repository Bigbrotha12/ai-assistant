import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector } from "undici";
import { URL } from "node:url";
import type { LookupAddress } from "node:dns";

/**
 * SSRF-safe outbound URL validation core.
 *
 * Every plugin outbound call — LLM endpoints and tool backends alike — must be
 * validated here before connecting. The checks are layered so a single allowed
 * hostname cannot be pivoted into the internal network:
 *
 *  1. Scheme — `https:` only in production; `http:` only in development/test.
 *     Any other scheme (`file:`, `ftp:`, `gopher:`, `ws:`, ...) is refused
 *     outright, regardless of mode or admin trust. An explicit `allowHttp:
 *     true` NEVER prevails in production — passing it in production throws.
 *  2. Address ranges — loopback, private, link-local, cloud-metadata,
 *     CGNAT, TEST-NET benchmarking, multicast, broadcast and reserved ranges
 *     (v4) plus IPv6 loopback/ULA/link-local/multicast, IPv4-mapped,
 *     6to4-with-unsafe-embedded-v4 and Teredo (v6) are refused at static
 *     validation when the URL carries a literal IP, and again after DNS
 *     resolution (see resolveAndValidateHost).
 *  3. Admin trust — an explicit, separate `trustedHosts` list (hostnames or
 *     literal IPs, with a leading `*.` prefix-wildcard) bypasses RANGE checks
 *     only. Scheme enforcement is never bypassed.
 *  4. DNS rebinding — resolveAndValidateHost resolves every A/AAAA record and
 *     validates each one; the returned IPs are meant to be pinned by the
 *     caller ("connect-to-validated-IP") so the connection never re-resolves
 *     to a different, disallowed address.
 *  5. Redirects — outbound callers MUST pass REDIRECT_POLICY (`redirect:
 *     "manual"`) and treat ANY 3xx response as failure (isRedirectStatus).
 *
 */

export type Mode = "production" | "development" | "test";

/**
 * The process mode, captured once at module load. A missing or unrecognized
 * NODE_ENV falls back to "development" to match `env.ts`. Production
 * deployments MUST set NODE_ENV=production; only then is `http:` refused.
 * Prefer passing an explicit `mode` option to the validation functions so
 * tests can control it.
 */
export const NODE_ENV: Mode = coerceMode(process.env.NODE_ENV);

function coerceMode(raw: string | undefined): Mode {
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

export type SsrfValidationErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "DISALLOWED_HOST"
  | "DNS_RESOLUTION_FAILED"
  | "DNS_REBINDING"
  | "REDIRECT_REFUSED";

export class SsrfValidationError extends Error {
  readonly code: SsrfValidationErrorCode;

  constructor(code: SsrfValidationErrorCode, message: string) {
    super(message);
    this.name = "SsrfValidationError";
    this.code = code;
  }
}

export function normalizeHostname(hostname: string): string {
  // Strip IPv6 brackets again defensively (WHATWG URL hostname already carries
  // them for IPv6 literals), a trailing FQDN dot, and normalize case.
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * Admin-trusted hostname matching. A trusted entry either matches the hostname
 * exactly, or starts with a single leading wildcard (`*.internal`) matching
 * the bare suffix and any depth of subdomains. Bare `"*"`, empty patterns and
 * mid-string wildcards are REFUSED (never match) so the list cannot be abused
 * into a trust-everything setting. Matching is case-insensitive and applies to
 * literal IPs in the list too (admin opts into specific addresses as well).
 */
export function isTrustedHost(hostname: string, trustedHosts: readonly string[]): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "") return false;
  for (const pattern of trustedHosts) {
    const candidate = normalizeHostname(pattern);
    if (candidate === "") continue;
    if (candidate === "*") continue;
    if (candidate.startsWith("*.")) {
      const suffix = candidate.slice(2);
      if (suffix === "") continue;
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) return true;
    } else if (!candidate.includes("*") && normalized === candidate) {
      return true;
    }
  }
  return false;
}

function ipv4Octets(ip: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * True when the address falls in a rejected range. All blocked IPv4 ranges are
 * prefix ranges within /16, so only the two leading octets are needed:
 * every range below covers 0.0.0.0/8 (this-network), 10.0.0.0/8 (private),
 * 100.64.0.0/10 (CGNAT, RFC 6598), 127.0.0.0/8 (loopback),
 * 169.254.0.0/16 (link-local, incl. 169.254.169.254 cloud metadata),
 * 172.16.0.0/12 (private), 192.168.0.0/16 (private),
 * 198.18.0.0/15 (TEST-NET-2 benchmarking, unsafe for outbound),
 * 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved, incl. 255.255.255.255
 * broadcast).
 */
function isUnsafeIpv4Prefix(a: number, b: number): boolean {
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function ipv4ToHextets(part: string): [number, number] | null {
  const octets = ipv4Octets(part);
  if (!octets) return null;
  const [a, b, c, d] = octets;
  return [((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff];
}

/**
 * Expands an IPv6 literal (handling `::` compression and an embedded IPv4
 * tail) into its canonical 16 bytes, or null when malformed. Zone ids are
 * rejected.
 */
function ipv6ToBytes(address: string): number[] | null {
  if (address.includes("%")) return null;
  const hex = address.toLowerCase();
  const doubleColon = hex.indexOf("::");
  let head = hex;
  let tail = "";
  if (doubleColon !== -1) {
    head = hex.slice(0, doubleColon);
    tail = hex.slice(doubleColon + 2);
    if (head.includes("::") || tail.includes("::")) return null;
  }

  const parseParts = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (i === groups.length - 1) {
        const embedded = ipv4ToHextets(group);
        if (embedded) {
          out.push(embedded[0], embedded[1]);
          continue;
        }
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const headGroups = parseParts(head);
  const tailGroups = parseParts(tail);
  if (headGroups === null || tailGroups === null) return null;
  if (headGroups.length + tailGroups.length > 8) return null;

  const groups: number[] = [];
  groups.push(...headGroups);
  while (groups.length + tailGroups.length < 8) groups.push(0);
  groups.push(...tailGroups);
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >>> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/**
 * True when the expanded IPv6 bytes fall in a rejected range: unspecified
 * `::`, loopback `::1`, IPv4-mapped `::ffff:a.b.c.d` and legacy IPv4-compatible
 * `::a.b.c.d` (normalized to the embedded v4 before checking), 6to4 `2002::/16`
 * when the embedded v4 (bytes 2-5) is itself unsafe, Teredo `2001::/32`,
 * ULA `fc00::/7`, link-local `fe80::/10` and multicast `ff00::/8`. Global
 * unicast passes.
 */
function isUnsafeIpv6(bytes: number[]): boolean {
  if (bytes.every((byte) => byte === 0)) return true;
  if (
    bytes.slice(0, 15).every((byte) => byte === 0) &&
    bytes[15] === 1
  ) {
    return true;
  }
  const first80Zero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (first80Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isUnsafeIpv4Prefix(bytes[12]!, bytes[13]!);
  }
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return isUnsafeIpv4Prefix(bytes[12]!, bytes[13]!);
  }
  // 6to4 (2002::/16) embeds a 32-bit v4 address in bytes 2-5; validate it as a
  // normal v4 so a 6to4 address can't tunnel into a blocked range.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isUnsafeIpv4Prefix(bytes[2]!, bytes[3]!);
  }
  // Teredo (2001:0000::/32) — tunneling primitive with no legitimate outbound
  // use; refuse outright.
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return true;
  }
  if (bytes[0] === 0xfc || bytes[0] === 0xfd) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

/**
 * Checks a literal IP against the rejected ranges. Returns true when allowed
 * (or when the IP is listed in `trustedHosts`). Hostnames are NOT literal IPs:
 * this function returns true for them because no static range decision can be
 * made — route those through resolveAndValidateHost, which validates every
 * resolved record.
 */
export function isIpAllowed(
  ip: string,
  opts: { trustedHosts?: readonly string[] } = {},
): boolean {
  const normalized = normalizeHostname(ip);
  if (isTrustedHost(normalized, opts.trustedHosts ?? [])) return true;

  const family = isIP(normalized);
  if (family === 4) {
    const octets = ipv4Octets(normalized);
    // Fail closed: an unparseable v4 literal is treated as disallowed.
    return octets !== null && !isUnsafeIpv4Prefix(octets[0]!, octets[1]!);
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(normalized);
    // Fail closed: an unparseable v6 literal is treated as disallowed.
    return bytes !== null && !isUnsafeIpv6(bytes);
  }
  return true;
}

export type UrlValidateOptions = {
  /** Overrides NODE_ENV. In "production" http: is refused. */
  mode?: Mode;
  /** Explicit scheme override; defaults to `mode !== "production"`. */
  allowHttp?: boolean;
  /** Admin-trusted hostnames/IPs that bypass range checks (never scheme). */
  trustedHosts?: readonly string[];
  /**
   * Admin-vouched hostnames/IPs permitted to use http: in production. Unlike
   * `allowHttp` this is a per-host allowlist — the ONLY production http:
   * carve-out (used for in-cluster MCP servers, which are plain http). Hosts
   * not listed stay https-only; DNS-rebinding and redirect defenses still
   * apply. `allowHttp: true` remains forbidden in production regardless.
   */
  httpAllowedHosts?: readonly string[];
};

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new SsrfValidationError("INVALID_URL", `malformed URL: ${url}`);
  }
}

/**
 * Validates a URL string against every STATIC rule: scheme, hostname validity,
 * and — for literal IPs — the rejected ranges. Does NOT resolve DNS, and does
 * not validate hostnames that require a lookup (those are checked per-record
 * at connect time via resolveAndValidateHost). Used for plugin allowlist
 * entries at load time.
 *
 * Range rejection is independent of scheme: a private literal IP is rejected
 * in dev too, unless it is admin-trusted. http/https is a separate check.
 *
 * Production scheme enforcement is absolute: passing `allowHttp: true` while
 * the effective mode is `"production"` throws (fail-closed) even for an
 * https: URL — a production build that wants http: is misconfigured and must
 * not silently win. A missing NODE_ENV defaults to development, which is why
 * production deployments must set it explicitly.
 */
export function validateStaticUrl(url: string, opts: UrlValidateOptions = {}): URL {
  const parsed = parseUrl(url);

  const mode = opts.mode ?? NODE_ENV;
  const allowHttp = opts.allowHttp ?? mode !== "production";

  if (mode === "production" && allowHttp) {
    throw new SsrfValidationError(
      "UNSUPPORTED_SCHEME",
      "allowHttp: true is not permitted when mode is 'production'; " +
        "http: must never be allowed in production",
    );
  }

  if (parsed.protocol === "https:") {
    // Always allowed.
  } else if (parsed.protocol === "http:") {
    if (!allowHttp) {
      if (!isTrustedHost(normalizeHostname(parsed.hostname), opts.httpAllowedHosts ?? [])) {
        throw new SsrfValidationError(
          "UNSUPPORTED_SCHEME",
          `http: is not allowed in production (${url}); use https: or add the host to ` +
            `httpAllowedHosts (MCP_TRUSTED_HOSTS)`,
        );
      }
    }
  } else {
    throw new SsrfValidationError(
      "UNSUPPORTED_SCHEME",
      `scheme ${parsed.protocol} is not allowed (${url}); only http: (non-production) and https:`,
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === "") {
    throw new SsrfValidationError("INVALID_URL", `URL has no hostname: ${url}`);
  }

  const family = isIP(hostname);
  if (family !== 0 && !isIpAllowed(hostname, { trustedHosts: opts.trustedHosts })) {
    throw new SsrfValidationError(
      "DISALLOWED_HOST",
      `${hostname} is in a disallowed/private network range`,
    );
  }

  return parsed;
}

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const defaultLookup: LookupFn = (hostname, options) => lookup(hostname, options);

function buildPinnedLookup(expectedHost: string, pinned: readonly string[]): LookupFunction {
  const records = pinned.map((address) => ({ address, family: isIP(address) }));
  return (hostname, options, callback) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const matches = records.filter((record) => !family || record.family === family);
    if (normalizeHostname(hostname) !== expectedHost || matches.length === 0) {
      callback(new SsrfValidationError("DNS_RESOLUTION_FAILED", "no validated address for connection"), "");
      return;
    }
    if (options.all) {
      callback(null, matches.map((record) => ({ ...record })));
    } else {
      callback(null, matches[0]!.address, matches[0]!.family);
    }
  };
}

export type ResolveOptions = {
  trustedHosts?: readonly string[];
  /** Injectable A/AAAA resolver; defaults to node:dns/promises lookup. */
  lookup?: LookupFn;
};

/**
 * Resolves a hostname, validates EVERY A/AAAA record (DNS-rebinding defense),
 * and returns the validated IP addresses for connect-pinning. Literal IPs
 * bypass DNS entirely. This function never connects; the caller connects to
 * one of the returned IPs so the connection is pinned to a validated address.
 *
 * Admin trust applies at the HOSTNAME level: if the host is explicitly
 * trusted (e.g. `vikunja.local` behind `*.local`), its resolved records are
 * accepted — the admin vouched for the name. Untrusted hostnames must pass the
 * range check per record; a public name resolving to 169.254.169.254, a
 * loopback, or a private address throws DNS_REBINDING.
 */
export async function resolveAndValidateHost(
  hostname: string,
  opts: ResolveOptions = {},
): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  const trustedHosts = opts.trustedHosts ?? [];

  if (normalized === "") {
    throw new SsrfValidationError("INVALID_URL", "empty hostname");
  }

  const family = isIP(normalized);
  if (family !== 0) {
    if (!isIpAllowed(normalized, { trustedHosts })) {
      throw new SsrfValidationError(
        "DISALLOWED_HOST",
        `${normalized} is in a disallowed/private network range`,
      );
    }
    return [normalized];
  }

  const lookupFn = opts.lookup ?? defaultLookup;
  let resolved: readonly LookupAddress[];
  try {
    resolved = await lookupFn(normalized, { all: true, verbatim: true });
  } catch {
    throw new SsrfValidationError(
      "DNS_RESOLUTION_FAILED",
      `could not resolve host ${normalized}`,
    );
  }

  const hostTrusted = isTrustedHost(normalized, trustedHosts);
  const pinned: string[] = [];
  for (const record of resolved) {
    const family = isIP(record.address);
    if (family === 0 || family !== record.family) {
      throw new SsrfValidationError(
        "DNS_RESOLUTION_FAILED",
        `${normalized} resolved to an invalid address record`,
      );
    }
    if (!hostTrusted && !isIpAllowed(record.address, { trustedHosts })) {
      throw new SsrfValidationError(
        "DNS_REBINDING",
        `${normalized} resolved to disallowed address ${record.address}`,
      );
    }
    if (!pinned.includes(record.address)) pinned.push(record.address);
  }
  if (pinned.length === 0) {
    throw new SsrfValidationError(
      "DNS_RESOLUTION_FAILED",
      `${normalized} resolved to no usable addresses`,
    );
  }
  return pinned;
}

/**
 * Redirect policy for every outbound plugin/LLM call (Phase 2/3). Callers MUST
 * spread this into fetch() and treat ANY 3xx as a failure (it could be a
 * redirect to a disallowed internal URL that static validation no longer
 * covers). Centralized here so the policy cannot drift.
 */
export const REDIRECT_POLICY = { redirect: "manual" } as const;

/** True for any 3xx redirect status. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export const HEADER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
export const DANGEROUS_HEADERS = new Set([
  'content-type', 'accept', 'host', 'transfer-encoding', 'connection', 'cookie', 'set-cookie',
]);

export function validateMcpHeaderName(name: string): void {
  if (!HEADER_NAME_RE.test(name)) throw new SsrfValidationError("INVALID_URL", `MCP header name '${name}' contains invalid characters`);
  if (DANGEROUS_HEADERS.has(name.toLowerCase())) throw new SsrfValidationError("INVALID_URL", `MCP header name '${name}' is a reserved/dangerous header`);
}

/**
 * Hostname shape an entry may take: one or more RFC-style DNS labels separated
 * by dots, optionally prefixed with a single `*.` wildcard. Rejects uppercase
 * IRIs quirks, underscores, bare `*`, mid-string wildcards, leading/trailing
 * hyphens, empty labels and trailing dots. Case-insensitive.
 */
const TRUSTED_HOST_ENTRY = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * True when a candidate `PLUGINS_TRUSTED_HOSTS` entry is well-formed: an exact
 * hostname (`vn.example`, `vikunja.local`), an IP literal (v4/v6), or a
 * single-`*.`-prefix wildcard (`*.internal`). Refused: bare `*`, mid-string
 * wildcards, anything carrying a scheme (`://`), port (`:`), path (`/`) or
 * whitespace. Generation of `parseTrustedHosts`; kept separate so env parsing
 * and callers can validate a single entry.
 */
export function isValidTrustedHostEntry(entry: string): boolean {
  if (entry === "") return false;
  if (entry.includes("://")) return false;
  if (isIP(entry) !== 0) return true;
  return TRUSTED_HOST_ENTRY.test(entry);
}

/**
 * Parse the raw comma-separated `PLUGINS_TRUSTED_HOSTS` env value into
 * validated entries (trimmed, empties dropped). Throws `SsrfValidationError`
 * on the first invalid entry so the app can fail fast at env parse time with
 * an actionable message. Prefer `parseTrustedHostEntries` when the value has
 * already been split (e.g. after a zod transform).
 */
export function parseTrustedHosts(raw: string): string[] {
  return parseTrustedHostEntries(raw.split(","));
}

/**
 * Validate an already-split list of trusted-host entries. See
 * `parseTrustedHosts`. Throws `SsrfValidationError` on the first invalid
 * entry.
 */
export function parseTrustedHostEntries(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    if (!isValidTrustedHostEntry(entry)) {
      throw new SsrfValidationError(
        "INVALID_URL",
        `invalid PLUGINS_TRUSTED_HOSTS entry '${entry}': entries must be an exact ` +
          `hostname (vn.example), an IP literal (v4/v6), or a single-'*.'-prefixed ` +
          `wildcard (*.internal); schemes (://), ports, paths, whitespace and bare ` +
          `'*' are refused`,
      );
    }
    out.push(entry);
  }
  return out;
}

export type ValidatedFetchOptions = {
  /** Overrides NODE_ENV for scheme enforcement. In production http: is refused. */
  mode?: Mode;
  /**
   * Explicit scheme override. NEVER effective in production — see
   * `validateStaticUrl` (fail-closed on `allowHttp: true` + production).
   */
  allowHttp?: boolean;
  /** Admin-trusted hostnames/IPs that bypass range checks (never scheme). */
  trustedHosts?: readonly string[];
  /** Per-host production http: carve-out (see `UrlValidateOptions`). */
  httpAllowedHosts?: readonly string[];
  /** Injectable A/AAAA resolver; defaults to node:dns/promises lookup. */
  lookup?: LookupFn;
  fetchFn?: typeof fetch;
};

/**
 * Builds the SSRF-pinned undici Agent: it connects only to the resolved-and-
 * validated IP for the exact host/scheme/port and refuses any other destination
 * (DNS-rebinding + redirect defense). One agent per outbound call; callers
 * that hold a long-lived stream (MCP SSE) keep it open and destroy it on
 * dispose instead of closing immediately.
 */
export function buildPinnedAgent(
  hostname: string,
  parsed: URL,
  pinned: readonly string[],
): Agent {
  const connect = buildConnector({
    lookup: buildPinnedLookup(hostname, pinned),
    rejectUnauthorized: true,
    autoSelectFamily: true,
  });
  return new Agent({
    connect(options, callback) {
      if (
        normalizeHostname(options.hostname) !== hostname ||
        options.protocol !== parsed.protocol ||
        Number(options.port || (options.protocol === "https:" ? 443 : 80)) !==
          Number(parsed.port || (options.protocol === "https:" ? 443 : 80)) ||
        options.httpSocket
      ) {
        callback(new SsrfValidationError("DISALLOWED_HOST", "unexpected connection destination"), null);
        return;
      }
      connect({ ...options, servername: isIP(hostname) ? undefined : parsed.hostname }, callback);
    },
  });
}

export async function validatedFetch(
  url: string,
  init: RequestInit = {},
  opts: ValidatedFetchOptions = {},
): Promise<Response> {
  const mode = opts.mode ?? NODE_ENV;
  const allowHttp = opts.allowHttp ?? mode !== "production";

  const parsed = validateStaticUrl(url, {
    mode,
    allowHttp,
    trustedHosts: opts.trustedHosts,
    httpAllowedHosts: opts.httpAllowedHosts,
  });
  const pinned = await resolveAndValidateHost(normalizeHostname(parsed.hostname), {
    trustedHosts: opts.trustedHosts,
    lookup: opts.lookup,
  });

  const hostname = normalizeHostname(parsed.hostname);
  const agent = buildPinnedAgent(hostname, parsed, pinned);
  try {
    const fetchFn = opts.fetchFn ?? globalThis.fetch;
    const requestInit = { ...init, redirect: "manual" as const, dispatcher: agent };
    const response = await fetchFn(url, requestInit as unknown as RequestInit);
    if (isRedirectStatus(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw new SsrfValidationError(
        "REDIRECT_REFUSED",
        `redirect (${response.status}) refused for ${parsed.hostname}; outbound plugin/LLM ` +
          "calls never follow redirects",
      );
    }
    void agent.close().catch(() => agent.destroy()).catch(() => {});
    return response;
  } catch (error) {
    await agent.destroy().catch(() => {});
    throw error;
  }
}
