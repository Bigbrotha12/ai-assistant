import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages";
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
import { createAgentGraph } from "../../src/agents/graph.ts";
import {
  DONE_FRAME,
  errorFrame,
  finishFrame,
  finishReasonFromOutput,
  toOpenAiSse,
} from "../../src/transport/openai.ts";
import type { StreamEvent } from "../../src/transport/openai.ts";

/**
 * Scripted fake chat model: emits a preset sequence of streaming chunks per
 * model turn. Each turn is a batch of `AIMessageChunk` field objects, streamed
 * one `on_chat_model_stream` at a time via `handleLLMNewToken`. Fields support
 * `content`, `tool_call_chunks`, and `response_metadata` so the golden frame
 * sequences (§7) can be driven byte-for-byte.
 */
type ScriptedFields = Record<string, unknown>;

class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: ScriptedFields[][];

  constructor(options: BaseChatModelParams & { turns: ScriptedFields[][] }) {
    super(options);
    this.queue = options.turns.map((turn) => [...turn]);
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedChatModel({ turns: this.queue.map((turn) => [...turn]) });
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(
    _messages: BaseMessage[],
    _options?: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const message = new AIMessage("(scripted responses exhausted)");
    return { generations: [{ message, text: "" }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const turn = this.queue.shift() ?? [];
    for (const fields of turn) {
      const chunk = new AIMessageChunk(fields);
      const text = typeof chunk.content === "string" ? chunk.content : "";
      const generation = new ChatGenerationChunk({ message: chunk, text });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
        chunk: generation,
      });
      yield generation;
    }
  }
}

/** A chat model whose stream explodes mid-turn (drives `on_chat_model_error`). */
class ExplodingChatModel extends ScriptedChatModel {
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    throw new Error("upstream model unavailable");
  }
}

function listTasksTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "list_tasks",
    description: "List tasks from a project",
    schema: z.object({ projectId: z.string() }),
    func: async (args) => JSON.stringify({ ok: true, projectId: args.projectId }),
  });
}

function throwingTool(message: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "list_tasks",
    description: "List tasks from a project",
    schema: z.object({ projectId: z.string() }),
    func: async () => {
      throw new Error(message);
    },
  });
}

async function collectFrames(
  graph: ReturnType<typeof createAgentGraph>,
  opts?: { modelId?: string; created?: number; id?: string },
): Promise<string[]> {
  const frames: string[] = [];
  for await (const frame of toOpenAiSse(
    graph.streamEvents({ messages: [new HumanMessage("hi")] }, { version: "v2" }),
    opts,
  )) {
    frames.push(frame);
  }
  return frames;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function finishReasonsIn(frames: string[]): Array<string | null> {
  return frames
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => {
      const payload = JSON.parse(frame.slice("data: ".length));
      return payload.choices?.[0]?.finish_reason ?? null;
    });
}

// Canonical golden fixtures from docs/wire-spec.md §7. Byte-exact, including
// the trailing `\n\n` on every frame.
const GOLDEN_7_1 =
  'data: {"id":"chatcmpl-001","object":"chat.completion.chunk","created":1726080000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

const GOLDEN_7_2 =
  'data: {"id":"chatcmpl-002","object":"chat.completion.chunk","created":1726080060,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9y3","type":"function","function":{"name":"search_web","arguments":""}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":"{\\"q\\":\\"dinner "}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":"recipes\\"}"}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  "data: [DONE]\n\n";

const GOLDEN_7_4 = "data: [DONE]\n\n";

