import { randomBytes } from "node:crypto";
import { redactForCheckpoint } from "../checkpoints/store.ts";
import { BudgetExhaustedError } from "../middleware/budget.ts";
import { ContextBudgetError } from "../middleware/context.ts";

function exhaustionCode(error: unknown): string | undefined {
  return error instanceof BudgetExhaustedError || error instanceof ContextBudgetError
    ? error.code
    : undefined;
}

/**
 * OpenAI-compatible SSE adapter (Phase 3, Wave A).
 *
 * Translates a LangGraph `streamEvents(..., { version: "v2" })` async iterable
 * into OpenAI chat-completions SSE frames, byte-exactly per `docs/wire-spec.md`
 * (§6 mapping table, §3.3 finish chunk, §3.4 error envelope, §4 sticky finish,
 * §7 canonical frame sequences).
 *
 * Contract highlights implemented here:
 * - Every yielded string is ONE complete `data: <json>\n\n` frame.
 * - Exactly one `data: [DONE]\n\n` terminator; `finish_reason` appears only on
 *   the terminal chunk (no mid-stream finish_reason).
 * - The finish chunk + `[DONE]` are emitted ONLY at the root `on_chain_end`.
 *   Intermediate model turns stream deltas with no terminator.
 * - The empty run (no content, no tool deltas) yields only `[DONE]`, with the
 *   finish reason staying `null` (§7.4).
 * - Errors (`on_chat_model_error` / `on_tool_error` / root `on_chain_error`)
 *   yield ONE error envelope frame then `[DONE]`; no finish chunk after.
 * - Nothing LangGraph-internal ever reaches the wire (Appendix A).
 */

export const DONE_FRAME = "data: [DONE]\n\n";

/** Normalized finish-reason set (§4): only these three values exist on the wire. */
export type FinishReason = "stop" | "tool_calls" | null;

/** Structural subset of the LangGraph v2 stream event (`StreamEvent`). */
export type StreamEventData = {
  input?: unknown;
  output?: unknown;
  chunk?: unknown;
  error?: unknown;
};

/** Structural subset of the LangGraph v2 stream event. */
export type StreamEvent = {
  event: string;
  name: string;
  run_id: string;
  tags?: string[];
  metadata: Record<string, unknown>;
  data: StreamEventData;
};

export type ToOpenAiSseOptions = {
  onOutcome?: (outcome: "succeeded" | "failed") => void;
  /** Model name echoed on the first chunk (request value or server default). */
  modelId?: string;
  /** Epoch seconds echoed on the first chunk. Defaults to `Date.now() / 1000`. */
  created?: number;
  /** Completion id (`chatcmpl-…`) echoed on the first chunk. Defaults to a random one. */
  id?: string;
};

const DEFAULT_MODEL = "langchain-agent";
const ERROR_TYPE_MODEL = "model_error";
const ERROR_TYPE_TOOL = "tool_error";
const ERROR_TYPE_SERVER = "server_error";
const TOOL_ERROR_CODE = "tool_execution_failed";

type AssistantOutput = {
  content?: unknown;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
};

type Envelope = { id: string; created: number; model: string };

type ToolCallMeta = {
  id: string;
  name: string;
  firstEmitted: boolean;
  accumulatedArgs: string;
};

/** Render one frame: a single `data:` line followed by a blank line. */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Shared chat.completion.chunk envelope. The first content/tool frame carries
 * `id`/`object`/`created`/`model`; subsequent frames omit them (§2).
 */
