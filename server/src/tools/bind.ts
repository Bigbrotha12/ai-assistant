import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type { ToolDefinition, ToolPluginDefinition } from "../plugins/types.ts";
import { jsonSchemaToZod } from "./schema.ts";
import type {
  ToolBodies,
  ToolBody,
  ToolCall,
  ToolCallScope,
  ToolDispatch,
  ToolPipeline,
} from "./pipeline.ts";

/**
 * `bind.ts` — the ONE tool-assembly seam for both sources (plugin + MCP).
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
 * Step 1.11 extends this seam to MCP (`source: "mcp"`): {@link createBoundTool}
 * is the shared per-tool constructor, and `bindMcpServers` (`agents/mcp.ts`)
 * uses it to build MCP tools that dispatch through the pipeline with
 * `pluginId: "mcp:<serverName>"`. The plugin-wins/MCP-loses tie-break lives in
 * the MCP binder, which is told the plugin tool names to skip
 * (`excludeToolNames`); `mergePluginAndMcpTools` was deleted.
 */

/**
 * Everything the channel-specific hooks need for ONE invocation. Built by
 * `bindTools` after it has composed the channel signal and computed the
 * `actionId`, so the hooks never repeat that boilerplate.
 */
export type BindInvocationContext = {
  readonly args: Record<string, unknown>;
  /** Model tool-call id from LangChain's run config, when present. */
  readonly toolCallId: string | undefined;
  /** Composed channel + LangChain run signal, or `undefined` when neither exists. */
  readonly signal: AbortSignal | undefined;
  /** Per-call id: the model tool-call id, else an anonymous sequence id. */
  readonly actionId: string;
};

/** Plugin-source context: the invocation context plus the resolved definitions. */
export type BindToolContext = BindInvocationContext & {
  readonly plugin: ToolPluginDefinition;
  readonly toolDef: ToolDefinition;
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
  const nextAnonymousToolSequence = createAnonymousSequence();
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
        bindTool(opts, plugin, toolDef, nextAnonymousToolSequence),
      );
    }
  }
  return tools;
}

/**
 * Shared per-tool constructor for BOTH sources. Given a `prepare` hook that
 * builds the per-invocation `ToolCall` + `ToolBodies` + `ToolCallScope`, it
 * wires LangChain's `func` signature once:
 *   - composes the binding signal with LangChain's run signal, captured before
 *     any timeout controller exists;
 *   - reads the model tool-call id from the run config third argument (the MCP
 *     `func` used to ignore it, so `replay`/`fence` could never populate
 *     `toolCallId`);
 *   - computes the per-binding anonymous `actionId`;
 *   - dispatches through the shared pipeline.
 */
export function createBoundTool(opts: {
  readonly pipeline: ToolPipeline;
  readonly name: string;
  readonly description: string;
  readonly schema: ReturnType<typeof jsonSchemaToZod>;
  /** Anonymous `actionId` prefix; this function appends the sequence number. */
  readonly actionIdPrefix: string;
  readonly bindingSignal: AbortSignal | undefined;
  readonly nextAnonymousToolSequence: () => number;
  readonly prepare: (ctx: BindInvocationContext) => {
    call: ToolCall;
    bodies: ToolBodies;
    scope: ToolCallScope;
  };
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: opts.name,
    description: opts.description,
    schema: opts.schema,
    func: async (args, _runManager, config) => {
      const callArgs = args as Record<string, unknown>;
      // The channel signal is the composition of the binding's own signal and
      // the LangChain run signal, captured before any timeout controller exists;
      // the `execution` interceptor composes its timeout on top via next(signal).
      const configSignal = (config as { signal?: AbortSignal } | undefined)?.signal;
      const signal = opts.bindingSignal && configSignal
        ? AbortSignal.any([opts.bindingSignal, configSignal])
        : opts.bindingSignal ?? configSignal;
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      // The anonymous sequence counter belongs to the binding layer; it is only
      // consulted when the model supplied no tool-call id (plan §4.1).
      const actionId =
        toolCallId ?? `${opts.actionIdPrefix}:${opts.nextAnonymousToolSequence()}`;
      const ctx: BindInvocationContext = {
        args: callArgs,
        toolCallId,
        signal,
        actionId,
      };
      const { call, bodies, scope } = opts.prepare(ctx);
      return opts.pipeline.dispatch({ call, bodies, scope });
    },
  });
}

/**
 * The per-binding anonymous-sequence counter (plan §4.1). Shared by `bindTools`
 * (plugin sources) and `bindMcpServers` (MCP source) so the "1-based, per
 * binding, only consulted when the model supplied no tool-call id" rule is
 * written once. Returns the next sequence number; `createBoundTool` composes
 * the `actionId` as `` `${prefix}:${n}` ``.
 */
export function createAnonymousSequence(): () => number {
  let sequence = 0;
  return () => ++sequence;
}

/**
 * The channel-owned `ToolCallScope` extras (`track`/`trackUntil`/
 * `onToolStart`/`onToolEnd`), assembled once for every binder. `rawSettled` and
 * `onBodySkipped` are NOT here: the channel's `ToolBodies` wrapper owns those
 * (plan §4.2). A `undefined` field is omitted rather than set to `undefined`,
 * matching the pre-1.13 inline bundles.
 */
