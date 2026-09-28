import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bindTools, createBoundTool, makeToolBodies } from "../../src/tools/bind.ts";
import type { BindToolHooks } from "../../src/tools/bind.ts";
import type { ToolCall, ToolPipeline } from "../../src/tools/pipeline.ts";
import { createToolPipeline } from "../../src/tools/pipeline.ts";
import { jsonSchemaToZod } from "../../src/agents/mcp.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";

/**
 * Step 1.10 pins: the plugin tool-assembly skeleton (iterate → filter → dedupe
 * → dispatch) now lives ONCE in `bindTools`. These tests drive `bindTools`
 * through a recording pipeline and stub hooks, so they assert the shared seam
 * directly rather than through either channel.
 */

function toolPlugin(id: string, toolNames: string[]): ToolPluginDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: 1,
    type: "tool",
    name: id,
    description: id,
    baseUrls: [],
    tools: toolNames.map((name) => ({
      name,
      description: name,
      readOnly: true,
      inputSchema: { type: "object" },
    })),
  };
}

/** A pipeline that records every dispatched `ToolCall` and returns "ok". */
function recordingPipeline(calls: ToolCall[]): ToolPipeline {
  return {
    interceptorNames: [],
    async dispatch(input) {
      calls.push(input.call);
      return "ok";
    },
    dispose() {},
  };
}

function hooks(
  select: BindToolHooks["select"] = () => true,
): BindToolHooks {
  return {
    select,
    buildCall: (ctx) => ({
      source: "plugin",
      pluginId: ctx.plugin.id,
      pluginVersion: ctx.plugin.version,
      tool: ctx.toolDef.name,
      args: ctx.args,
      readOnly: ctx.toolDef.readOnly,
      channel: "sync-stateless",
      actionId: ctx.actionId,
      timeoutMs: 60_000,
      maxResultChars: 65_536,
      ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    }),
    buildExecution: () => ({
      bodies: { plugin: async () => "ok", mcp: async () => "ok" },
      scope: {},
    }),
  };
}

describe("bindTools — the single plugin tool-assembly skeleton", () => {
  test("dedupes duplicate tool names across plugins with the supplied prefix", (t) => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    t.after(() => {
      console.warn = original;
    });

    const tools = bindTools({
      registry: {
        listInstalledPlugins: () => [
          toolPlugin("alpha", ["shared", "a"]),
          toolPlugin("beta", ["shared", "b"]),
        ],
      } as never,
      pipeline: recordingPipeline([]),
      duplicateLogPrefix: "[test]",
      hooks: hooks(),
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["shared", "a", "b"],
      "the first-seen plugin keeps the name; later duplicates are skipped",
    );
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /^\[test\] skipping duplicate tool 'shared' from plugin 'beta'$/,
    );
  });

  test("select gates a plugin out of the binding", () => {
    const tools = bindTools({
      registry: {
        listInstalledPlugins: () => [
          toolPlugin("alpha", ["shared", "a"]),
          toolPlugin("beta", ["shared", "b"]),
        ],
      } as never,
      pipeline: recordingPipeline([]),
      duplicateLogPrefix: "[test]",
      hooks: hooks((plugin) => plugin.id !== "beta"),
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["shared", "a"],
      "a plugin the select hook rejects contributes no tools",
    );
  });

  test("the anonymous actionId counter is owned by bindTools and advances only for id-less calls", async () => {
    const calls: ToolCall[] = [];
    const [tool] = bindTools({
      registry: {
        listInstalledPlugins: () => [toolPlugin("alpha", ["a"])],
      } as never,
      pipeline: recordingPipeline(calls),
      duplicateLogPrefix: "[test]",
      hooks: hooks(),
    });

    await tool!.func({}, undefined, {} as never);
    await tool!.func({}, undefined, {} as never);
    await tool!.func({}, undefined, { toolCall: { id: "model-1" } } as never);
    await tool!.func({}, undefined, {} as never);

    assert.deepEqual(
      calls.map((call) => call.actionId),
      ["tool:alpha:a:1", "tool:alpha:a:2", "model-1", "tool:alpha:a:3"],
      "a model tool-call id is used verbatim and does not advance the sequence",
    );
    assert.deepEqual(
      calls.map((call) => call.toolCallId),
      [undefined, undefined, "model-1", undefined],
    );
  });

  test("composes the binding signal with the LangChain run signal", async () => {
    const calls: ToolCall[] = [];
    const bindingSignal = new AbortController().signal;
    const runController = new AbortController();
    const [tool] = bindTools({
      registry: {
        listInstalledPlugins: () => [toolPlugin("alpha", ["a"])],
      } as never,
      pipeline: recordingPipeline(calls),
      duplicateLogPrefix: "[test]",
      signal: bindingSignal,
      hooks: hooks(),
    });

    await tool!.func({}, undefined, { signal: runController.signal } as never);
    const composed = calls[0]!.signal;
    assert.ok(composed !== undefined, "the composed signal reaches the ToolCall");
    assert.equal(composed!.aborted, false);
    runController.abort();
    assert.equal(composed!.aborted, true, "the run signal is part of the composition");
  });
});

describe("bind seam — shared per-tool constructor and source bodies (step 1.11)", () => {
  test("createBoundTool accepts LangChain's config for an MCP-style spec (toolCallId + anonymous actionId)", async () => {
    const calls: ToolCall[] = [];
    let sequence = 0;
    const tool = createBoundTool({
      pipeline: recordingPipeline(calls),
      name: "mcp-tool",
      description: "mcp",
      schema: jsonSchemaToZod({ type: "object" }),
      actionIdPrefix: "mcp:server:mcp-tool",
      bindingSignal: undefined,
      nextAnonymousToolSequence: () => ++sequence,
      prepare: (ctx) => ({
        call: {
          source: "mcp",
          pluginId: "mcp:server",
          tool: "mcp-tool",
          args: ctx.args,
          readOnly: true,
          channel: "sync-stateless",
          actionId: ctx.actionId,
          timeoutMs: 60_000,
          maxResultChars: 65_536,
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        },
        bodies: makeToolBodies({ source: "mcp", invoke: async () => "ok" }).bodies,
        scope: {},
      }),
    });

    await tool.func({}, undefined, { toolCall: { id: "model-42" } } as never);
    await tool.func({}, undefined, {} as never);

    assert.equal(calls[0]?.toolCallId, "model-42");
    assert.equal(calls[0]?.actionId, "model-42");
    assert.equal(calls[1]?.toolCallId, undefined);
    assert.equal(calls[1]?.actionId, "mcp:server:mcp-tool:1");
  });

  test("makeToolBodies runs the real body for its source and fails loud for the other", async () => {
    const pipeline = createToolPipeline({ interceptors: [] });
    const { bodies } = makeToolBodies({
      source: "mcp",
      channelLabel: "mcp",
      invoke: async () => "mcp-ok",
    });
    const base: ToolCall = {
      source: "plugin",
      pluginId: "demo",
      tool: "t",
      args: {},
      readOnly: true,
      channel: "sync-stateless",
      actionId: "a",
      timeoutMs: 60_000,
      maxResultChars: 65_536,
    };

    assert.equal(
      await pipeline.dispatch({
        call: { ...base, source: "mcp", pluginId: "mcp:demo" },
        bodies,
      }),
      "mcp-ok",
    );
    await assert.rejects(
      pipeline.dispatch({ call: base, bodies }),
      /supplies a 'mcp' body but was dispatched with source 'plugin'/,
      "a wrong-source dispatch must not silently return an empty string",
    );
  });
});
