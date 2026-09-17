import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  BaseChatModelCallOptions,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { MemorySaver, Overwrite } from "@langchain/langgraph";
import { compileGraphWithCheckpointer } from "../../src/agents/compile.ts";
import { createCheckpointStore } from "../../src/checkpoints/store.ts";
import { SUPERVISOR_PROMPT } from "../../src/agents/prompts.ts";
import {
  ContextBudgetError,
  createContextManager,
  estimateMessagesTokens,
} from "../../src/middleware/context.ts";
import { createAgentGraph, MAX_TOOL_ROUNDS } from "../../src/agents/graph.ts";
import { createAgent, jsonSchemaToZod } from "../../src/agents/orchestrator.ts";
import type { ToolCallHandler } from "../../src/agents/orchestrator.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";

/**
 * Scripted fake chat model: returns a preset sequence of AIMessages (some with
 * tool_calls) and streams them chunk-by-chunk (calling `handleLLMNewToken`) so
 * LangGraph's `streamEvents` emits `on_chat_model_stream`, mirroring what a
 * real streaming model does.
 */
type ScriptedChatModelOptions = BaseChatModelParams & {
  responses: BaseMessage[];
};

class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];

  constructor(options: ScriptedChatModelOptions) {
    super(options);
    this.queue = [...options.responses];
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedChatModel({ responses: this.queue });
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(
    _messages: BaseMessage[],
    _options?: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const message = this.queue.shift() ?? new AIMessage("(scripted responses exhausted)");
    return { generations: [{ message, text: "" }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const message = this.queue.shift() ?? new AIMessage("(scripted responses exhausted)");
    const text = typeof message.content === "string" ? message.content : "";
    const chunk = new AIMessageChunk({
      content: text,
      tool_calls: message instanceof AIMessage ? message.tool_calls : undefined,
      additional_kwargs: {},
    });
    const generation = new ChatGenerationChunk({ message: chunk, text });
    await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
      chunk: generation,
    });
    yield generation;
  }
}

function toolCallMessage(name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      { name, args, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "tool_call" },
    ],
  });
}

function listTasksTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "list_tasks",
    description: "List tasks from a project",
    schema: z.object({ projectId: z.string() }),
    func: async (args) => JSON.stringify({ ok: true, projectId: args.projectId }),
  });
}

describe("agent graph — supervisor loop", () => {
  test("tool_calls route through the tool executor and the final answer terminates", async () => {
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }),
        new AIMessage("Here are your tasks."),
      ],
    });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });

    const result = await graph.invoke({ messages: [new HumanMessage("list my tasks")] });

    const messages = result.messages;
    assert.ok(messages[0] instanceof HumanMessage);
    assert.ok(messages[1] instanceof AIMessage);
    assert.equal(messages[1].tool_calls?.[0]?.name, "list_tasks");
    assert.ok(messages[2] instanceof ToolMessage);
    assert.deepEqual(JSON.parse(String(messages[2].content)), {
      ok: true,
      projectId: "p1",
    });
    assert.ok(messages[3] instanceof AIMessage);
    assert.equal(String(messages[3].content), "Here are your tasks.");
    assert.equal(result.toolRounds, 1);
    assert.deepEqual(result.toolResults, ['{"ok":true,"projectId":"p1"}']);
  });

  test("streamEvents (v2) yields on_chat_model_stream and on_chain_end", async () => {
    const model = new ScriptedChatModel({
      responses: [new AIMessage("hello from the assistant")],
    });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });

    const events: string[] = [];
    for await (const event of graph.streamEvents(
      { messages: [new HumanMessage("hi")] },
      { version: "v2" },
    )) {
      events.push(event.event);
    }

    assert.ok(
      events.includes("on_chat_model_stream"),
      `expected on_chat_model_stream, got: ${[...new Set(events)].join(", ")}`,
    );
    assert.ok(
      events.includes("on_chain_end"),
      `expected on_chain_end, got: ${[...new Set(events)].join(", ")}`,
    );
  });

  test("a model that always calls tools terminates at the max-iteration cap", async () => {
    // Each scripted message needs a unique tool_call id: LangGraph's ToolNode
    // skips tool calls whose id already has a ToolMessage in state.
    const responses = Array.from({ length: 20 }, (_, i) =>
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "list_tasks", args: { projectId: "p1" }, id: `call_loop_${i}`, type: "tool_call" },
        ],
      }),
    );
    const model = new ScriptedChatModel({ responses });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });

    const result = await graph.invoke({ messages: [new HumanMessage("go")] });

    assert.equal(result.toolRounds, MAX_TOOL_ROUNDS);
    const toolMessages = result.messages.filter((m) => m instanceof ToolMessage);
    assert.equal(toolMessages.length, MAX_TOOL_ROUNDS);
  });

  test("M7: a tool that throws rejects the invoke (handleToolErrors: false — no swallowed ToolMessage)", async () => {
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }),
        new AIMessage("never"),
      ],
    });
    const throwingTool = new DynamicStructuredTool({
      name: "list_tasks",
      description: "List tasks from a project",
      schema: z.object({ projectId: z.string() }),
      func: async () => {
        throw new Error("backend exploded");
      },
    });
    const graph = createAgentGraph({ model, tools: [throwingTool] });

    await assert.rejects(
      graph.invoke({ messages: [new HumanMessage("list my tasks")] }),
      /backend exploded/,
      "the tool error must propagate instead of becoming a ToolMessage",
    );
  });
});

