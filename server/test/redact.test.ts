import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { CREDENTIAL_REDACTION } from "../src/plugins/credential.ts";
import {
  redactForOutbound,
  redactMessageContent,
  redactMessages,
} from "../src/redact.ts";

const RANDOM_PART = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PRODUCTION_KEY = `sk${RANDOM_PART}`;
const MASKED_KEY = `sk-${CREDENTIAL_REDACTION}`;
const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(32)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"b".repeat(32)}`;
const PROJECT_KEY = `sk-proj-${"c".repeat(32)}`;
const VIKUNJA_TOKEN = `tok-${"d".repeat(32)}`;

describe("redactForOutbound", () => {
  test("redacts the production no-separator key shape", () => {
    assert.equal(redactForOutbound(PRODUCTION_KEY), MASKED_KEY);
  });

  test("redacts the configured hyphen and underscore key shapes", () => {
    assert.equal(redactForOutbound(`sk-${RANDOM_PART}`), MASKED_KEY);
    assert.equal(redactForOutbound(`sk_${RANDOM_PART}`), MASKED_KEY);
  });

  test("does not redact short sk strings or ordinary words", () => {
    const shortPart = "AbCdEfGhIjKlMnOpQr";
    const input = `sk${shortPart} sk-${shortPart} sk_${shortPart} skate sketch skill`;
    assert.equal(redactForOutbound(input), input);
  });

  test("redacts documented provider and tool credential formats", () => {
    assert.equal(redactForOutbound(OPENROUTER_KEY), "sk-or-v1-***");
    assert.equal(redactForOutbound(ANTHROPIC_KEY), "sk-ant-api03-***");
    assert.equal(redactForOutbound(PROJECT_KEY), "sk-proj-***");
    assert.equal(redactForOutbound(VIKUNJA_TOKEN), "tok-***");
  });

  test("does not over-redact ordinary words with documented prefixes", () => {
    const input = "sk-or-v1-example sk-ant-api03-help sk-proj-example tok-example";
    assert.equal(redactForOutbound(input), input);
  });

  test("documented-format redaction is idempotent", () => {
    for (const value of [OPENROUTER_KEY, ANTHROPIC_KEY, PROJECT_KEY, VIKUNJA_TOKEN]) {
      const once = redactForOutbound(value);
      assert.equal(redactForOutbound(once), once);
    }
  });

  test("requires a token boundary around the key shape", () => {
    const input = `prefix=${PRODUCTION_KEY}; suffix=x${PRODUCTION_KEY}`;
    assert.equal(redactForOutbound(input), `prefix=${MASKED_KEY}; suffix=x${PRODUCTION_KEY}`);
  });

  test("is idempotent", () => {
    const input = `before ${PRODUCTION_KEY} after`;
    const once = redactForOutbound(input);
    assert.equal(redactForOutbound(once), once);
  });

  test("continues to redact Bearer authorization values", () => {
    assert.equal(
      redactForOutbound(`Authorization: Bearer ${PRODUCTION_KEY}`),
      "Authorization: Bearer ***",
    );
  });
});

describe("redactMessageContent", () => {
  test("redacts every text-bearing block while preserving content shape", () => {
    const imageUrl = { url: "data:image/png;base64,unchanged" };
    const content: BaseMessage["content"] = [
      { type: "text", text: `first ${PRODUCTION_KEY}`, index: 0 },
      { type: "text", text: `second sk-${RANDOM_PART}`, index: 1 },
      { type: "reasoning", reasoning: "Bearer opaque-provider-token", index: 2 },
      { type: "image_url", image_url: imageUrl },
    ];

    const redacted = redactMessageContent(content);

    assert.deepEqual(redacted, [
      { type: "text", text: `first ${MASKED_KEY}`, index: 0 },
      { type: "text", text: `second ${MASKED_KEY}`, index: 1 },
      { type: "reasoning", reasoning: "Bearer ***", index: 2 },
      { type: "image_url", image_url: imageUrl },
    ]);
  });

  test("is idempotent for already-redacted structured content", () => {
    const content: BaseMessage["content"] = [
      { type: "text", text: `key ${MASKED_KEY}` },
      { type: "reasoning", reasoning: "Bearer ***" },
    ];
    const once = redactMessageContent(content);
    assert.deepEqual(redactMessageContent(once), once);
  });
});

describe("redactMessages", () => {
  test("deep-redacts content, tool arguments, and persisted metadata without changing message identity", () => {
    const toolCall = {
      id: "call-1",
      name: "lookup",
      type: "tool_call" as const,
      args: {
        nested: { token: VIKUNJA_TOKEN },
        note: "ordinary argument",
      },
    };
    const message = new AIMessage({
      content: [
        { type: "thinking", thinking: `private ${ANTHROPIC_KEY}` },
        { type: "text", text: `answer ${OPENROUTER_KEY}` },
      ] as unknown as BaseMessage["content"],
      id: "message-1",
      name: "assistant",
      tool_calls: [toolCall],
      additional_kwargs: { audit: { value: PROJECT_KEY } },
      response_metadata: { model_name: "scripted", created: 123 },
      usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    const toolMessage = new ToolMessage({
      content: "tool output",
      tool_call_id: "call-1",
      metadata: { detail: { value: VIKUNJA_TOKEN } },
      artifact: { raw: ANTHROPIC_KEY },
      status: "success",
    });

    const redacted = redactMessages([message, toolMessage]);

    assert.notEqual(redacted[0], message);
    assert.equal(redacted[0] instanceof AIMessage, true);
    const assistant = redacted[0] as AIMessage;
    assert.equal(assistant.id, "message-1");
    assert.equal(assistant.name, "assistant");
    assert.deepEqual(assistant.usage_metadata, {
      input_tokens: 2,
      output_tokens: 3,
      total_tokens: 5,
    });
    assert.deepEqual(assistant.response_metadata, { model_name: "scripted", created: 123 });
    assert.equal(assistant.tool_calls?.[0]?.id, "call-1");
    assert.equal(assistant.tool_calls?.[0]?.name, "lookup");
    assert.deepEqual(assistant.tool_calls?.[0]?.args, {
      nested: { token: "tok-***" },
      note: "ordinary argument",
    });
    assert.deepEqual(assistant.additional_kwargs, { audit: { value: "sk-proj-***" } });
    assert.deepEqual(assistant.content, [
      { type: "thinking", thinking: "private sk-ant-api03-***" },
      { type: "text", text: "answer sk-or-v1-***" },
    ]);
    assert.equal(redacted[1] instanceof ToolMessage, true);
    const tool = redacted[1] as ToolMessage;
    assert.equal(tool.tool_call_id, "call-1");
    assert.equal(tool.status, "success");
    assert.deepEqual(tool.metadata, { detail: { value: "tok-***" } });
    assert.deepEqual(tool.artifact, { raw: "sk-ant-api03-***" });
    assert.equal(toolCall.args.nested.token, VIKUNJA_TOKEN, "input message is not mutated");
  });

  test("is idempotent for assembled messages", () => {
    const message = new AIMessage({
      content: [{ type: "reasoning", reasoning: ANTHROPIC_KEY }],
      id: "message-2",
      tool_calls: [{ id: "call-2", name: "lookup", args: { token: VIKUNJA_TOKEN } }],
    });
    const once = redactMessages([message]);
    const twice = redactMessages(once);
    assert.deepEqual(twice.map((entry) => entry.toDict()), once.map((entry) => entry.toDict()));
  });
});