// M4: REAL tool round-trip (tool executor runs, then a final answer) with a
// byte-exact wire sequence. Two parallel tool-call indices in the same turn:
//   - index 0 (`list_tasks`, a real bound tool) fragments `"" + {"projectId":
//     "p1" + "}"` — valid when concatenated, so the tool EXECUTES;
//   - index 1 (`search_web`) fragments `"" + "q":"dinner " + recipes"}"` — its
//     first NON-EMPTY fragment lacks the leading `{`, so the adapter's
//     normalization (§3.2) prepends it on the wire. The index-1 call is not in
//     the registry, but the adapter never executes anything — it only
//     translates stream deltas — so its normalized fragments still reach the
//     wire and concatenate into valid JSON.
// A final text answer follows, so the terminal chunk carries `"stop"`.
const GOLDEN_7_5 =
  'data: {"id":"chatcmpl-006","object":"chat.completion.chunk","created":1726080200,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"list_tasks","arguments":"{\\"projectId\\":\\"p1\\""}},{"index":1,"id":"call_1","type":"function","function":{"name":"search_web","arguments":""}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":"}"}},{"index":1,"type":"function","function":{"name":"","arguments":"{\\"q\\":\\"dinner "}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"type":"function","function":{"name":"","arguments":"recipes\\"}"}}]},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"Here"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":" you go"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