describe("agent graph Phase 4 state and dispatch", () => {
  test("new input resets tool rounds and termination leaves every call matched", async () => {
    const saver = new MemorySaver();
    const model = new ScriptedChatModel({
      responses: Array.from({ length: 6 }, () => toolCallMessage("list_tasks", { projectId: "p1" })),
    });
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model, tools: [listTasksTool()], maxIterations: 1 }), saver,
    );
    const config = { configurable: { thread_id: "round-reset" } };
    for (let turn = 0; turn < 3; turn++) {
      const result = await graph.invoke({ messages: [new HumanMessage(`turn ${turn}`)] }, config);
      assert.equal(result.toolRounds, 1);
      const calls = result.messages.flatMap((message) => message instanceof AIMessage ? message.tool_calls ?? [] : []);
      const results = result.messages.filter((message) => message instanceof ToolMessage);
      assert.equal(calls.length, turn + 1);
      assert.deepEqual(calls.map((call) => call.id), results.map((message) => message.tool_call_id));
      assert.match(String(result.messages.at(-1)?.content), /Tool round limit reached/);
    }
  });

  test("null recovery preserves the checkpointed counter without another dispatch", async () => {
    const saver = new MemorySaver();
    let dispatches = 0;
    const base = createAgentGraph({
      model: new ScriptedChatModel({ responses: [toolCallMessage("list_tasks", { projectId: "p1" })] }),
      tools: [listTasksTool()],
      maxIterations: 1,
      beforeModelCall: () => { dispatches++; },
    });
    const interrupted = base.builder.compile({ checkpointer: saver, interruptAfter: ["toolExecutor"] });
    const config = { configurable: { thread_id: "recover-rounds" } };
    await interrupted.invoke({ messages: [new HumanMessage("go")] }, config);
    const pending = await interrupted.getState(config);
    assert.deepEqual(pending.next, ["orchestrator"]);
    assert.equal(pending.values.toolRounds, 1);
    const recovered = compileGraphWithCheckpointer(base, saver);
    const result = await recovered.invoke(null, config);
    assert.equal(result.toolRounds, 1);
    assert.equal(dispatches, 1);
    assert.match(String(result.messages.at(-1)?.content), /Tool round limit reached/);
  });

  test("context preparation bounds every tool loop and resumed turn even after compaction", async () => {
    const limitTokens = Math.ceil(SUPERVISOR_PROMPT.length / 4) + 100;
    const context = createContextManager({ limitTokens });
    const dispatches: BaseMessage[][] = [];
    const graph = compileGraphWithCheckpointer(createAgentGraph({
      model: new ScriptedChatModel({ responses: Array.from({ length: 16 }, (_, i) =>
        i % 2 === 0 ? toolCallMessage("list_tasks", { projectId: "p".repeat(2000) }) : new AIMessage("answer".repeat(1000))),
      }),
      tools: [listTasksTool()],
      prepareMessages: context.prepareMessages,
      beforeModelCall: (messages) => {
        assert.equal(messages[0]?.content, SUPERVISOR_PROMPT);
        assert.ok(estimateMessagesTokens(messages) <= limitTokens);
        dispatches.push(messages);
      },
    }), new MemorySaver());
    const config = { configurable: { thread_id: "bounded-growth" } };
    for (let turn = 0; turn < 8; turn++) {
      await graph.invoke({ messages: [new HumanMessage(`turn ${turn}`)] }, config);
      await context.maybeCompactAfterStream({
        graph, owner: "owner", clientThreadId: "growth", threadId: "bounded-growth", lockHeld: true,
      });
      assert.equal((await graph.getState(config)).values.compacted, true);
    }
    assert.equal(dispatches.length, 16);
    assert.ok(estimateMessagesTokens((await graph.getState(config)).values.messages) > limitTokens);
  });

  test("compaction persists once through SQLite reopen and later growth stays request-bounded", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "context-checkpoint-"));
    const options = { dbPath: join(dir, "context.db"), dbKey: "12".repeat(32) };
    let store = await createCheckpointStore(options);
    t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
    const context = createContextManager({ limitTokens: 100 });
    const makeGraph = () => compileGraphWithCheckpointer(createAgentGraph({
      model: new ScriptedChatModel({ responses: [new AIMessage("done")] }), tools: [listTasksTool()],
    }), store.checkpointer);
    let graph = makeGraph();
    const config = { configurable: { thread_id: "durable-context" } };
    await graph.invoke({ messages: [new HumanMessage("old".repeat(1000)), new AIMessage("old answer"), new HumanMessage("live")] }, config);
    const before = await graph.getState(config);
    await context.maybeCompactAfterStream({ graph, owner: "owner", clientThreadId: "client", threadId: "durable-context", lockHeld: true });
    const compacted = await graph.getState(config);
    assert.equal(compacted.values.compacted, true);
    assert.equal(compacted.values.messages.length, 2);
    assert.deepEqual(compacted.next, []);
    assert.notEqual(compacted.config.configurable?.checkpoint_id, before.config.configurable?.checkpoint_id);
    assert.ok(compacted.metadata?.parents);
    assert.equal(compacted.metadata?.source, "update");
    await store.close();
    store = await createCheckpointStore(options);
    graph = makeGraph();
    assert.equal((await graph.getState(config)).values.compacted, true);
    await graph.invoke({ messages: [new HumanMessage("new"), new AIMessage("growth".repeat(1000))] }, config);
    const grown = await graph.getState(config);
    await context.maybeCompactAfterStream({ graph, owner: "owner", clientThreadId: "client", threadId: "durable-context", lockHeld: true });
    assert.equal((await graph.getState(config)).config.configurable?.checkpoint_id, grown.config.configurable?.checkpoint_id);
    assert.ok(estimateMessagesTokens(await context.prepareMessages(grown.values.messages, {})) <= 100);
    assert.ok(estimateMessagesTokens(grown.values.messages) > 100);
  });

  test("preparation failure and dispatch budget failure stop before model invocation", async () => {
    let dispatches = 0;
    const context = createContextManager({ limitTokens: 1 });
    const graph = createAgentGraph({
      model: new ScriptedChatModel({ responses: [new AIMessage("must not run")] }),
      tools: [listTasksTool()],
      prepareMessages: context.prepareMessages,
      beforeModelCall: () => { dispatches++; },
    });
    await assert.rejects(graph.invoke({ messages: [new HumanMessage("oversize")] }), ContextBudgetError);
    assert.equal(dispatches, 0);
    const budgeted = createAgentGraph({
      model: new ScriptedChatModel({ responses: [new AIMessage("must not run")] }),
      tools: [listTasksTool()],
      beforeModelCall: () => { throw new Error("dispatch budget exhausted"); },
    });
    await assert.rejects(budgeted.invoke({ messages: [new HumanMessage("hi")] }), /dispatch budget exhausted/);
  });

  test("runnable signal and metadata reach preparation, dispatch, model and tools", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    class ConfigModel extends ScriptedChatModel {
      override bindTools(_tools: StructuredToolInterface[]) { return this; }
      override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
        assert.ok(options.signal);
        assert.equal(options.signal.aborted, false);
        calls.push("model");
        return super._generate(messages, options);
      }
    }
    const tool = new DynamicStructuredTool({
      name: "list_tasks", description: "test", schema: z.object({ projectId: z.string() }),
      func: async (_args, _runManager, config) => {
        assert.ok(config?.signal);
        assert.equal(config.metadata?.request, "test-request");
        calls.push("tool");
        return "ok";
      },
    });
    const graph = createAgentGraph({
      model: new ConfigModel({ responses: [toolCallMessage("list_tasks", { projectId: "p1" }), new AIMessage("done")] }),
      tools: [tool],
      prepareMessages: (messages, config) => {
        assert.ok(config.signal);
        assert.equal(config.metadata?.request, "test-request");
        calls.push("prepare");
        return messages;
      },
      beforeModelCall: (_messages, config) => {
        assert.ok(config.signal);
        assert.equal(config.metadata?.request, "test-request");
        calls.push("budget");
      },
    });
    await graph.invoke({ messages: [new HumanMessage("go")] }, {
      signal: controller.signal, metadata: { request: "test-request" },
    });
    assert.deepEqual(calls, ["prepare", "budget", "model", "tool", "prepare", "budget", "model"]);
  });

  test("abort during preparation prevents dispatch", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const graph = createAgentGraph({
      model: new ScriptedChatModel({ responses: [new AIMessage("never")] }),
      tools: [listTasksTool()],
      prepareMessages: (messages) => { controller.abort(new Error("cancelled")); return messages; },
      beforeModelCall: () => { dispatches++; },
    });
    await assert.rejects(graph.invoke({ messages: [new HumanMessage("go")] }, { signal: controller.signal }), /cancelled|Abort/);
    assert.equal(dispatches, 0);
  });

  test("graph-supported message replacement preserves unrelated state", async () => {
    const graph = compileGraphWithCheckpointer(createAgentGraph({
      model: new ScriptedChatModel({ responses: [new AIMessage("done")] }), tools: [listTasksTool()],
    }), new MemorySaver());
    const config = { configurable: { thread_id: "overwrite" } };
    await graph.invoke({ messages: [new HumanMessage("old")], toolResults: ["diagnostic"] }, config);
    await graph.updateState(config, { messages: new Overwrite([new HumanMessage("kept")]), compacted: true }, "orchestrator");
    const state = await graph.getState(config);
    assert.equal(state.values.messages.length, 1);
    assert.equal(state.values.messages[0].content, "kept");
    assert.deepEqual(state.values.toolResults, ["diagnostic"]);
    assert.equal(state.values.compacted, true);
    assert.deepEqual(state.next, []);
  });
});

