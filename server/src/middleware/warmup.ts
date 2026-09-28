import type { ToolCallHandler } from "../agents/orchestrator.ts";
import { canRetryTool } from "../credentials/idempotency.ts";
import { credentialFingerprint, validateCredentials } from "../plugins/credential.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import { BudgetExhaustedError, type BudgetManager } from "./budget.ts";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  serializeBoundedToolArguments,
} from "../tool_bounds.ts";
import type { ToolCacheKey, ToolResultCache } from "./cache.ts";
import type { ToolCall } from "../tools/pipeline.ts";
import { createToolPipeline } from "../tools/pipeline.ts";
import { makePluginBodies } from "../tools/bind.ts";
import { createSyncToolInterceptors } from "../tools/interceptors/order.ts";

export type WarmupCall = {
  owner: string;
  pluginId: string;
  tool: string;
  args: Record<string, unknown>;
  credentials?: Record<string, string>;
};

export type WarmupContext = {
  owner: string;
  signal: AbortSignal;
  beforeModelCall: () => void;
};

export type WarmupOutcome =
  | { status: "warmed" | "cached" | "cancelled" | "timed_out" | "failed" }
  | { status: "budget_exhausted"; retryAfterSeconds: number };

export type WarmupAdmission =
  | { ok: true; done: Promise<WarmupOutcome> }
  | { ok: false; reason: "disabled" | "disposed" | "busy" | "not_read_only" | "invalid_credentials" | "invalid_request" };

export type WarmupManager = {
  schedule(call: WarmupCall): WarmupAdmission;
  readonly activeCount: number;
  dispose(): void;
};

export type WarmupOptions = {
  enabled?: boolean;
  maxConcurrent?: number;
  timeoutMs?: number;
  registry: Pick<PluginRegistry, "requirePlugin">;
  cache: ToolResultCache;
  budget: BudgetManager;
  createHandler: (context: WarmupContext) => ToolCallHandler;
};

export const DEFAULT_WARMUP_MAX_CONCURRENT = 2;
export const DEFAULT_WARMUP_TIMEOUT_MS = 10_000;

/**
 * Warmup — the proactive, best-effort pre-execution channel (plan §5, task 1.12).
 *
 * Admission stays here: the disabled/disposed/global-concurrency gates, the
 * read-only + credential validation, the args re-serialization, the
 * pre-existing cache probe, the duplicate-in-flight check, and the
 * `reserveSync` slot reservation. What this manager no longer owns is the
 * execution stack: the dispatched call runs through the shared `ToolPipeline`
 * with `channel: "warmup"` and the sync interceptor set
 * (`serialize → cache → budget → execution`).
 *
 * Divergences preserved deliberately:
 *   - `timeoutMs` (default 10 s) rides `ToolCall.timeoutMs` and bounds the
 *     pipeline's `execution` interceptor; the `ToolExecutor` handed in by the
 *     composition root keeps its own env-derived guard. Warmup is explicitly
 *     out of D3's scope.
 *   - The credential fingerprint is derived from
 *     `validateCredentials(...)`-canonicalised credentials (plan §10.1),
 *     unlike the sync (raw body) and job (pin-preferred) channels.
 *   - No `plugin.tool` audit is emitted (D6): the pipeline is constructed
 *     WITHOUT an `onResult` sink, so the intent is explicit rather than relying
 *     on `createPluginAuditSink` skipping the channel.
 *   - `handlerSettled`/`releaseAfterHandler`: `cleanup()` (which releases the
 *     `reserveSync` slot and clears the in-flight entry) runs as soon as the
 *     dispatch settles, UNLESS the raw handler promise is still pending — in
 *     which case it is deferred until that promise settles. A handler that
 *     ignores abort must not free its slot early.
 */