describe("transport — §7 golden fixtures (byte-exact)", () => {
  test("§7.1 simple text completion: stop, single [DONE], no mid-stream finish_reason", async () => {
    const model = new ScriptedChatModel({
      turns: [[{ content: "Hello" }, { content: " world" }, { content: "." }]],
    });
    const graph = createAgentGraph({ model, tools: [] });
    const frames = await collectFrames(graph, {
      modelId: "gpt-4o",
      created: 1726080000,
      id: "chatcmpl-001",
    });

    assert.equal(frames.join(""), GOLDEN_7_1);
    assert.equal(countOccurrences(frames.join(""), "data: [DONE]"), 1);

    const reasons = finishReasonsIn(frames);
    assert.deepEqual(reasons.slice(0, -1), [null, null, null], "no mid-stream finish_reason");
    assert.equal(reasons[reasons.length - 1], "stop");
  });

  test("§7.2 tool-call stream: tool_calls on the terminal chunk only, id/name on first fragment only", async () => {
    const model = new ScriptedChatModel({
      turns: [
        [
          { content: "", tool_call_chunks: [{ index: 0, id: "call_9y3", name: "search_web", args: "" }] },
          { content: "", tool_call_chunks: [{ index: 0, args: '{"q":"dinner ' }] },
          { content: "", tool_call_chunks: [{ index: 0, args: 'recipes"}' }] },
        ],
      ],
    });
    // maxIterations: 0 → an orchestrator that returns tool calls routes to END
    // instead of the tool executor, so the run terminates on the tool-call turn.
    const graph = createAgentGraph({ model, tools: [], maxIterations: 0 });
    const frames = await collectFrames(graph, {
      modelId: "gpt-4o",
      created: 1726080060,
      id: "chatcmpl-002",
    });

    assert.equal(frames.join(""), GOLDEN_7_2);
    assert.equal(countOccurrences(frames.join(""), "data: [DONE]"), 1);

    const toolPayloads = frames
      .filter((frame) => frame.includes("tool_calls"))
      .map((frame) => JSON.parse(frame.slice("data: ".length)));
    assert.equal(
      toolPayloads[0].choices[0].delta.tool_calls[0].id,
      "call_9y3",
      "id on the first fragment only",
    );
    assert.equal(
      toolPayloads[0].choices[0].delta.tool_calls[0].function.name,
      "search_web",
      "name on the first fragment only",
    );
    assert.ok(
      !("id" in toolPayloads[1].choices[0].delta.tool_calls[0]),
      "no id on later fragments",
    );
    assert.equal(toolPayloads[1].choices[0].delta.tool_calls[0].function.name, "");

    const reasons = finishReasonsIn(frames);
    assert.deepEqual(reasons.slice(0, -1), [null, null, null], "no finish_reason on deltas");
    assert.equal(reasons[reasons.length - 1], "tool_calls");
  });

  test("§7.4 empty completion: no finish chunk, just [DONE], finish_reason stays null", async () => {
    const model = new ScriptedChatModel({ turns: [[{ content: "" }]] });
    const graph = createAgentGraph({ model, tools: [] });
    const frames = await collectFrames(graph, {
      modelId: "gpt-4o",
      created: 1726080000,
      id: "chatcmpl-001",
    });

    assert.equal(frames.join(""), GOLDEN_7_4);
    assert.equal(countOccurrences(frames.join(""), "data: [DONE]"), 1);
    assert.equal(
      frames.filter((frame) => frame.includes("finish_reason")).length,
      0,
      "no finish chunk on the empty run",
    );
  });

  test("M4: real tool round-trip golden — fragmented args concatenate to valid JSON, normalization prepends the missing '{', terminal chunk is byte-exact", async () => {
    // index 0 is a REAL bound tool whose concatenated args parse, so the tool
    // executor runs and the orchestrator streams a final answer (the wire
    // proves the round trip: tool deltas → second-turn content → stop finish).
    const model = new ScriptedChatModel({
      turns: [
        [
          {
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call_0", name: "list_tasks", args: '{"projectId":"p1"' },
              { index: 1, id: "call_1", name: "search_web", args: "" },
            ],
          },
          {
            content: "",
            tool_call_chunks: [
              { index: 0, args: "}" },
              { index: 1, args: '"q":"dinner ' },
            ],
          },
          { content: "", tool_call_chunks: [{ index: 1, args: 'recipes"}' }] },
        ],
        [{ content: "Here" }, { content: " you go" }],
      ],
    });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });
    const frames = await collectFrames(graph, {
      modelId: "gpt-4o",
      created: 1726080200,
      id: "chatcmpl-006",
    });

    assert.equal(frames.join(""), GOLDEN_7_5, "byte-exact wire sequence");
    assert.equal(countOccurrences(frames.join(""), "data: [DONE]"), 1);

    // The concatenated tool arguments on the wire must parse as valid JSON for
    // BOTH indices — including index 1, whose first non-empty fragment had no
    // leading '{' (the adapter's normalizeArgsFragment prepended it).
    const argsByIndex = new Map<number, string>();
    for (const frame of frames) {
      if (!frame.includes("tool_calls")) continue;
      const payload = JSON.parse(frame.slice("data: ".length));
      const calls = payload.choices[0].delta.tool_calls as Array<{
        index: number;
        function: { arguments: string };
      }>;
      for (const call of calls) {
        argsByIndex.set(call.index, (argsByIndex.get(call.index) ?? "") + call.function.arguments);
      }
    }
    assert.deepEqual(JSON.parse(argsByIndex.get(0)!), { projectId: "p1" });
    assert.deepEqual(JSON.parse(argsByIndex.get(1)!), { q: "dinner recipes" });

    const reasons = finishReasonsIn(frames);
    assert.deepEqual(
      reasons.slice(0, -1),
      reasons.slice(0, -1).map(() => null),
      "no finish_reason on any delta frame",
    );
    assert.equal(reasons[reasons.length - 1], "stop", "finish stop after the real round trip");
    assert.equal(frames[frames.length - 1], DONE_FRAME);
  });

  test("no LangGraph internals leak onto the wire (Appendix A)", async () => {
    const model = new ScriptedChatModel({ turns: [[{ content: "hello" }]] });
    const graph = createAgentGraph({ model, tools: [] });
    const frames = await collectFrames(graph);

    const wire = frames.join("");
    assert.equal(wire.includes("on_chat_model"), false, "no on_* event names");
    assert.equal(wire.includes("run_id"), false, "no run ids");
    assert.equal(wire.match(/"event"/), null, "no event field");
    const first = JSON.parse(frames[0]!.slice("data: ".length));
    assert.equal(first.object, "chat.completion.chunk");
    assert.ok(first.id.startsWith("chatcmpl-"), "default id is chatcmpl-<random>");
  });
});