describe("agent graph — zod translation from plugin JsonSchema", () => {
  test("required fields are enforced and optional fields are not", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        projectId: { type: "string", description: "the project id" },
        count: { type: "number" },
        done: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["projectId"],
    });

    assert.equal(schema.safeParse({ projectId: "p1" }).success, true);
    assert.equal(
      schema.safeParse({ projectId: "p1", count: 2, done: true, tags: ["a", "b"] }).success,
      true,
    );
    assert.equal(schema.safeParse({}).success, false, "missing required field must fail");
    assert.equal(
      schema.safeParse({ projectId: 123 }).success,
      false,
      "wrong type for required field must fail",
    );
  });

  test("nested objects and arrays map recursively", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        ids: { type: "array", items: { type: "number" } },
      },
      required: ["meta"],
    });

    assert.equal(schema.safeParse({ meta: { a: "x" }, ids: [1, 2] }).success, true);
    assert.equal(schema.safeParse({ meta: {} }).success, false);
    assert.equal(schema.safeParse({ meta: { a: "x" }, ids: ["1"] }).success, false);
  });

  test("an empty object schema maps to a permissive record", () => {
    const schema = jsonSchemaToZod({ type: "object" });
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.safeParse({ anything: 1 }).success, true);
  });

  test("unmapped types map to z.any() instead of throwing", () => {
    const schema = jsonSchemaToZod({ type: "file" });
    assert.equal(schema.safeParse(42).success, true);
    assert.equal(schema.safeParse({ nested: "x" }).success, true);
  });
});

