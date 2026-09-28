import { canRetryTool } from "../../credentials/idempotency.ts";
import { boundToolResult } from "../../tool_bounds.ts";
import type { ToolCacheKey, ToolResultCache } from "../../middleware/cache.ts";
import type { ToolDispatch, ToolInterceptor } from "../pipeline.ts";

/**
 * `cache` interceptor — read-only result cache around the bounded body.
 *
 * Pre: a keyed `get` short-circuits with the stored result, setting `content`
 * and `fromCache`; the served value goes through `boundToolResult` (redact +
 * default-cap truncate) exactly like the production cache hit (`runner.ts:968`).
 * Post: `await next()` then `set` only when the body actually ran
 * (`dispatch.executed`) — an inner short-circuit must not be cached. The value
 * stored is `boundToolResult(dispatch.content)`, matching production's
 * "store the bounded/redacted result" behaviour (`runner.ts:980-982`).
 *
 * The bound applied here uses the DEFAULT cap, so the stored value is at most
 * `DEFAULT_TOOL_RESULT_MAX_CHARS`. The cache's own `maxValueChars` is
 * independently configurable and may be SMALLER than that default, in which
 * case `set` still drops the (already-bounded) value — this interceptor does
 * not thread the cap through, so "oversized values are never dropped" is not a
 * guarantee at non-default cache settings.
 *
 * The interceptor restores the deleted `withToolResultCache` prologue: the
 * channel signal is checked for an abort BEFORE the lookup, so a read-only
 * cache hit is never served (or audited `ok`) on an already-cancelled request.
 * The job channel's `fence` already asserts the signal inactive first, so this
 * is a no-op belt-and-braces there.
 *
 * Anonymous JOB calls bypass the cache entirely. Production's anonymous branch
 * (`runner.ts:931-935`) does `return await execute()` — skipping both the
 * ledger and the cache; a cache hit would be a behaviour change outside D1–D8.
 * Sync/warmup anonymous calls are unaffected (they have no replay branch).
 *
 * The cache key's `credentialFingerprint` is read from
 * `call.credentialFingerprint`, which the CHANNEL computes with its own
 * derivation (warmup fingerprints `validateCredentials(...)`; sync fingerprints
 * the raw per-plugin body credentials; job prefers the pin fingerprint). This
 * interceptor deliberately does NOT unify those derivations (plan §10.1); when a
 * channel does not supply the fingerprint (or an owner/version), the call
 * executes directly and is not cached.
 *
 * Only read-only tools are cacheable, gated by `canRetryTool` — the same
 * predicate that guards checkpoint resume.
 */
export function createCacheInterceptor(opts: {
  cache?: ToolResultCache;
}): ToolInterceptor {
  const cache = opts.cache;
  return {
    name: "cache",
    async around(dispatch, next) {
      const call = dispatch.call;
      // Restore the pre-cache abort check (the deleted `withToolResultCache`
      // began with `signal?.throwIfAborted()`): a cache hit must not be served
      // to an already-cancelled request. `call.signal` is the channel signal
      // captured before any timeout controller exists, so this fires before the
      // lookup without being confused by a handler timeout.
      call.signal?.throwIfAborted();
      const anonymousJobCall =
        call.channel === "job" && call.toolCallId === undefined;
      const key =
        cache !== undefined && !anonymousJobCall && canRetryTool(call)
          ? cacheKeyFor(cache, dispatch)
          : undefined;
      if (cache !== undefined && key !== undefined) {
        const hit = cache.get(key);
        if (hit !== undefined) {
          // Redact + default-bound on serve: the cache never redacts internally.
          dispatch.content = boundToolResult(hit);
          dispatch.fromCache = true;
          return;
        }
      }
      await next();
      if (cache !== undefined && key !== undefined && dispatch.executed) {
        cache.set(key, boundToolResult(dispatch.content));
      }
    },
  };
}

/**
 * Builds the key from precomputed call fields. Returns undefined when a
 * required component is absent, which makes the call a cache skip (execute
 * directly, store nothing) rather than fabricating a unified fingerprint.
 */
function cacheKeyFor(
  cache: ToolResultCache,
  dispatch: ToolDispatch,
): ToolCacheKey | undefined {
  const call = dispatch.call;
  if (
    call.owner === undefined ||
    call.pluginVersion === undefined ||
    call.credentialFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    owner: call.owner,
    pluginId: call.pluginId,
    pluginVersion: call.pluginVersion,
    credentialFingerprint: call.credentialFingerprint,
    tool: call.tool,
    argsHash: cache.argsHash(call.args),
  };
}