describe("transport — errors (§5.2)", () => {
  test("tool error mid-stream: one §3.4 envelope (tool_error) then [DONE], no finish chunk", async () => {
    const model = new ScriptedChatModel({
      turns: [
        [
          { content: "Let me check" },
          { content: " that for you" },
          {
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
            ],
          },
        ],
      ],
    });
    const graph = createAgentGraph({ model, tools: [throwingTool("web fetch failed: connection refused")] });
    const frames = await collectFrames(graph, {
      modelId: "gpt-4o",
      created: 1726080120,
      id: "chatcmpl-003",
    });

    assert.ok(frames.length >= 4, "content deltas + error + [DONE]");
    const errorFrameIndex = frames.findIndex((frame) => frame.includes('"error"'));
    assert.ok(errorFrameIndex >= 0, "an error envelope was emitted");
    assert.deepEqual(JSON.parse(frames[errorFrameIndex]!.slice("data: ".length)), {
      error: {
        message: "web fetch failed: connection refused",
        type: "tool_error",
        code: "tool_execution_failed",
      },
    });
    assert.equal(frames[frames.length - 1], DONE_FRAME);
    assert.equal(countOccurrences(frames.join(""), '"error"'), 1, "exactly one error frame");
    assert.equal(
      frames.slice(errorFrameIndex).some((frame) => frame.includes("finish_reason")),
      false,
      "no finish chunk after an error frame",
    );
  });

  test("model error mid-stream: one model_error envelope then [DONE]", async () => {
    // langgraph v2's stream tracer has no onLLMError handler, so an
    // `on_chat_model_error` event cannot be produced by a real graph run. The
    // mapping itself is exercised here with a synthetic event stream; the
    // real-world equivalent (a model throwing mid-run) is covered by the
    // "unrecoverable run failure" test below.
    const events = async function* (): AsyncGenerator<StreamEvent, void, unknown> {
      yield {
        event: "on_chain_start",
        name: "LangGraph",
        run_id: "root-1",
        metadata: {},
        data: {},
      };
      yield {
        event: "on_chat_model_error",
        name: "ScriptedChatModel",
        run_id: "run-1",
        metadata: {},
        data: { error: new Error("upstream model unavailable") },
      };
    };

    const frames: string[] = [];
    for await (const frame of toOpenAiSse(events())) {
      frames.push(frame);
    }

    const errorFrameIndex = frames.findIndex((frame) => frame.includes('"error"'));
    assert.deepEqual(JSON.parse(frames[errorFrameIndex]!.slice("data: ".length)), {
      error: { message: "upstream model unavailable", type: "model_error" },
    });
    assert.equal(frames[frames.length - 1], DONE_FRAME);
    assert.equal(
      frames.slice(errorFrameIndex).some((frame) => frame.includes("finish_reason")),
      false,
      "no finish chunk after an error frame",
    );
  });

  test("unrecoverable run failure: server_error envelope then [DONE] (safety net, I4)", async () => {
    // A model that throws mid-stream makes langgraph abort the run: the stream
    // iterator throws without delivering any error event. The adapter must
    // still terminate the stream with an envelope + [DONE] (§5.2, I4).
    const model = new ExplodingChatModel({ turns: [[{ content: "hello" }]] });
    const graph = createAgentGraph({ model, tools: [] });
    const frames = await collectFrames(graph);

    const errorFrameIndex = frames.findIndex((frame) => frame.includes('"error"'));
    assert.deepEqual(JSON.parse(frames[errorFrameIndex]!.slice("data: ".length)), {
      error: { message: "upstream model unavailable", type: "server_error" },
    });
    assert.equal(frames[frames.length - 1], DONE_FRAME);
    assert.equal(countOccurrences(frames.join(""), '"error"'), 1, "exactly one error frame");
  });

  test("error messages are redacted (Bearer tokens masked, no key material on the wire)", async () => {
    const model = new ScriptedChatModel({
      turns: [
        [
          {
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
            ],
          },
        ],
      ],
    });
    const graph = createAgentGraph({
      model,
      tools: [throwingTool("auth failed: Bearer sk-abc123xyz789")],
    });
    const frames = await collectFrames(graph);

    const errorFrameIndex = frames.findIndex((frame) => frame.includes('"error"'));
    const error = JSON.parse(frames[errorFrameIndex]!.slice("data: ".length)).error;
    assert.equal(error.message.includes("sk-abc123xyz789"), false, "key material masked");
    assert.equal(error.message.includes("Bearer ***"), true, "redaction marker applied");
  });
});

