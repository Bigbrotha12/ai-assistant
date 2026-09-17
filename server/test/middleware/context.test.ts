import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  ContextBudgetError,
  createContextManager,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  truncatePairAware,
} from "../../src/middleware/context.ts";
import type { ContextGraph } from "../../src/middleware/context.ts";

function toolPair(id: string, content = "result") {
  return [
    new AIMessage({ content: "", tool_calls: [{ name: "lookup", args: { query: "x" }, id, type: "tool_call" }] }),
    new ToolMessage({ content, tool_call_id: id }),
  ];
}

describe("context token estimation", () => {
  test("counts structured content and tool arguments instead of object coercion", () => {
    const content = [{ type: "text" as const, text: "x".repeat(1000) }];
    assert.equal(estimateTokens(content), Math.ceil(JSON.stringify(content).length / 4));
    assert.equal(estimateMessageTokens(new HumanMessage({ content })), estimateTokens(content));
    const tool_calls = [{ name: "lookup", args: { query: "x".repeat(2000) }, id: "call", type: "tool_call" as const }];
    assert.equal(estimateMessageTokens(new AIMessage({ content: "", tool_calls })), estimateTokens(tool_calls));
    assert.equal(estimateMessageTokens({ content: "", tool_calls }), estimateTokens(tool_calls));
    assert.ok(estimateMessageTokens(new AIMessage({ content: "", additional_kwargs: { tool_calls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "x".repeat(2000) } }] } })) > 500);
  });
});

describe("pair-aware deterministic request trimming", () => {
  test("retains fitting history unchanged without mutating input", () => {
    const messages = [new HumanMessage("old"), ...toolPair("one"), new HumanMessage("new")];
    const result = truncatePairAware(messages, estimateMessagesTokens(messages));
    assert.deepEqual(result, messages);
    assert.notEqual(result, messages);
  });

  test("drops complete older turns, not a tool result or caller in isolation", () => {
    const old = [new HumanMessage("old".repeat(100)), ...toolPair("one")];
    const live = new HumanMessage("live");
    const messages = [...old, live];
    const limit = estimateMessagesTokens(messages) - 1;
    assert.deepEqual(truncatePairAware(messages, limit), [live]);
    assert.deepEqual(truncatePairAware(messages, limit), truncatePairAware(messages, limit));
  });

  test("keeps fixed system instructions and live user while evicting oversized tool groups", () => {
    const system = new SystemMessage("fixed");
    const live = new HumanMessage("live");
    const recent = toolPair("recent", "ok");
    const messages = [system, live, ...toolPair("large", "x".repeat(10000)), ...recent];
    const limit = estimateMessagesTokens([system, live, ...recent]);
    assert.deepEqual(truncatePairAware(messages, limit), [system, live, ...recent]);
    assert.ok(estimateMessagesTokens(truncatePairAware(messages, limit)) <= limit);
    assert.deepEqual(truncatePairAware(messages, estimateMessagesTokens([system, live])), [system, live]);
  });

  test("parallel calls remain atomic even when results arrive in reverse order", () => {
    const live = new HumanMessage("live");
    const caller = new AIMessage({ content: "", tool_calls: [
      { name: "lookup", args: {}, id: "a", type: "tool_call" },
      { name: "lookup", args: {}, id: "b", type: "tool_call" },
    ] });
    const messages = [live, caller, new ToolMessage({ content: "b", tool_call_id: "b" }), new ToolMessage({ content: "a", tool_call_id: "a" })];
    assert.deepEqual(truncatePairAware(messages, estimateMessagesTokens(messages)), messages);
    assert.deepEqual(truncatePairAware(messages, estimateMessagesTokens(messages) - 1), [live]);
  });

  test("oversized live input fails explicitly including the system allowance", () => {
    const live = new HumanMessage("x".repeat(100));
    assert.throws(() => truncatePairAware([live], 24), ContextBudgetError);
    assert.throws(() => truncatePairAware([new SystemMessage("system"), live], 25), (error: unknown) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.code, "context_length_exceeded");
      assert.equal(error.estimatedTokens, 27);
      return true;
    });
    assert.throws(() => createContextManager({ limitTokens: 10 }).truncateSeed([live]), ContextBudgetError);
  });

  test("rejects malformed pairing even when the content fits", () => {
    assert.throws(() => truncatePairAware([new ToolMessage({ content: "orphan", tool_call_id: "a" })], 100), /unmatched tool result/);
    assert.throws(() => truncatePairAware([toolPair("a")[0]!, new HumanMessage("next")], 100), /unmatched tool call/);
    assert.throws(() => truncatePairAware([toolPair("a")[0]!, toolPair("b")[1]!], 100), /unmatched tool call/);
  });

  test("validates budgets and never returns an over-budget no-user history", () => {
    for (const limit of [NaN, Infinity, -1, 1.5]) {
      assert.throws(() => createContextManager({ limitTokens: limit }), RangeError);
      assert.throws(() => truncatePairAware([], limit), RangeError);
    }
    assert.deepEqual(truncatePairAware([new AIMessage("large")], 0), []);
    assert.deepEqual(truncatePairAware([], 0), []);
  });
});

describe("one-time checkpoint compaction", () => {
  test("skips pending tools and never manually writes a legacy checkpointer", async () => {
    let writes = 0;
    const graph: ContextGraph = {
      getState: async () => ({ values: { messages: [new HumanMessage("old".repeat(100))] }, next: ["toolExecutor"], config: {} }),
      updateState: async () => { writes++; return {}; },
    };
    const context = createContextManager({ limitTokens: 10 });
    await context.maybeCompactAfterStream({ graph, owner: "owner", clientThreadId: "client", threadId: "thread", lockHeld: true });
    await context.maybeCompactAfterStream({ owner: "owner", clientThreadId: "client", threadId: "thread", lockHeld: true });
    assert.equal(writes, 0);
  });

  test("does not overwrite a checkpoint that advanced during preparation", async () => {
    let reads = 0;
    let writes = 0;
    const graph: ContextGraph = {
      getState: async () => ({
        values: { messages: [new HumanMessage("old".repeat(100)), new HumanMessage("live")] },
        next: [], config: { configurable: { checkpoint_id: String(++reads) } },
      }),
      updateState: async () => { writes++; return {}; },
    };
    await createContextManager({ limitTokens: 10 }).maybeCompactAfterStream({ graph, owner: "owner", clientThreadId: "client", threadId: "thread", lockHeld: true });
    assert.equal(reads, 2);
    assert.equal(writes, 0);
  });

  test("checkpoint failures stay best effort", async () => {
    const graph: ContextGraph = {
      getState: async () => { throw new Error("unavailable"); },
      updateState: async () => { throw new Error("never"); },
    };
    await createContextManager({ limitTokens: 10 }).maybeCompactAfterStream({ graph, owner: "owner", clientThreadId: "client", threadId: "thread", lockHeld: true });
  });
});
