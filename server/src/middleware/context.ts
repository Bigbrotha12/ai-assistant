import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Overwrite } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { PrepareMessages } from "../agents/graph.ts";
import type { ThreadLockRegistry } from "../jobs/thread_lock.ts";

type ContentfulMessageLike = BaseMessage | {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

export class ContextBudgetError extends Error {
  readonly code = "context_length_exceeded";

  constructor(readonly estimatedTokens: number, readonly limitTokens: number) {
    super(`Required model input exceeds context budget (${estimatedTokens} > ${limitTokens} estimated tokens)`);
    this.name = "ContextBudgetError";
  }
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: ContentfulMessageLike): number {
  let total = estimateTokens(message.content);
  if (message.name) total += estimateTokens(message.name);
  if ("tool_call_id" in message) total += estimateTokens(message.tool_call_id);
  if ("tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    total += estimateTokens(message.tool_calls);
  } else if (message instanceof BaseMessage && message.additional_kwargs.tool_calls) {
    total += estimateTokens(message.additional_kwargs.tool_calls);
  }
  if (message instanceof AIMessage && message.invalid_tool_calls?.length) {
    total += estimateTokens(message.invalid_tool_calls);
  }
  return total;
}

export function estimateMessagesTokens(messages: readonly ContentfulMessageLike[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function validateLimit(limitTokens: number): void {
  if (!Number.isSafeInteger(limitTokens) || limitTokens < 0) {
    throw new RangeError("limitTokens must be a non-negative safe integer");
  }
}

function messageGroups(messages: readonly BaseMessage[]): BaseMessage[][] {
  const groups: BaseMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message instanceof ToolMessage) {
      throw new Error("Context history contains an unmatched tool result");
    }
    const group = [message];
    if (message instanceof AIMessage && message.tool_calls?.length) {
      const pending = new Set(message.tool_calls.map((call) => call.id));
      if (pending.has(undefined) || pending.has("") || pending.size !== message.tool_calls.length) {
        throw new Error("Context history contains invalid tool call IDs");
      }
      while (pending.size > 0) {
        const result = messages[++i];
        if (!(result instanceof ToolMessage) || !pending.delete(result.tool_call_id)) {
          throw new Error("Context history contains an unmatched tool call");
        }
        group.push(result);
      }
    }
    groups.push(group);
  }
  return groups;
}

export function truncatePairAware(
  messages: readonly BaseMessage[],
  limitTokens: number,
): BaseMessage[] {
  validateLimit(limitTokens);
  const groups = messageGroups(messages);
  const systems = groups.filter(([message]) => message instanceof SystemMessage);
  const history = groups.filter(([message]) => !(message instanceof SystemMessage));
  const lastUser = history.findLastIndex(([message]) => message instanceof HumanMessage);
  const required = [...systems.flat(), ...(lastUser >= 0 ? history[lastUser]! : [])];
  const requiredTokens = estimateMessagesTokens(required);
  if (requiredTokens > limitTokens) throw new ContextBudgetError(requiredTokens, limitTokens);
  if (estimateMessagesTokens(messages) <= limitTokens) return [...messages];

  const kept = new Set<BaseMessage[]>(systems);
  if (lastUser >= 0) kept.add(history[lastUser]!);
  let used = requiredTokens;
  const liveStart = lastUser >= 0 ? lastUser + 1 : 0;
  for (let i = history.length - 1; i >= liveStart; i--) {
    const group = history[i]!;
    const tokens = estimateMessagesTokens(group);
    if (used + tokens > limitTokens) break;
    kept.add(group);
    used += tokens;
  }
  const wholeLiveKept = history.slice(liveStart).every((group) => kept.has(group));
  if (wholeLiveKept && lastUser >= 0) {
    let end = lastUser;
    while (end > 0) {
      let start = end - 1;
      while (start > 0 && !(history[start]![0] instanceof HumanMessage)) start--;
      const turn = history.slice(start, end);
      const tokens = estimateMessagesTokens(turn.flat());
      if (used + tokens > limitTokens) break;
      for (const group of turn) kept.add(group);
      used += tokens;
      end = start;
    }
  }
  return groups.filter((group) => kept.has(group)).flat();
}

export type ContextManagerOptions = {
  limitTokens: number;
  threadLocks?: ThreadLockRegistry;
};

export type ContextGraph = {
  getState(config: RunnableConfig): Promise<{
    values: Record<string, unknown>;
    next: readonly string[];
    config: RunnableConfig;
  }>;
  updateState(config: RunnableConfig, values: Record<string, unknown>, asNode?: string): Promise<RunnableConfig>;
};

export type MaybeCompactArgs = {
  owner: string;
  clientThreadId: string;
  threadId: string;
  checkpointer?: BaseCheckpointSaver;
  graph?: ContextGraph;
  lockHeld?: boolean;
};

export type ContextManager = {
  truncateSeed(messages: BaseMessage[]): BaseMessage[];
  prepareMessages: PrepareMessages;
  maybeCompactAfterStream(args: MaybeCompactArgs): Promise<void>;
};

export function createContextManager(opts: ContextManagerOptions): ContextManager {
  const { limitTokens, threadLocks } = opts;
  validateLimit(limitTokens);
  const truncateSeed = (messages: BaseMessage[]): BaseMessage[] =>
    truncatePairAware(messages, limitTokens);
  const prepareMessages: PrepareMessages = (messages, config) => {
    config.signal?.throwIfAborted();
    return truncatePairAware(messages, limitTokens);
  };

  const compactOnce = async (args: MaybeCompactArgs): Promise<void> => {
    const { graph } = args;
    if (!graph || (!threadLocks && !args.lockHeld)) return;
    const config = { configurable: { thread_id: args.threadId } };
    const current = await graph.getState(config);
    if (current.next.length > 0 || current.values.compacted === true) return;
    const messages = (current.values.messages as BaseMessage[] | undefined) ?? [];
    if (estimateMessagesTokens(messages) <= limitTokens) return;
    const truncated = truncatePairAware(messages, limitTokens);
    const latest = await graph.getState(config);
    const checkpointId = current.config.configurable?.checkpoint_id;
    if (!checkpointId || latest.config.configurable?.checkpoint_id !== checkpointId) return;
    await graph.updateState(current.config, {
      messages: new Overwrite(truncated),
      compacted: true,
    }, "orchestrator");
  };

  const maybeCompactAfterStream = async (args: MaybeCompactArgs): Promise<void> => {
    try {
      const run = () => compactOnce(args);
      if (threadLocks && !args.lockHeld) {
        await threadLocks.runExclusive(args.threadId, run);
      } else {
        await run();
      }
    } catch {
      console.warn("context: post-turn compaction skipped (best-effort)");
    }
  };

  return { truncateSeed, prepareMessages, maybeCompactAfterStream };
}