describe("transport — sticky finish across model turns (§4/§6)", () => {
  test("orchestrator turn streams deltas with no finish_reason; the final turn decides", async () => {
    const model = new ScriptedChatModel({
      turns: [
        [
          { content: "Let me look" },
          { content: " that up" },
          {
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
            ],
          },
        ],
        [{ content: "Here" }, { content: " you go" }],
      ],
    });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });
    const frames = await collectFrames(graph);

    // Two model turns, one finish chunk before [DONE]; deltas never carry a
    // non-null finish_reason even across turns (I2).
    const reasons = finishReasonsIn(frames);
    assert.ok(reasons.length >= 3, "delta frames plus the terminal chunk");
    assert.deepEqual(
      reasons.slice(0, -1),
      reasons.slice(0, -1).map(() => null),
      "no non-null finish_reason on any delta frame",
    );
    assert.equal(reasons[reasons.length - 1], "stop", "exactly one finish_reason: the terminal chunk");
    assert.equal(frames[frames.length - 1], DONE_FRAME);
  });

  test("provider tool_calls finish on an intermediate turn is sticky (§4)", async () => {
    const model = new ScriptedChatModel({
      turns: [
        [
          { content: "Calling" },
          {
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
            ],
            response_metadata: { finish_reason: "tool_calls" },
          },
        ],
        [{ content: "Done" }],
      ],
    });
    const graph = createAgentGraph({ model, tools: [listTasksTool()] });
    const frames = await collectFrames(graph);

    const reasons = finishReasonsIn(frames);
    assert.equal(reasons[reasons.length - 1], "tool_calls", "sticky finish survives the final turn");
    assert.equal(
      reasons.filter((r) => r !== null).length,
      1,
      "finish_reason still appears exactly once",
    );
  });
});