export function createWarmupManager(opts: WarmupOptions): WarmupManager {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_WARMUP_MAX_CONCURRENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
  for (const [name, value] of Object.entries({ maxConcurrent, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`createWarmupManager: ${name} must be a positive bounded integer`);
    }
  }
  // One shared pipeline per manager. The interceptors close over the
  // manager's budget/cache; every per-call value rides `ToolCall`/`ToolCallScope`
  // (plan §4.1/§4.2). Deliberately no `onResult` sink — warmup emits no audit (D6).
  const pipeline = createToolPipeline({
    interceptors: createSyncToolInterceptors({
      budget: opts.budget,
      cache: opts.cache,
    }),
  });
  const running = new Map<string, AbortController>();
  let disposed = false;

  return {
    schedule(call) {
      if (disposed) return { ok: false, reason: "disposed" };
      if (!opts.enabled) return { ok: false, reason: "disabled" };
      if (!call.owner.trim()) return { ok: false, reason: "invalid_request" };
      if (running.size >= maxConcurrent) return { ok: false, reason: "busy" };
      let plugin;
      try {
        plugin = opts.registry.requirePlugin(call.pluginId);
      } catch {
        return { ok: false, reason: "not_read_only" };
      }
      if (!isToolPlugin(plugin)) return { ok: false, reason: "not_read_only" };
      const tool = plugin.tools.find((candidate) => candidate.name === call.tool);
      if (!tool || !canRetryTool(tool)) return { ok: false, reason: "not_read_only" };
      let credentials: Record<string, string>;
      try {
        credentials = validateCredentials(plugin.credentials, call.credentials ?? {}, plugin.id);
      } catch {
        return { ok: false, reason: "invalid_credentials" };
      }
      let args: Record<string, unknown>;
      let key: ToolCacheKey;
       try {
         const serializedArgs = serializeBoundedToolArguments(call.args);
         args = JSON.parse(serializedArgs) as Record<string, unknown>;
         if (!args || Array.isArray(args) || typeof args !== "object") {
          return { ok: false, reason: "invalid_request" };
        }
        key = {
          owner: call.owner,
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          credentialFingerprint: credentialFingerprint(credentials),
          tool: tool.name,
          argsHash: opts.cache.argsHash(args),
        };
      } catch {
        return { ok: false, reason: "invalid_request" };
      }
      if (opts.cache.get(key) !== undefined) {
        return { ok: true, done: Promise.resolve({ status: "cached" }) };
      }
      const id = JSON.stringify(key);
      if (running.has(id)) return { ok: false, reason: "busy" };
      const slot = opts.budget.reserveSync(key.owner);
      if (!slot.ok) return { ok: false, reason: "busy" };
      const controller = new AbortController();
      running.set(id, controller);
      let timedOut = false;
      let finish!: (outcome: WarmupOutcome) => void;
      const done = new Promise<WarmupOutcome>((resolve) => { finish = resolve; });
      const onAbort = () => finish({ status: timedOut ? "timed_out" : "cancelled" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timer.unref();
       const context: WarmupContext = {
         owner: key.owner,
         signal: controller.signal,
         beforeModelCall() {
           controller.signal.throwIfAborted();
           opts.budget.beforeModelCall(key.owner, "warmup");
         },
       };
       let released = false;
       let handlerSettled = true;
       let releaseAfterHandler: (() => void) | undefined;
       const cleanup = () => {
         if (released) return;
         released = true;
         clearTimeout(timer);
         controller.signal.removeEventListener("abort", onAbort);
         controller.abort();
         running.delete(id);
         slot.release();
       };
       void Promise.resolve().then(async (): Promise<WarmupOutcome> => {
        controller.signal.throwIfAborted();
        const current = opts.registry.requirePlugin(key.pluginId);
        if (!isToolPlugin(current) || current.version !== key.pluginVersion ||
            !current.tools.some((candidate) => candidate.name === key.tool && canRetryTool(candidate))) {
          return { status: "cancelled" };
        }
        const toolCall: ToolCall = {
          source: "plugin",
          pluginId: key.pluginId,
          pluginVersion: key.pluginVersion,
          tool: key.tool,
          args,
          readOnly: true,
          owner: key.owner,
          credentials,
          credentialFingerprint: key.credentialFingerprint,
          signal: controller.signal,
          channel: "warmup",
          actionId: id,
          timeoutMs,
          maxResultChars: DEFAULT_TOOL_RESULT_MAX_CHARS,
        };
        // The channel owns the raw-body promise (plan §4.2). `makePluginBodies`
        // builds the `plugin` body, the `rawSettled`/`onBodySkipped` pair the
        // `budget` interceptor reads, and the fail-loud `mcp` stub. The handler
        // is created inside `invoke`, i.e. only once every interceptor has
        // admitted the call — a cache hit or a budget rejection never builds it.
        const { bodies, scope } = makePluginBodies({
          invoke: (bodySignal) => {
            const handler = opts.createHandler(context);
            const handlerPromise = Promise.resolve().then(() =>
              handler.execute(key.pluginId, key.tool, args, credentials, bodySignal),
            );
            handlerSettled = false;
            void handlerPromise.then(
              () => {
                handlerSettled = true;
                releaseAfterHandler?.();
              },
              () => {
                handlerSettled = true;
                releaseAfterHandler?.();
              },
            );
            return handlerPromise;
          },
          channelLabel: "warmup",
        });
        await pipeline.dispatch({ call: toolCall, bodies, scope });
        controller.signal.throwIfAborted();
        return { status: "warmed" };
      }).catch((error: unknown): WarmupOutcome => {
        if (controller.signal.aborted) return { status: timedOut ? "timed_out" : "cancelled" };
        if (error instanceof BudgetExhaustedError) {
          return { status: "budget_exhausted", retryAfterSeconds: error.retryAfterSeconds };
        }
        return { status: "failed" };
       }).finally(() => {
         if (handlerSettled) cleanup();
         else releaseAfterHandler = cleanup;
       }).then(finish);
      return { ok: true, done };
    },
    get activeCount() {
      return running.size;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of running.values()) controller.abort();
    },
  };
}
