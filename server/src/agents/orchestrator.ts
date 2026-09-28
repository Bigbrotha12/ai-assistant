import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type {
  ToolDefinition,
  ToolPluginDefinition,
} from "../plugins/types.ts";
import { jsonSchemaToZod } from "./mcp.ts";
import {
  DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "../tool_bounds.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type { ToolResultCache } from "../middleware/cache.ts";
import { createToolPipeline } from "../tools/pipeline.ts";
import type { ToolCall, ToolPipeline } from "../tools/pipeline.ts";
import { makePluginBodies } from "../tools/bind.ts";
import { createSyncToolInterceptors } from "../tools/interceptors/order.ts";
import { createPluginAuditSink } from "../tools/audit.ts";

// Single source of truth for JSON-Schema -> zod translation lives in
// `agents/mcp.ts` (it also infers `type` for schema-less MCP tools). Re-export
// it here so the tool-binding path and the runner keep importing from one spot.
export { jsonSchemaToZod };

/**
 * Wiring layer (Phase 2 plan: `orchestrator.ts`): assembles a ready-to-run
 * supervisor agent from the plugin registry + an already-configured model.
 *
 * Tool plugins from the registry are translated into LangChain
 * `DynamicStructuredTool` instances whose `func` delegates to an injected
 * {@link ToolCallHandler}. The transport wires the real handler — the
 * {@link ToolExecutor} from `jobs/runner.ts` (validatedFetch + pinned IPs +
 * per-plugin credentials) for both the synchronous stream and background jobs.
 * Model plugins are NOT wired here: the transport selects the model from the
 * request and passes it in already configured.
 */

/**
 * Executes a tool call against a plugin's backend. The production
 * implementation is the `ToolExecutor` (validatedFetch + pinned IPs + trusted
 * hosts); tests substitute a recording fake. The optional `credentials`
 * parameter carries the per-plugin key the handler should forward.
 */
export interface ToolCallHandler {
  execute(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    credentials?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export type BindPluginToolsOptions = {
  owner?: string;
  requestId?: string;
  /** Effective handler timeout (`opts.toolTimeoutMs ?? env.TOOL_CALL_TIMEOUT_MS`). */
  timeoutMs?: number;
  maxResultChars?: number;
  /**
   * Which synchronous channel this binding serves. Required so a mis-wired
   * binding cannot silently masquerade as another channel (the shared audit sink
   * keys off it).
   */
  channel: "sync-stateless" | "sync-managed";
  /**
   * Per-plugin credentials collected from the request body. The binding threads
   * the call's own credentials through `ToolCall.credentials`; the transport no
   * longer substitutes them (`withToolResultCache` is gone).
   */
  credentialsByPlugin?: Record<string, Record<string, string>>;
  budget?: BudgetManager;
  cache?: ToolResultCache;
  /**
   * Channel signal, captured BEFORE any timeout controller exists; the
   * `execution` interceptor composes its own on top via `next(signal)`.
   */
  signal?: AbortSignal;
  /**
   * Channel-owned tracked execution. The sync `StreamExecution.track` becomes
   * `ToolCallScope.track`, so `settle()` still drains in-flight tool calls.
   */
  track?: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * Pre-dispatch guard, invoked before any policy runs and again after the
   * handler resolves. The sync transport uses it for the account-deletion
   * tombstone: a turn whose owner is being deleted must neither serve a cache
   * hit nor cache a freshly produced result.
   */
  assertActive?: () => void;
};

/**
 * Translate installed tool plugins into LangChain tools. Exported for tests.
 *
 * The whole sync-channel policy lives in the shared `ToolPipeline`: this
 * function only assembles the binding layer — the duplicate-name gate, the
 * per-binding anonymous-sequence counter, and the per-call `ToolCall` +
 * `ToolCallScope` — and dispatches. The interceptor set
 * (`serialize → cache → budget → execution`, built by `createSyncToolInterceptors`)
 * reproduces the previous inline body:
 *   - `serialize` bounds and measures the args;
 *   - `cache` serves/stores read-only results;
 *   - `budget` gates per owner+plugin and quarantines an unsettled raw body —
 *     now INSIDE the sync channel too (plan D7);
 *   - `execution` bounds the handler with the effective timeout, propagates the
 *     abort signal, and tracks the call with the channel's `StreamExecution`;
 *   - `onResult` emits the `plugin.tool` audit the per-call `finally` used to.
 */
export function bindPluginTools(
  registry: PluginRegistry,
  toolHandler: ToolCallHandler,
  enabledPlugins: readonly string[] | undefined,
  options: BindPluginToolsOptions,
): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  const enabled = enabledPlugins === undefined ? null : new Set(enabledPlugins);
  let anonymousToolSequence = 0;
  // One pipeline per binding: `createSyncToolInterceptors` closes over this
  // stream's budget/cache, while every per-call value rides
  // `ToolCall`/`ToolCallScope` (plan §4.1/§4.2).
  const pipeline = createToolPipeline({
    interceptors: createSyncToolInterceptors({
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    }),
    onResult: createPluginAuditSink(),
  });
  for (const plugin of registry.listInstalledPlugins()) {
    if (!isToolPlugin(plugin)) continue;
    if (enabled !== null && !enabled.has(plugin.id)) continue;
    for (const toolDef of plugin.tools) {
      if (seen.has(toolDef.name)) {
        console.warn(
          `[agents] skipping duplicate tool '${toolDef.name}' from plugin '${plugin.id}'`,
        );
        continue;
      }
      seen.add(toolDef.name);
      tools.push(
        bindPluginTool(
          pipeline,
          plugin,
          toolDef,
          toolHandler,
          options,
          () => ++anonymousToolSequence,
        ),
      );
    }
  }
  return tools;
}

function bindPluginTool(
  pipeline: ToolPipeline,
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  toolHandler: ToolCallHandler,
  options: BindPluginToolsOptions,
  nextAnonymousToolSequence: () => number,
): DynamicStructuredTool {
  // Sync fingerprints the raw per-plugin request credentials (plan §10.1);
  // this derivation is deliberately NOT unified with warmup/job.
  const credentials = options.credentialsByPlugin?.[plugin.id];
  const fingerprint = credentialFingerprint(credentials ?? {});
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (args, _runManager, config) => {
      const pluginId = plugin.id;
      const toolName = toolDef.name;
      const callArgs = args as Record<string, unknown>;
      // Account-deletion tombstone: reject before any policy runs. A cache hit
      // must not be served to a deleting owner (mirrors the old
      // `withToolResultCache` pre-check).
      options.assertActive?.();
      // The channel signal is the composition of the stream's own signal and the
      // LangChain run signal, captured before any timeout controller exists; the
      // `execution` interceptor composes its timeout on top via next(signal).
      const configSignal = (config as { signal?: AbortSignal } | undefined)?.signal;
      const signal = options.signal && configSignal
        ? AbortSignal.any([options.signal, configSignal])
        : options.signal ?? configSignal;
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      // The anonymous sequence counter belongs to the binding layer; it is only
      // consulted when the model supplied no tool-call id (plan §4.1).
      const actionId =
        toolCallId ?? `tool:${pluginId}:${toolName}:${nextAnonymousToolSequence()}`;
      const call: ToolCall = {
        source: "plugin",
        pluginId,
        pluginVersion: plugin.version,
        tool: toolName,
        args: callArgs,
        readOnly: toolDef.readOnly,
        owner: options.owner,
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        credentials,
        credentialFingerprint: fingerprint,
        ...(signal === undefined ? {} : { signal }),
        channel: options.channel,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        actionId,
        timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
        maxResultChars: options.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      };

      // The channel owns the raw-body promise; the shared helper builds the
      // `plugin` body, the `rawSettled`/`onBodySkipped` pair, and the fail-loud
      // `mcp` stub. Sync's post-execution tombstone re-check runs inside the
      // invoke closure: a throw after the handler resolved still rejects the
      // body after `rawSettled` has settled, so budget releases (D9) while no
      // cache entry is written.
      const { bodies, scope } = makePluginBodies({
        invoke: async (bodySignal) => {
          const result = await toolHandler.execute(
            pluginId,
            toolName,
            callArgs,
            credentials,
            bodySignal,
          );
          // Post-execution tombstone re-check: do not cache a result produced
          // after the owner began deleting (mirrors the old post-direct check).
          options.assertActive?.();
          return result;
        },
        scope: {
          ...(options.track === undefined ? {} : { track: options.track }),
        },
        channelLabel: "sync",
      });

      return pipeline.dispatch({ call, bodies, scope });
    },
  });
}

/**
 * Merge plugin-bound tools with MCP tools, deduplicating by name (the MCP
 * version loses ties, matching both the sync transport and the job runner).
 */
export function mergePluginAndMcpTools(
  pluginTools: DynamicStructuredTool[],
  mcpTools: DynamicStructuredTool[],
  logPrefix: string,
): DynamicStructuredTool[] {
  const allTools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  // Identity set built once: `mcpTools.includes(t)` inside the loop was O(n²).
  const mcpToolSet = new Set(mcpTools);
  for (const t of [...pluginTools, ...mcpTools]) {
    if (seen.has(t.name)) {
      if (mcpToolSet.has(t)) {
        console.warn(
          `${logPrefix} tool '${t.name}' defined by both a plugin and an MCP server; skipping MCP version`,
        );
      }
      continue;
    }
    seen.add(t.name);
    allTools.push(t);
  }
  return allTools;
}