describe("transport — pure helpers", () => {
  test("finishReasonFromOutput: complete tool calls → tool_calls, text → stop, empty → null", () => {
    assert.equal(finishReasonFromOutput(new AIMessage({ content: "hello" })), "stop");
    assert.equal(
      finishReasonFromOutput(new AIMessage({ content: "" })),
      null,
      "empty run → null",
    );
    assert.equal(
      finishReasonFromOutput(
        new AIMessage({
          content: "",
          tool_calls: [{ name: "search_web", args: { q: "x" }, id: "call_1", type: "tool_call" }],
        }),
      ),
      "tool_calls",
    );
    assert.equal(finishReasonFromOutput(undefined), null);
    assert.equal(finishReasonFromOutput(null), null);
    assert.equal(
      finishReasonFromOutput({ content: "", tool_calls: [{ name: "search_web", args: {} }] }),
      "stop",
      "incomplete args are not a tool_calls finish",
    );
    assert.equal(
      finishReasonFromOutput({ content: "", tool_calls: [{ name: "", args: { q: "x" } }] }),
      "stop",
      "missing name is not a tool_calls finish",
    );
    assert.equal(
      finishReasonFromOutput({
        content: [{ type: "text", text: "hi" }],
      }),
      "stop",
      "array text blocks count as content",
    );
    assert.equal(
      finishReasonFromOutput({
        content: [{ type: "image", image: "data:..." }],
      }),
      null,
      "non-text blocks are not content",
    );
  });

  test("errorFrame: message/type required, code optional (§3.4)", () => {
    assert.equal(
      errorFrame("boom", "tool_error", "tool_execution_failed"),
      'data: {"error":{"message":"boom","type":"tool_error","code":"tool_execution_failed"}}\n\n',
    );
    assert.equal(
      errorFrame("boom", "server_error"),
      'data: {"error":{"message":"boom","type":"server_error"}}\n\n',
    );
    assert.equal(errorFrame("boom", "server_error", "upstream_model_unavailable"),
      'data: {"error":{"message":"boom","type":"server_error","code":"upstream_model_unavailable"}}\n\n');
  });

  test("finishFrame renders the §3.3 terminal chunk; DONE_FRAME is the literal terminator", () => {
    assert.equal(
      finishFrame("stop"),
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    assert.equal(
      finishFrame("tool_calls"),
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    );
    assert.equal(DONE_FRAME, "data: [DONE]\n\n");
  });
});

describe("transport — degenerate terminator handling (L8/L9)", () => {
  test("L8: when the finish chunk is the FIRST frame (content but zero streamed deltas) it still carries the id/object/created/model envelope", async () => {
    const events = async function* (): AsyncGenerator<StreamEvent, void, unknown> {
      yield {
        event: "on_chain_start",
        name: "LangGraph",
        run_id: "root-1",
        metadata: {},
        data: {},
      };
      // A run whose final state has content but whose model turn produced no
      // streamed deltas — the finish chunk is the first (and only) frame.
      yield {
        event: "on_chain_end",
        name: "LangGraph",
        run_id: "root-1",
        metadata: {},
        data: {
          output: { messages: [{ type: "ai", content: "hello" }] },
        },
      };
    };

    const frames: string[] = [];
    for await (const frame of toOpenAiSse(events(), {
      modelId: "gpt-4o",
      created: 1726080300,
      id: "chatcmpl-007",
    })) {
      frames.push(frame);
    }

    assert.equal(frames.length, 2, "finish chunk + [DONE]");
    assert.deepEqual(JSON.parse(frames[0]!.slice("data: ".length)), {
      id: "chatcmpl-007",
      object: "chat.completion.chunk",
      created: 1726080300,
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    assert.equal(frames[1], DONE_FRAME);
  });

  test("L9: an iterable that exhausts without root termination still ends with a stop finish chunk + exactly one [DONE]", async () => {
    const events = async function* (): AsyncGenerator<StreamEvent, void, unknown> {
      yield {
        event: "on_chain_start",
        name: "LangGraph",
        run_id: "root-1",
        metadata: {},
        data: {},
      };
      yield {
        event: "on_chat_model_stream",
        name: "ScriptedChatModel",
        run_id: "run-1",
        metadata: {},
        data: { chunk: { content: "partial" } },
      };
      // generator ends — no root on_chain_end/error, no throw.
    };

    const frames: string[] = [];
    for await (const frame of toOpenAiSse(events(), {
      modelId: "gpt-4o",
      created: 1726080300,
      id: "chatcmpl-008",
    })) {
      frames.push(frame);
    }

    assert.deepEqual(
      frames.map((f) => (f === DONE_FRAME ? "DONE" : JSON.parse(f.slice("data: ".length)).choices[0].delta)),
      [
        { content: "partial" },
        {},
        "DONE",
      ],
    );
    assert.equal(
      frames[1]!.includes('"finish_reason":"stop"'),
      true,
      "the guaranteed terminator is a stop finish chunk",
    );
    assert.equal(countOccurrences(frames.join(""), "data: [DONE]"), 1, "exactly one [DONE]");
    assert.equal(frames[frames.length - 1], DONE_FRAME);
  });

  test("L9: the safety-net error path still yields exactly one [DONE] (no double terminator)", async () => {
    const events = async function* (): AsyncGenerator<StreamEvent, void, unknown> {
      yield {
        event: "on_chain_start",
        name: "LangGraph",
        run_id: "root-1",
        metadata: {},
        data: {},
      };
      yield {
        event: "on_chat_model_stream",
        name: "ScriptedChatModel",
        run_id: "run-1",
        metadata: {},
        data: { chunk: { content: "partial" } },
      };
      throw new Error("boom");
    };

    const frames: string[] = [];
    for await (const frame of toOpenAiSse(events())) {
      frames.push(frame);
    }

    const errorFrameIndex = frames.findIndex((frame) => frame.includes('"error"'));
    assert.ok(errorFrameIndex >= 0, "an error envelope was emitted");
    assert.equal(
      countOccurrences(frames.join(""), "data: [DONE]"),
      1,
      "the error path must not double-terminate",
    );
    assert.equal(frames[frames.length - 1], DONE_FRAME);
  });
});