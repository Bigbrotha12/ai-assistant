import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, Overwrite, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SUPERVISOR_PROMPT } from "./prompts.ts";

export const MAX_TOOL_ROUNDS = 5;

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  toolResults: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  toolRounds: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
  compacted: Annotation<boolean>({
    reducer: (left, right) => left || right,
    default: () => false,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentUpdate = typeof AgentStateAnnotation.Update;

export type PrepareMessages = (
  messages: BaseMessage[],
  config: RunnableConfig,
) => BaseMessage[] | Promise<BaseMessage[]>;

export type BeforeModelCall = (
  messages: BaseMessage[],
  config: RunnableConfig,
) => void | Promise<void>;

export type AgentGraphDeps = {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  maxIterations?: number;
  prepareMessages?: PrepareMessages;
  beforeModelCall?: BeforeModelCall;
};

export function createAgentGraph({
  model,
  tools,
  maxIterations = MAX_TOOL_ROUNDS,
  prepareMessages,
  beforeModelCall,
}: AgentGraphDeps) {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
    throw new RangeError("maxIterations must be a non-negative safe integer");
  }
  if (typeof model.bindTools !== "function") {
    throw new Error(
      "createAgentGraph: the provided chat model does not support bindTools; " +
        "a tool-capable model is required to run the supervisor agent",
    );
  }
  const hasTools = tools.length > 0;
  if (!hasTools) {
    console.warn(
      "[agents] createAgentGraph: no tools bound; running a chat-only agent " +
        "(no tool calls will be emitted)",
    );
  }
  const modelWithTools = hasTools ? model.bindTools(tools) : model;
  const toolNode = new ToolNode(tools, { handleToolErrors: false });

  const orchestrator = async (
    state: AgentState,
    config: RunnableConfig,
  ): Promise<AgentUpdate> => {
    config.signal?.throwIfAborted();
    if (state.toolRounds >= maxIterations) {
      return { messages: [new AIMessage("Tool round limit reached. No further tools were run.")] };
    }
    const input = [new SystemMessage(SUPERVISOR_PROMPT), ...state.messages];
    const messages = prepareMessages ? await prepareMessages(input, config) : input;
    config.signal?.throwIfAborted();
    await beforeModelCall?.(messages, config);
    config.signal?.throwIfAborted();
    const response = await modelWithTools.invoke(messages, config);
    return { messages: [response] };
  };

  const toolExecutor = async (
    state: AgentState,
    config: RunnableConfig,
  ): Promise<AgentUpdate> => {
    config.signal?.throwIfAborted();
    const result = await toolNode.invoke(state, config);
    const toolMessages = result.messages as BaseMessage[];
    const outputs = toolMessages
      .filter((message): message is ToolMessage => message instanceof ToolMessage)
      .map((message) => typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content));
    return {
      messages: toolMessages,
      toolRounds: 1,
      toolResults: outputs,
    };
  };

  const routeAfterOrchestrator = (
    state: AgentState,
  ): "toolExecutor" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    const hasToolCalls =
      lastMessage instanceof AIMessage &&
      (lastMessage.tool_calls?.length ?? 0) > 0;
    if (hasToolCalls) return "toolExecutor";
    return END;
  };

  return new StateGraph(AgentStateAnnotation)
    .addNode("startTurn", (): AgentUpdate => ({ toolRounds: new Overwrite(0) }))
    .addNode("orchestrator", orchestrator)
    .addNode("toolExecutor", toolExecutor)
    .addEdge(START, "startTurn")
    .addEdge("startTurn", "orchestrator")
    .addConditionalEdges("orchestrator", routeAfterOrchestrator, [
      "toolExecutor",
      END,
    ])
    .addEdge("toolExecutor", "orchestrator")
    .compile();
}
