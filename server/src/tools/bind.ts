import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type { ToolDefinition, ToolPluginDefinition } from "../plugins/types.ts";
import { jsonSchemaToZod } from "../agents/mcp.ts";
import type {
  ToolBodies,
  ToolBody,
  ToolCall,
  ToolCallScope,
  ToolPipeline,
} from "./pipeline.ts";

/**
 * `bind.ts` — the ONE plugin tool-assembly path.
 *
 * Both plugin channels (sync and job) share the same skeleton: iterate the
 * installed plugins, filter to tool plugins, apply a channel gate, dedupe tool
 * names with a `console.warn`, and construct a `DynamicStructuredTool` whose
 * `func` builds a `ToolCall` + `ToolCallScope` and calls `pipeline.dispatch`.
 * `bindTools` owns that skeleton — including the per-binding anonymous
 * `actionId` sequence counter (plan §4.1) — so neither channel re-implements
 * the loop. Only three things are channel-specific, supplied as hooks:
 *
 *   - `select` — the plugin gate (sync: `enabledPlugins` allow-set; job:
 *     `Object.hasOwn(credentialsByPlugin, plugin.id)`);
 *   - `buildCall` / `buildExecution` — the per-call `ToolCall` and the
 *     `ToolBodies` + `ToolCallScope` pair (job carries task-fence fields and
 *     cancellation telemetry; sync carries the account-deletion guard);
 *   - `duplicateLogPrefix` — verbatim `[agents]` / `[jobs]` on the duplicate
 *     warning.
 *
 * Step 1.11 extends this seam to MCP (`source: "mcp"`); until then MCP stays
 * entirely in `agents/mcp.ts` and `mergePluginAndMcpTools`.
 */

/**
 * Everything the channel-specific hooks need for ONE invocation. Built by
 * `bindTools` after it has composed the channel signal and computed the
 * `actionId`, so the hooks never repeat that boilerplate.
 */
export type BindToolContext = {
  readonly plugin: ToolPluginDefinition;
  readonly toolDef: ToolDefinition;
  readonly args: Record<string, unknown>;
  /** Model tool-call id from LangChain's run config, when present. */
  readonly toolCallId: string | undefined;
  /** Composed channel + LangChain run signal, or `undefined` when neither exists. */
  readonly signal: AbortSignal | undefined;
  /** Per-call id: the model tool-call id, else an anonymous sequence id. */
  readonly actionId: string;
};

/** The channel-specific halves of a binding. */
export type BindToolHooks = {
  /** Channel plugin gate, applied after `isToolPlugin`. */
  readonly select: (plugin: ToolPluginDefinition) => boolean;
  /** Builds the per-call `ToolCall` (all channel-specific fields). */
  readonly buildCall: (ctx: BindToolContext) => ToolCall;
  /**
   * Builds the per-call `ToolBodies` + `ToolCallScope` together, because the
   * channel owns the raw-body promise (plan §4.2). Receives the `call` so the
   * credential reference resolved by `buildCall` is reused verbatim — the job
   * channel must not resolve its credential pin twice.
   */
  readonly buildExecution: (
    ctx: BindToolContext,
    call: ToolCall,
  ) => { bodies: ToolBodies; scope: ToolCallScope };
};

export type BindToolsOptions = {
  readonly registry: PluginRegistry;
  readonly pipeline: ToolPipeline;
  /**
   * Channel signal, captured BEFORE any timeout controller exists; composed
   * with the LangChain run signal per invocation.
   */
  readonly signal?: AbortSignal;
  /** Verbatim prefix for the duplicate-name warning (`[agents]` / `[jobs]`). */
  readonly duplicateLogPrefix: string;
  readonly hooks: BindToolHooks;
};

/**
 * Translate installed tool plugins into LangChain tools. Exported for tests.
 *
 * The duplicate-name gate and the anonymous-sequence counter are per binding,
 * matching the pre-1.10 `bindPluginTools`/`bindJobTools` exactly.
 */
export function bindTools(opts: BindToolsOptions): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  let anonymousToolSequence = 0;
  for (const plugin of opts.registry.listInstalledPlugins()) {
    if (!isToolPlugin(plugin)) continue;
    if (!opts.hooks.select(plugin)) continue;
    for (const toolDef of plugin.tools) {
      if (seen.has(toolDef.name)) {
        console.warn(
          `${opts.duplicateLogPrefix} skipping duplicate tool '${toolDef.name}' from plugin '${plugin.id}'`,
        );
        continue;
      }
      seen.add(toolDef.name);
      tools.push(
        bindTool(opts, plugin, toolDef, () => ++anonymousToolSequence),
      );
    }
  }
  return tools;
}