export function channelScopeHooks(opts: {
  readonly track?: ToolCallScope["track"];
  readonly trackUntil?: ToolCallScope["trackUntil"];
  readonly onToolStart?: (actionId: string) => void;
  readonly onToolEnd?: (actionId: string) => void;
}): Omit<ToolCallScope, "rawSettled" | "onBodySkipped"> {
  return {
    ...(opts.track === undefined ? {} : { track: opts.track }),
    ...(opts.trackUntil === undefined ? {} : { trackUntil: opts.trackUntil }),
    ...(opts.onToolStart === undefined ? {} : { onToolStart: opts.onToolStart }),
    ...(opts.onToolEnd === undefined ? {} : { onToolEnd: opts.onToolEnd }),
  };
}

function bindTool(
  opts: BindToolsOptions,
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  nextAnonymousToolSequence: () => number,
): DynamicStructuredTool {
  return createBoundTool({
    pipeline: opts.pipeline,
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    actionIdPrefix: `tool:${plugin.id}:${toolDef.name}`,
    bindingSignal: opts.signal,
    nextAnonymousToolSequence,
    prepare: (ctx) => {
      const toolCtx: BindToolContext = { ...ctx, plugin, toolDef };
      const call = opts.hooks.buildCall(toolCtx);
      return { call, ...opts.hooks.buildExecution(toolCtx, call) };
    },
  });
}

/**
 * `makeToolBodies` — shared channel-side construction of a dispatch's
 * `ToolBodies` and `ToolCallScope` for ONE source (plan §4.2).
 *
 * Every binding needs the same three things, and only the source and the raw
 * executor call differ:
 *
 *   1. a `rawSettled` deferred that resolves when the RAW (unbounded) handler
 *      settles — NOT when the bounded race settles — so the `budget`
 *      interceptor can tell an unsettled timeout (quarantine) from a release;
 *   2. a body that invokes the raw handler and resolves that deferred on BOTH
 *      settlement paths, including a synchronous throw before the raw work
 *      starts;
 *   3. a `scope` carrying `rawSettled` + `onBodySkipped` (which resolves the
 *      SAME deferred when the core reports the body never started, so budget
 *      releases rather than quarantines — D9) plus any channel-owned extras
 *      (`track`/`trackUntil`/`onToolStart`/`onToolEnd`).
 *
 * Step 1.11: the real body is placed under the binding's OWN source key. The
 * other source key is a shared fail-loud guard, so a dispatch whose source does
 * not match its binding aborts loudly instead of silently running the wrong
 * body or returning an empty string. MCP bindings pass `source: "mcp"`; plugin
 * channels (sync, job, warmup) pass `source: "plugin"` via
 * {@link makePluginBodies}.
 */
export type MakeToolBodiesOptions = {
  readonly source: ToolCall["source"];
  /**
   * Invokes the raw handler with the composed body signal. Channel-specific
   * post-settlement work (e.g. sync's post-execution account-deletion tombstone
   * re-check) belongs here: a throw after the handler resolved rejects the body
   * after `rawSettled` has already resolved, so budget releases rather than
   * quarantines. `dispatch` carries the `serialize` interceptor's `inputBytes`
   * for bodies (MCP audit) that need it.
   */
  readonly invoke: (signal: AbortSignal, dispatch: ToolDispatch) => Promise<string>;
  /** Channel-owned scope fields beyond `rawSettled`/`onBodySkipped`. */
  readonly scope?: Omit<ToolCallScope, "rawSettled" | "onBodySkipped">;
  /** Label used in the fail-loud wrong-source guard message. */
  readonly channelLabel?: string;
};

export function makeToolBodies(
  opts: MakeToolBodiesOptions,
): { bodies: ToolBodies; scope: ToolCallScope } {
  let settleRaw!: () => void;
  const rawSettled = new Promise<void>((resolve) => {
    settleRaw = resolve;
  });
  const body: ToolBody = async (dispatch, bodySignal) => {
    let raw: Promise<string>;
    try {
      raw = Promise.resolve(opts.invoke(bodySignal, dispatch));
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
  const otherSource: ToolCall["source"] = opts.source === "plugin" ? "mcp" : "plugin";
  // Not a per-channel "mcp not wired yet" stub: a single invariant guard that
  // fires only if a dispatch reaches this binding with the wrong source, so a
  // wiring bug can never silently return an empty string.
  const wrongSource: ToolBody = () => {
    throw new Error(
      `tool binding${opts.channelLabel === undefined ? "" : ` for the '${opts.channelLabel}' channel`} ` +
        `supplies a '${opts.source}' body but was dispatched with source '${otherSource}'`,
    );
  };
  return {
    bodies: opts.source === "plugin"
      ? { plugin: body, mcp: wrongSource }
      : { plugin: wrongSource, mcp: body },
    scope,
  };
}

/**
 * Plugin-channel wrapper over {@link makeToolBodies} (source `"plugin"`). Kept
 * as a named export because the warmup channel (outside this step's edit set)
 * and the pipeline tests call it directly. MCP bindings use `makeToolBodies`
 * with `source: "mcp"` and supply their own body, so this helper no longer
 * injects an mcp-specific fail-loud stub for every plugin channel.
 */
export type MakePluginBodiesOptions = {
  readonly invoke: (signal: AbortSignal, dispatch: ToolDispatch) => Promise<string>;
  /** Channel-owned scope fields beyond `rawSettled`/`onBodySkipped`. */
  readonly scope?: Omit<ToolCallScope, "rawSettled" | "onBodySkipped">;
  /**
   * Label used in the fail-loud wrong-source guard message (e.g. `"sync"`,
   * `"job"`, `"warmup"`).
   */
  readonly channelLabel: string;
};

export function makePluginBodies(
  opts: MakePluginBodiesOptions,
): { bodies: ToolBodies; scope: ToolCallScope } {
  return makeToolBodies({
    source: "plugin",
    invoke: opts.invoke,
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    channelLabel: opts.channelLabel,
  });
}
