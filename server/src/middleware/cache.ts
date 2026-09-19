import { createHash } from "node:crypto";

/**
 * In-memory tool-result cache (Phase 4, Wave B).
 *
 * A per-process LRU+TLL cache keyed by
 * `(owner, pluginId, pluginVersion, credentialFingerprint, tool, argsHash)`
 * that wraps the REAL tool handlers of BOTH the sync transport and the
 * background job runner, so a repeated read-only tool call — the same user,
 * plugin, plugin version, credential set, tool, and arguments — is served
 * without re-executing the backend. It is a DIFFERENT layer from the persisted
 * per-task ledger replay dedupe (`hasToolResult`/`recordToolResult` in
 * `credentials/idempotency.ts`): the ledger dedupe protects checkpoints by
 * tool-call-id; this cache sits in FRONT of the outbound execution and is
 * scoped to (plugin, tool, args). Both stay wired — a warm cache never stops
 * a resume's replay dedupe from being authoritative.
 *
 * CONSTRAINTS:
 *   - Only READ-ONLY (`readOnly: true`) tools may be cached. The gate is the
 *     CALLER's responsibility (the cache never sees the tool definition); it
 *     uses `canRetryTool` (`credentials/idempotency.ts`), the same predicate
 *     that guards checkpoint resume. Mutating tools always execute.
 *   - The cache STORES the raw handler output and NEVER redacts internally.
 *     Callers apply `redactForCheckpoint` at serve time (on hits AND misses),
 *     so a credential-shaped backend response can never be served raw.
 *   - The key's `credentialFingerprint` comes from the same
 *     `credentialFingerprint()` used for pin identities — never a derivation
 *     and never the raw credential values. Absent credentials fingerprint as
 *     the empty set, so an unkeyed read-only backend still dedupes.
 *   - The cache is the tolerant fast path: a resolution failure (plugin no
 *     longer installed, unknown tool) is a skipped-cache MISS, never a throw.
 *
 * TTL is insertion-based: an entry expires `ttlMs` after `set`, whether or not
 * it is read (a `get` refreshes LRU recency only). Expired entries are dropped
 * lazily on read and by a periodic sweep (interval = `ttlMs`).
 *
 * Single-instance only — state is in-memory and does not survive restarts
 * (same constraint as the token bucket, the budget, and the pin store).
 * `index.ts` constructs ONE instance and shares it between the sync transport
 * and the job runner.
 */
export type ToolCacheKey = {
  /** Owner/referenceId whose request produced the cached result. */
  owner: string;
  /** Tool-plugin id. */
  pluginId: string;
  /** The plugin's version at call time (registry value). */
  pluginVersion: string;
  /** `credentialFingerprint()` of the validated credentials, never the values. */
  credentialFingerprint: string;
  /** Tool name within the plugin. */
  tool: string;
  /** Deterministic hash of the decoded tool arguments. */
  argsHash: string;
};

export type ToolResultCache = {
  /**
   * Cached result for `key`, or undefined on a miss. Lifespan-limited reads:
   * an entry past its TTL is discarded and reported as a miss. A hit refreshes
   * LRU recency (not the TTL). Returns the RAW stored string — the caller
   * redacts before serving.
   */
  get(key: ToolCacheKey): string | undefined;
  /** Store the RAW handler output under `key`. LRU-evicts when at capacity. */
  set(key: ToolCacheKey, result: string): void;
  /**
   * Deterministic, order-independent hash of decoded tool arguments: key-sorted
   * JSON of the canonicalized value, then sha256 hex.
   */
  argsHash(args: Record<string, unknown>): string;
  /** Drop every entry for one owner (e.g. after credential rotation). */
  invalidateForUser(owner: string): void;
  /** Live entry count (tests + diagnostics). */
  size: number;
  /** Stops the periodic sweep. No-op after the first call. */
  dispose(): void;
};

export type CreateToolResultCacheOptions = {
  /** Entry lifetime; default 5 minutes. Fixes the periodic sweep interval. */
  ttlMs?: number;
  /** LRU capacity; default 1000 entries. */
  maxEntries?: number;
  /** Injectable monotonic clock; defaults to Date.now. */
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export const DEFAULT_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_TOOL_CACHE_MAX_ENTRIES = 1000;

type Entry = {
  key: ToolCacheKey;
  /** RAW handler output — never redacted here; the caller redacts at serve. */
  result: string;
  /** Monotonic clock time of `set`; the TTL is insertion-based. */
  insertedAt: number;
};

/** Internal Map key: \u0000-joined key parts (all parts are NUL-safe). */
function internalKey(key: ToolCacheKey): string {
  return [
    key.owner,
    key.pluginId,
    key.pluginVersion,
    key.credentialFingerprint,
    key.tool,
    key.argsHash,
  ].join("\u0000");
}

/**
 * Recursively canonicalize a tool-args value so JSON.stringify output is
 * independent of object key order: arrays map part-by-part, plain objects sort
 * their keys, scalars pass through (strings/numbers/booleans/null).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function createToolResultCache(
  opts: CreateToolResultCacheOptions = {},
): ToolResultCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TOOL_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_TOOL_CACHE_MAX_ENTRIES;
  if (!(ttlMs > 0)) {
    throw new Error(
      `createToolResultCache: ttlMs must be a positive number, got ${ttlMs}`,
    );
  }
  if (!(maxEntries > 0)) {
    throw new Error(
      `createToolResultCache: maxEntries must be a positive number, got ${maxEntries}`,
    );
  }
  const now = opts.now ?? Date.now;
  // Insertion order IS the LRU order: every hit re-inserts (delete + set).
  const entries = new Map<string, Entry>();
  let disposed = false;

  const sweep = (): void => {
    const t = now();
    for (const [, entry] of entries) {
      if (t - entry.insertedAt >= ttlMs) entries.delete(internalKey(entry.key));
    }
  };

  const setInterval = opts.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearInterval =
    opts.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.warn("[cache] tool-result sweep failed:", err);
    }
  }, ttlMs);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  return {
    get(key) {
      const k = internalKey(key);
      const entry = entries.get(k);
      if (!entry) return undefined;
      if (now() - entry.insertedAt >= ttlMs) {
        entries.delete(k);
        return undefined;
      }
      // Refresh MRU recency without touching the insertion TTL.
      entries.delete(k);
      entries.set(k, entry);
      return entry.result;
    },

    set(key, result) {
      entries.set(internalKey(key), {
        key,
        result,
        insertedAt: now(),
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    argsHash(args) {
      const serialized = JSON.stringify(canonicalize(args));
      return createHash("sha256").update(serialized, "utf8").digest("hex");
    },

    invalidateForUser(owner) {
      for (const [k, entry] of entries) {
        if (entry.key.owner === owner) entries.delete(k);
      }
    },

    get size() {
      return entries.size;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(sweepTimer);
    },
  };
}