function bindTool(
  opts: BindToolsOptions,
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  nextAnonymousToolSequence: () => number,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (args, _runManager, config) => {
      const callArgs = args as Record<string, unknown>;
      // The channel signal is the composition of the binding's own signal and
      // the LangChain run signal, captured before any timeout controller exists;
      // the `execution` interceptor composes its timeout on top via next(signal).
      const configSignal = (config as { signal?: AbortSignal } | undefined)?.signal;
      const signal = opts.signal && configSignal
        ? AbortSignal.any([opts.signal, configSignal])
        : opts.signal ?? configSignal;
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      // The anonymous sequence counter belongs to the binding layer; it is only
      // consulted when the model supplied no tool-call id (plan §4.1).
      const actionId =
        toolCallId ?? `tool:${plugin.id}:${toolDef.name}:${nextAnonymousToolSequence()}`;
      const ctx: BindToolContext = {
        plugin,
        toolDef,
        args: callArgs,
        toolCallId,
        signal,
        actionId,
      };
      const call = opts.hooks.buildCall(ctx);
      const { bodies, scope } = opts.hooks.buildExecution(ctx, call);
      return opts.pipeline.dispatch({ call, bodies, scope });
    },
  });
}

/**
 * `makePluginBodies` — shared channel-side construction of a dispatch's
 * `ToolBodies` and `ToolCallScope` (plan §4.2).
 *
 * Every plugin-source channel (sync today; job; warmup after 1.9c) needs the
 * same three things, and only the raw executor call differs:
 *
 *   1. a `rawSettled` deferred that resolves when the RAW (unbounded) handler
 *      settles — NOT when the bounded race settles — so the `budget`
 *      interceptor can tell an unsettled timeout (quarantine) from a release;
 *   2. a `plugin` body that invokes the raw handler and resolves that deferred
 *      on BOTH settlement paths, including a synchronous throw before the raw
 *      work starts;
 *   3. a `scope` carrying `rawSettled` + `onBodySkipped` (which resolves the
 *      SAME deferred when the core reports the body never started, so budget
 *      releases rather than quarantines — D9) plus any channel-owned extras
 *      (`track`/`trackUntil`/`onToolStart`/`onToolEnd`).
 *
 * Extracted from the byte-identical blocks in `agents/orchestrator.ts` and
 * `jobs/runner.ts` (finding m1). `ToolCallScope` is `readonly`, so the scope is
 * constructed complete here and never mutated afterwards.
 */
export type MakePluginBodiesOptions = {
  /**
   * Invokes the raw handler with the composed body signal. Channel-specific
   * post-settlement work (e.g. sync's post-execution account-deletion tombstone
   * re-check) belongs here: a throw after the handler resolved rejects the body
   * after `rawSettled` has already resolved, so budget releases rather than
   * quarantines.
   */
  readonly invoke: (signal: AbortSignal) => Promise<string>;
  /** Channel-owned scope fields beyond `rawSettled`/`onBodySkipped`. */
  readonly scope?: Omit<ToolCallScope, "rawSettled" | "onBodySkipped">;
  /**
   * Label used in the default `mcp` body's fail-loud message (e.g. `"sync"`,
   * `"job"`). No channel routes MCP through this pipeline yet (step 1.11), so
   * this body should stay unreachable; it exists so a wiring bug is not masked
   * by a silent empty result.
   */
  readonly channelLabel: string;
};

export function makePluginBodies(
  opts: MakePluginBodiesOptions,
): { bodies: ToolBodies; scope: ToolCallScope } {
  let settleRaw!: () => void;
  const rawSettled = new Promise<void>((resolve) => {
    settleRaw = resolve;
  });
  const plugin: ToolBody = async (_dispatch, bodySignal) => {
    let raw: Promise<string>;
    try {
      raw = Promise.resolve(opts.invoke(bodySignal));
    } catch (error) {
      // The body was invoked (so the core will NOT fire `onBodySkipped`), but
      // the raw work never started; settle now so budget releases.
      settleRaw();
      throw error;
    }
    void raw.then(settleRaw, settleRaw);
    return raw;
  };
  const scope: ToolCallScope = {
    rawSettled,
    // REQUIRED wiring (D9): resolve the SAME deferred when the core reports the
    // body never started, so budget releases rather than quarantines.
    onBodySkipped: () => settleRaw(),
    ...opts.scope,
  };
  return {
    bodies: {
      plugin,
      mcp: async () => {
        throw new Error(
          `${opts.channelLabel} channel: mcp source not wired through the pipeline yet (step 1.11)`,
        );
      },
    },
    scope,
  };
}