describe("createAgent — registry tool binding", () => {
  const DNS: Record<string, LookupAddress[]> = {
    "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  };

  function fakeLookup(): LookupFn {
    return async (hostname, _options) => {
      const records = DNS[hostname.toLowerCase()];
      return records ? [...records] : [];
    };
  }

  function vikunjaManifest(): ToolPluginDefinition {
    return {
      id: "vikunja",
      version: "1.4.0",
      schemaVersion: 1,
      type: "tool",
      name: "Vikunja",
      description: "Task management tools",
      tools: [
        {
          name: "list_tasks",
          description: "List tasks from a project",
          readOnly: true,
          inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" } },
            required: ["projectId"],
          },
        },
      ],
      baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
      credentials: { apiKey: { label: "Personal access token", required: true } },
    };
  }

  async function makeEnv(
    t: TestContext,
  ): Promise<{ store: PluginStore; registry: PluginRegistry }> {
    const dir = await mkdtemp(join(tmpdir(), "agents-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [],
      manifests: [vikunjaManifest()],
      lookup: fakeLookup(),
    });
    await store.load();
    await store.install("vikunja");
    return { store, registry: new PluginRegistry(store) };
  }

  test("binds the tool plugin and invokes the injected handler with (pluginId, toolName, args)", async (t) => {
    const { registry } = await makeEnv(t);
    const calls: Array<{
      pluginId: string;
      toolName: string;
      args: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    }> = [];
    const toolHandler: ToolCallHandler = {
      async execute(pluginId, toolName, args, credentials) {
        calls.push({ pluginId, toolName, args, credentials });
        return JSON.stringify({ ok: true, toolName, ...args });
      },
    };

    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }),
        new AIMessage("Done."),
      ],
    });

    const graph = createAgent({ model, registry, toolHandler });
    const result = await graph.invoke({ messages: [new HumanMessage("list tasks")] });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      pluginId: "vikunja",
      toolName: "list_tasks",
      args: { projectId: "p1" },
      credentials: undefined,
    });

    const toolMessage = result.messages.find((m) => m instanceof ToolMessage);
    assert.equal(
      String(toolMessage?.content),
      JSON.stringify({ ok: true, toolName: "list_tasks", projectId: "p1" }),
      "the handler's return value must become the tool message content",
    );
  });

  test("the default stub handler is used when none is injected", async (t) => {
    const { registry } = await makeEnv(t);
    const model = new ScriptedChatModel({
      responses: [toolCallMessage("list_tasks", { projectId: "p1" }), new AIMessage("ok")],
    });

    const graph = createAgent({ model, registry });
    const result = await graph.invoke({ messages: [new HumanMessage("list tasks")] });

    const toolMessage = result.messages.find((m) => m instanceof ToolMessage);
    assert.deepEqual(JSON.parse(String(toolMessage?.content)), {
      ok: true,
      projectId: "p1",
      note: "executor not wired",
    });
  });
});