function choiceFrame(
  delta: Record<string, unknown>,
  envelope?: Envelope,
): Record<string, unknown> {
  if (envelope === undefined) {
    return { choices: [{ index: 0, delta, finish_reason: null }] };
  }
  return {
    id: envelope.id,
    object: "chat.completion.chunk",
    created: envelope.created,
    model: envelope.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/**
 * The §3.3 finish chunk: empty delta, `finish_reason` on the terminal chunk.
 * L8: when the finish chunk is the FIRST frame emitted (a degenerate run with
 * content but zero streamed deltas) it must still carry the id/object/created/
 * model envelope, so it takes the same `takeEnvelope()` the content/tool frames
 * use — `undefined` once the envelope has already been sent.
 */
export function finishFrame(
  finishReason: Exclude<FinishReason, null>,
  envelope?: Envelope,
): string {
  return frame(
    envelope === undefined
      ? { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
      : {
          id: envelope.id,
          object: "chat.completion.chunk",
          created: envelope.created,
          model: envelope.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        },
  );
}

/** The §3.4 error envelope frame. `message` must already be redacted. */
export function errorFrame(message: string, type: string, code?: string): string {
  const error: Record<string, string> = { message, type };
  if (code !== undefined) error.code = code;
  return frame({ error });
}

/**
 * The §4 finish-reason decision for a final assistant output:
 * - complete tool call (name + non-empty args) → `"tool_calls"`;
 * - any text content (or tool-call deltas that never completed) → `"stop"`;
 * - no content AND no tool calls at all (the empty run) → `null`.
 */
export function finishReasonFromOutput(
  output: AssistantOutput | null | undefined,
): FinishReason {
  const toolCalls = output?.tool_calls ?? [];
  const hasCompleteToolCall = toolCalls.some(
    (call) =>
      typeof call?.name === "string" &&
      call.name.length > 0 &&
      hasNonEmptyArgs(call?.args),
  );
  if (hasCompleteToolCall) return "tool_calls";
  if (hasTextContent(output?.content)) return "stop";
  // Tool-call deltas were streamed but never completed: still a real turn,
  // never the honest `null` of the empty run.
  if (toolCalls.length > 0) return "stop";
  return null;
}

/**
 * Translate a LangGraph `streamEvents(..., { version: "v2" })` iterable into
 * OpenAI-compatible SSE frames. Each yielded string is one complete
 * `data: <json>\n\n` frame; `data: [DONE]\n\n` is always yielded last.
 */
export async function* toOpenAiSse(
  events: AsyncIterable<StreamEvent>,
  opts: ToOpenAiSseOptions = {},
): AsyncGenerator<string, void, unknown> {
  const model = opts.modelId ?? DEFAULT_MODEL;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const id = opts.id ?? `chatcmpl-${randomBytes(8).toString("hex")}`;

  let envelopeSent = false;
  const takeEnvelope = (): Envelope | undefined => {
    if (envelopeSent) return undefined;
    envelopeSent = true;
    return { id, created, model };
  };

  // Sticky finish reason (§4): the first non-null value wins. Seeded by a
  // provider `tool_calls` finish on `on_chat_model_end`, else by the root
  // decision at `on_chain_end`.
  let finishReason: FinishReason = null;

  // True once a terminator ([DONE] after a finish/error frame, or a bare
  // [DONE] for the empty run) has been emitted — guards the safety net below
  // against double-termination.
  let terminated = false;

  // The root run is the outermost `on_chain_start`; only its `on_chain_end` /
  // `on_chain_error` terminate the stream (§6).
  let rootRunId: string | null = null;

  // Tool-call fragment grouping. `modelIndexMap` maps the model's own
  // `tool_call_chunks[].index` to an adapter-assigned index and is reset per
  // model turn; `nextToolIndex` is global and monotonically increasing so
  // indices are never reused across the whole run (§3.2).
  let modelIndexMap = new Map<number, number>();
  let nextToolIndex = 0;
  const toolCalls = new Map<number, ToolCallMeta>();

  const resetTurn = (): void => {
    modelIndexMap = new Map();
    toolCalls.clear();
  };

  const toolDeltaEntries = (
    message: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    const rawFragments = message.tool_call_chunks;
    if (!Array.isArray(rawFragments)) return [];
    const entries: Array<Record<string, unknown>> = [];
    for (const rawFragment of rawFragments) {
      const fragment = rawFragment as {
        index?: number;
        id?: string;
        name?: string;
        args?: string;
      };
      const modelIndex = fragment.index ?? 0;
      let adapterIndex = modelIndexMap.get(modelIndex);
      if (adapterIndex === undefined) {
        adapterIndex = nextToolIndex++;
        modelIndexMap.set(modelIndex, adapterIndex);
        toolCalls.set(adapterIndex, {
          id: "",
          name: "",
          firstEmitted: false,
          accumulatedArgs: "",
        });
      }
      const meta = toolCalls.get(adapterIndex)!;
      const args = normalizeArgsFragment(fragment.args ?? "", meta.accumulatedArgs);
      meta.accumulatedArgs += args;
      const first = !meta.firstEmitted;
      meta.firstEmitted = true;
      if (fragment.id) meta.id = fragment.id;
      if (fragment.name) meta.name = fragment.name;
      entries.push(
        first
          ? {
              index: adapterIndex,
              id: meta.id,
              type: "function",
              function: { name: meta.name, arguments: args },
            }
          : { index: adapterIndex, type: "function", function: { name: "", arguments: args } },
      );
    }
    return entries;
  };

  // Emit the delta frames (content then tool calls) for one streamed chunk.
  // Order of frames within an event mirrors §6 (content first, then tools).
  const deltaFrames = function* (
    chunkLike: unknown,
  ): Generator<string, void, unknown> {
    const message = messageFromChunk(chunkLike);
    for (const text of contentFragments(message)) {
      yield frame(choiceFrame({ content: text }, takeEnvelope()));
    }
    const entries = toolDeltaEntries(message);
    if (entries.length > 0) {
      yield frame(choiceFrame({ tool_calls: entries }, takeEnvelope()));
    }
  };

  // Safety net for mid-stream failures that langgraph v2 throws out of
  // `streamEvents` without delivering an `on_chain_error` event (the v2 tracer
  // implements no `onLLMError` and Pregel aborts the run before flushing error
  // events). Kept as the last error seen so a failure can be surfaced after
  // the loop even if the iterator dies mid-flight.
  let lastError: unknown = undefined;

  try {
    for await (const event of events) {
      if (rootRunId === null && event.event === "on_chain_start") {
        rootRunId = event.run_id;
      }

      switch (event.event) {
        case "on_chat_model_start":
        case "on_llm_start":
          // A new model turn: its tool-call indices are a fresh namespace.
          resetTurn();
          break;

      case "on_chat_model_stream":
          yield* deltaFrames(event.data.chunk);
          break;

      case "on_llm_stream": {
        // Legacy non-chat-model pipeline (§6): treat as content deltas.
        const text = (event.data.chunk as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.length > 0) {
          yield frame(choiceFrame({ content: text }, takeEnvelope()));
        }
        break;
      }

      case "on_chat_model_end": {
        // Feeds the finish-reason decision (§6): a provider `tool_calls`
        // finish is sticky; other provider values are ignored (normalized set).
        const output = event.data.output as
          | { response_metadata?: { finish_reason?: string } }
          | null
          | undefined;
        if (
          finishReason === null &&
          output?.response_metadata?.finish_reason === "tool_calls"
        ) {
          finishReason = "tool_calls";
        }
        break;
      }

      case "on_chain_stream": {
        // String chunks are content deltas; objects carrying `tool_call_chunks`
        // are tool-call deltas. State-shaped chunks (the supervisor graph's
        // `messages` updates) are ignored.
        const chunk = event.data.chunk;
        if (typeof chunk === "string" && chunk.length > 0) {
          yield frame(choiceFrame({ content: chunk }, takeEnvelope()));
        } else if (
          chunk !== null &&
          typeof chunk === "object" &&
          Array.isArray((chunk as { tool_call_chunks?: unknown }).tool_call_chunks)
        ) {
          yield* deltaFrames(chunk);
        }
        break;
      }

      case "on_chat_model_error":
      case "on_llm_error": {
        opts.onOutcome?.("failed");
        yield errorFrame(redact(errorMessage(event.data.error)), ERROR_TYPE_MODEL, exhaustionCode(event.data.error));
        yield DONE_FRAME;
        return;
      }

      case "on_tool_error": {
        opts.onOutcome?.("failed");
        yield errorFrame(
          redact(errorMessage(event.data.error)),
          ERROR_TYPE_TOOL,
          TOOL_ERROR_CODE,
        );
        yield DONE_FRAME;
        return;
      }

      case "on_chain_error": {
        if (event.run_id === rootRunId) {
          opts.onOutcome?.("failed");
          yield errorFrame(redact(errorMessage(event.data.error)), ERROR_TYPE_SERVER, exhaustionCode(event.data.error));
          yield DONE_FRAME;
          return;
        }
        break;
      }

      case "on_chain_end": {
        if (event.run_id !== rootRunId) break;
        // Root run terminates: decide the finish reason once, then emit the
        // finish chunk (§3.3) immediately before the single `[DONE]` (§6).
        const decision = finishReasonFromOutput(
          lastAssistantMessage(event.data.output),
        );
        if (finishReason === null) finishReason = decision;
        if (finishReason === null) {
          yield DONE_FRAME;
        } else {
          yield finishFrame(finishReason, takeEnvelope());
          yield DONE_FRAME;
        }
        return;
      }

      default:
        // `on_chat_model_start`/`on_tool_start`/`on_tool_end`/non-root
        // `on_chain_*`/subgraph events: silent on the wire (§6).
        break;
      }
    }
  } catch (error) {
    // A mid-stream failure the run could not deliver as an event.
    lastError = error;
  }

  // Safety net: langgraph v2 throws mid-stream failures out of `streamEvents`
  // without delivering an `on_chain_error` event (the v2 tracer implements no
  // `onLLMError` and Pregel aborts the run before flushing error events). If a
  // terminator was never emitted, surface the failure as a root chain error
  // envelope so the stream still terminates per I4 / §5.2 — and report the
  // honest failure outcome so the transport's terminal state (ledger task /
  // session outcome) is `failed`, never a mis-reported `succeeded`.
  if (!terminated && lastError !== undefined) {
    opts.onOutcome?.("failed");
    yield errorFrame(redact(errorMessage(lastError)), ERROR_TYPE_SERVER, exhaustionCode(lastError));
    yield DONE_FRAME;
    terminated = true;
  }

  // L9: the events iterable exhausted WITHOUT a root on_chain_end/error and
  // without throwing. The wire contract requires `[DONE]` as the sole
  // terminator, so guarantee it: emit a `stop` finish chunk (which, per L8,
  // carries the envelope when nothing else has been emitted) and then `[DONE]`.
  // Only degenerate streams reach this — a real graph run always delivers root
  // termination.
  if (!terminated) {
    yield finishFrame("stop", takeEnvelope());
    yield DONE_FRAME;
  }
}

/**
 * The last assistant message in a graph output. `on_chain_end`'s output is the
 * final state (`{ messages: [...] }`); the finish-reason decision (§4) is made
 * on the final assistant output.
 */
function lastAssistantMessage(output: unknown): AssistantOutput | null | undefined {
  if (output === null || typeof output !== "object") {
    return output as AssistantOutput | null | undefined;
  }
  const messages = (output as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return output as AssistantOutput | null | undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: string } | null;
    if (message !== null && typeof message === "object" && message.type === "ai") {
      return message as AssistantOutput;
    }
  }
  return undefined;
}

/**
 * `data.chunk` for `on_chat_model_stream` is the accumulated message chunk
 * itself; some producers wrap it in a generation (`{ message }`). Accept both.
 */
function messageFromChunk(
  chunkLike: unknown,
): Record<string, unknown> {
  if (chunkLike === null || typeof chunkLike !== "object") return {};
  const chunk = chunkLike as Record<string, unknown>;
  const message = chunk.message;
  if (message !== null && typeof message === "object") {
    return message as Record<string, unknown>;
  }
  return chunk;
}

/**
 * Non-empty text fragments from a message chunk's content: a plain string, or
 * the `type: "text"` blocks of a content array (§6). Non-text blocks are
 * skipped; empty fragments never produce a frame (§3.1).
 */
function contentFragments(message: Record<string, unknown>): string[] {
  const content = message.content;
  if (typeof content === "string") {
    return content.length > 0 ? [content] : [];
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => (block as { type?: unknown })?.type === "text")
      .map((block) => (block as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string" && text.length > 0);
  }
  return [];
}

/**
 * Normalize a fragmented raw-JSON `arguments` delta (§3.2). If the first
 * argument-bearing fragment lacks the leading `{`, re-prefix it so the client's
 * concatenation of fragments stays valid JSON. Subsequent fragments are passed
 * through untouched.
 */
function normalizeArgsFragment(fragment: string, accumulated: string): string {
  if (fragment === "" || fragment.startsWith("{")) return fragment;
  return accumulated === "" ? `{${fragment}` : fragment;
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        (block as { type?: string })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        ((block as { text: string }).text.length > 0),
    );
  }
  return false;
}

function hasNonEmptyArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === "string") return args.length > 0;
  if (typeof args === "object") return Object.keys(args as object).length > 0;
  return false;
}

/**
 * Wire form of an error: the first non-empty line of the error text. LangGraph
 * delivers tool/model failures as multi-line strings (message + stack trace);
 * only the human-readable message belongs on the wire (§3.4, Appendix A).
 */
function errorMessage(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return text.split("\n").find((line) => line.trim().length > 0) ?? text;
}

/** Error messages must never carry credential material (§5.2 / Appendix A). */
function redact(message: string): string {
  return redactForCheckpoint(message);
}