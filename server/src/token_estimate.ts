import type { BaseMessage } from "@langchain/core/messages";

/**
 * The gateway's ONE chars/4 token heuristic (Phase 7.1). Every pre-flight
 * estimate — skill-injection budget (`agents/skills.ts`) and the goal runner's
 * context guard (`goals/runner.ts`) — goes through this module so the two
 * cannot drift apart. It is deliberately approximate: the client owns exact
 * accounting, the gateway only needs a cheap upper-ish bound before it spends a
 * model call.
 *
 * Scope / non-goals: the goal runner's guard estimates the message vector PLUS
 * the agent's `systemPrompt` (both are real model input) and deliberately does
 * NOT include bound tool SCHEMAS. Schemas are bounded separately by the goal's
 * tool allowlist and the MCP tool-list byte cap, and the provider-side
 * `ContextBudgetError` remains the backstop at the model's real context
 * boundary. Adding schemas here would double-count a surface that already has
 * its own limit.
 */

/**
 * Estimate tokens for a single string as `ceil(length / 4)`. Non-string
 * content (LangChain content blocks, tool-call argument objects) is measured
 * by its JSON serialization so a structured payload is never free.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sum the estimate over a rebuilt message vector: each message contributes its
 * content (chars/4, or JSON length/4 for non-string content) plus, when
 * present, its `tool_calls` JSON length/4. Tool-call arguments are real model
 * input every round, so leaving them out would under-count exactly the turns
 * that grow fastest.
 */
export function estimateMessagesTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateContentTokens(message.content);
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      total += estimateSerializedTokens(toolCalls);
    }
  }
  return total;
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (content === null || content === undefined) return 0;
  return estimateSerializedTokens(content);
}

function estimateSerializedTokens(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 0;
  }
  return typeof serialized === "string" ? estimateTokens(serialized) : 0;
}
