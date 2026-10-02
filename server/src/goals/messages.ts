import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import type { AppendGoalMessageInput } from "./ledger.ts";
import type { GoalMessageRow } from "./types.ts";

/**
 * `goal_message` rows -> LangChain messages (Phase 3.1). The goal loop runs
 * without a checkpointer: every step rebuilds its input vector from the
 * durable log (plan §Step lifecycle / waves 3.1 "step input vector"), so this
 * mapping IS the round-trip partner of the runner's `appendGoalMessage`
 * bookkeeping ({@link goalMessageToAppendInput}).
 *
 * Stored shapes (what the runner persists):
 *   - `content_json` — `JSON.stringify(content)`: a string stays a string, an
 *     object becomes a text content part (`[{ type: "text", text: ... }]`), an
 *     array passes through as content blocks;
 *   - `tool_calls_json` — `JSON.stringify(message.tool_calls)`, LangChain's
 *     `{ name, args, id, type: "tool_call" }` objects; the OpenAI-ish
 *     `{ id, function: { name, arguments } }` shape is accepted defensively
 *     (mirroring `toLangChainMessages`' normalization at
 *     `transport/chat.ts:2483`);
 *   - `tool_call_id` — the tool row's owning call id.
 *
 * Malformed JSON NEVER throws into the runner: a bad `content_json` falls
 * back to its raw text, a bad `tool_calls_json` degrades to a tool-less
 * assistant message, and a row whose message cannot be constructed at all is
 * SKIPPED (logged, never fatal).
 */

/** LangChain `tool_calls` entry shape (`AIMessage.tool_calls`). */
type GoalToolCall = { name: string; args: Record<string, unknown>; id: string; type: "tool_call" };

/**
 * Rebuilds the step input vector from the durable log. Rows are consumed in
 * `seq` order (callers pass `listGoalMessages` output).
 */
export function goalMessagesToBaseMessages(rows: GoalMessageRow[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const row of rows) {
    try {
      const content = contentFromJson(row.content_json);
      switch (row.role) {
        case "user":
          out.push(new HumanMessage({ content: content as string }));
          break;
        case "assistant": {
          const toolCalls = toolCallsFromJson(row.tool_calls_json);
          out.push(
            new AIMessage({
              content: content as string,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            }),
          );
          break;
        }
        case "tool":
          out.push(
            new ToolMessage({
              content: textContentFromJson(row.content_json),
              tool_call_id: row.tool_call_id ?? `tool_call_${row.seq}`,
            }),
          );
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn(
        `[goals] skipping malformed goal_message seq ${row.seq} of ${row.goal_id}:`,
        err,
      );
    }
  }
  return out;
}

/**
 * Persist mapping for one produced message (the runner's token-guarded
 * bookkeeping step). Returns null for message types the goal log has no role
 * for (e.g. `SystemMessage` — the system prompt is applied per step by
 * `createAgentGraph`, never persisted).
 */
export function goalMessageToAppendInput(
  message: BaseMessage,
): AppendGoalMessageInput | null {
  if (message instanceof AIMessage) {
    const toolCalls = message.tool_calls ?? [];
    return {
      role: "assistant",
      content: message.content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
  if (message instanceof ToolMessage) {
    return {
      role: "tool",
      content: message.content,
      toolCallId: message.tool_call_id,
    };
  }
  if (message instanceof HumanMessage) {
    return { role: "user", content: message.content };
  }
  return null;
}

/**
 * `content_json` -> message content. A parsed string stays a string; a parsed
 * array passes through as content blocks; a parsed object becomes a text
 * content part. Unparseable JSON falls back to the RAW stored text (a
 * message is never dropped for a serialization hiccup).
 */
function contentFromJson(json: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) return parsed;
  return [{ type: "text", text: JSON.stringify(parsed) }];
}

/** Tool rows carry plain text; structured content is stringified. */
function textContentFromJson(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}

/**
 * `tool_calls_json` -> LangChain `tool_calls`. Accepts the stored LangChain
 * shape and the OpenAI-ish shape; malformed or empty input yields `[]` (the
 * assistant message degrades to a tool-less one, never throws).
 */
function toolCallsFromJson(json: string | null): GoalToolCall[] {
  if (json === null || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GoalToolCall[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn =
      typeof record["function"] === "object" && record["function"] !== null
        ? (record["function"] as Record<string, unknown>)
        : undefined;
    const name =
      typeof record["name"] === "string" && record["name"] !== ""
        ? record["name"]
        : typeof fn?.["name"] === "string"
          ? (fn["name"] as string)
          : "";
    if (name === "") continue;
    out.push({
      name,
      args: toolArgsFrom(record["args"] ?? fn?.["arguments"]),
      id:
        typeof record["id"] === "string" && record["id"] !== ""
          ? (record["id"] as string)
          : `call_${i}`,
      type: "tool_call",
    });
  }
  return out;
}

/** Tool arguments must be an OBJECT for LangChain (never a raw JSON string). */
function toolArgsFrom(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}
