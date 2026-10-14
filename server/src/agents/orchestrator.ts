import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PluginRegistry } from "../plugins/registry.ts";
import { jsonSchemaToZod } from "../tools/schema.ts";
import {
  DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "../tools/bounds.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import type { CredentialResolver } from "../credentials/resolver.ts";
import type { BudgetManager } from "../managers/budget.ts";
import type { ToolResultCache } from "../managers/cache.ts";
import type { ToolPipeline } from "../tools/pipeline.ts";
import { bindTools, makePluginBodies } from "../tools/bind.ts";
import { buildPipelineForChannel } from "../tools/channel.ts";

// Single source of truth for JSON-Schema -> zod translation lives in the neutral
// `tools/schema.ts` (it also infers `type` for schema-less MCP tools), so neither
// this module nor `tools/bind.ts` forms an import cycle with `agents/mcp.ts`.
// Re-export it here so the runner and tests keep importing from one spot.
export { jsonSchemaToZod };

/**
 * Wiring layer: assembles a ready-to-run supervisor agent from the plugin
 * registry + an already-configured model.
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
   * Per-request credential source — the SOLE source of a tool call's
   * credentials + fingerprint, closing over the request's validated maps
   * (constructed in `chat.ts`). Omitted = tool calls carry no credentials.
   */
  credentialsResolver?: CredentialResolver;
  /**
   * Composition-root-supplied engine for this channel. When present it is used
   * verbatim; otherwise the binder falls back to
   * {@link buildPipelineForChannel} with the `budget`/`cache` deps below (the
   * unit-test path). The root injects one shared sync-shaped engine so the
   * construction and the channel→interceptor mapping live in one place.
   */
  pipeline?: ToolPipeline;
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
 * The whole sync-channel policy lives in the shared `ToolPipeline`, and the
 * loop/filter/dedupe/dispatch skeleton lives in `bindTools`; this function only
 * supplies the sync-specific hooks. The interceptor set
 * (`serialize → cache → budget → execution`) is that channel's policy:
 *   - `serialize` bounds and measures the args;
 *   - `cache` serves/stores read-only results;
 *   - `budget` gates per owner+plugin and quarantines an unsettled raw body —
 *     now INSIDE the sync channel too;
 *   - `execution` bounds the handler with the effective timeout, propagates the
 *     abort signal, and tracks the call with the channel's `StreamExecution`;
 *   - `onResult` emits the `plugin.tool` audit for the call.
 */
export function bindPluginTools(
  registry: PluginRegistry,
  toolHandler: ToolCallHandler,
  enabledPlugins: readonly string[] | undefined,
  options: BindPluginToolsOptions,
): DynamicStructuredTool[] {
  // `undefined` means "all installed"; an empty array means "none".
  const enabled = enabledPlugins === undefined ? null : new Set(enabledPlugins);
  // The engine is injected by the composition root; the fallback preserves the
  // unit-test call shape (no explicit pipeline). Either way the channel→
  // interceptor mapping lives in `buildPipelineForChannel` and every per-call
  // value rides `ToolCall`/`ToolCallScope`.
  const pipeline = options.pipeline ??
    buildPipelineForChannel(options.channel, {
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
  // One credential source for the binding — the per-request resolver the
  // transport injects, so `buildCall` never performs an inline map lookup.
  const credentialsResolver = options.credentialsResolver;
  return bindTools({
    registry,
    pipeline,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    duplicateLogPrefix: "[agents]",
    hooks: {
      select: (plugin) => enabled === null || enabled.has(plugin.id),
      buildCall: (ctx) => {
        // Account-deletion tombstone: reject before any policy runs. A cache hit
        // must not be served to a deleting owner (mirrors the old
        // `withToolResultCache` pre-check).
        options.assertActive?.();
        // Sync fingerprints the raw per-plugin request credentials; this
        // derivation is deliberately NOT unified with warmup/job and lives in
        // the provider now. Missing -> undefined credentials, with the empty
        // fingerprint the inline `credentialFingerprint(credentials ?? {})` used.
        const resolvedCredentials = credentialsResolver?.resolve({
          ...(options.owner === undefined ? {} : { owner: options.owner }),
          pluginId: ctx.plugin.id,
          kind: "tool",
          channel: "sync",
        });
        const credentials = resolvedCredentials?.credentials;
        const fingerprint = resolvedCredentials?.fingerprint ?? credentialFingerprint({});
        return {
          source: "plugin",
          pluginId: ctx.plugin.id,
          pluginVersion: ctx.plugin.version,
          tool: ctx.toolDef.name,
          args: ctx.args,
          readOnly: ctx.toolDef.readOnly,
          owner: options.owner,
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          credentials,
          credentialFingerprint: fingerprint,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          channel: options.channel,
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
          actionId: ctx.actionId,
          timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
          maxResultChars: options.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
        };
      },
      // The channel owns the raw-body promise; the shared helper builds the
      // `plugin` body, the `rawSettled`/`onBodySkipped` pair, and the fail-loud
      // `mcp` stub. Sync's post-execution tombstone re-check runs inside the
      // invoke closure: a throw after the handler resolved still rejects the
      // body after `rawSettled` has settled, so budget releases while no
      // cache entry is written. `call.credentials` is reused so the credential
      // reference the `ToolCall` carries is the one executed.
      buildExecution: (ctx, call) =>
        makePluginBodies({
          invoke: async (bodySignal) => {
            const result = await toolHandler.execute(
              ctx.plugin.id,
              ctx.toolDef.name,
              ctx.args,
              call.credentials,
              bodySignal,
            );
            // Post-execution tombstone re-check: do not cache a result produced
            // after the owner began deleting.
            options.assertActive?.();
            return result;
          },
          scope: {
            ...(options.track === undefined ? {} : { track: options.track }),
          },
          channelLabel: "sync",
        }),
    },
  });
}
