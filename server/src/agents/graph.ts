import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SUPERVISOR_PROMPT } from "./prompts.ts";

/**
 * Supervisor-style agent graph (Phase 2 plan: `graph.ts`).
 *
 *   START → orchestrator ─(tool_calls)→ toolExecutor → orchestrator → ...
 *               └───────(no tool_calls)───────────────→ END
 *
 * - `orchestrator` calls the (tool-bound) chat model to decide the next
 *   action.
 * - `toolExecutor` runs any tool calls requested by the last AIMessage via a
 *   registry-backed `ToolNode`, feeding results back to the orchestrator.
 * - A max-iteration guard (`toolRounds` in state) bounds the orchestrator ↔
 *   toolExecutor loop so a model that never stops calling tools cannot loop
 *   forever.
 *
 * The graph is intentionally checkpointer-free: `createAgentGraph` is a pure
 * construction of nodes/edges, so Wave B1 can wrap the compiled graph with
 * `SqliteSaver` checkpointing and Phase 3's transport can stream it
 * (`streamEvents(..., { version: "v2" })`, which this compiled graph
 * supports). Context compaction (`context.ts`) is deferred to Phase 4 per the
 * plan and is out of scope here.
 */

/** Default cap on orchestrator ↔ toolExecutor rounds before forced termination. */
export const MAX_TOOL_ROUNDS = 5;

export const AgentStateAnnotation = Annotation.Root({
  /** Conversation history; appends, never overwrites. */
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Accumulator of raw tool executor outputs (string) for diagnostics/compaction. */
  toolResults: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Number of completed tool-execution rounds; drives the max-iteration guard. */
  toolRounds: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentUpdate = typeof AgentStateAnnotation.Update;

export type AgentGraphDeps = {
  /** Already-configured chat model (Phase 3 transport picks it from the request). */
  model: BaseChatModel;
  /** Tools bound to the model (e.g. from `createAgent` in orchestrator.ts). */
  tools: StructuredToolInterface[];
  /** Max tool rounds before the graph terminates a looping model. Default `MAX_TOOL_ROUNDS`. */
  maxIterations?: number;
};

/**
 * Build the supervisor agent graph. Pure construction — no checkpoints, no
 * side effects. Model and tools are dependency-injected so tests can pass a
 * fake model and Phase 3 can wire the real one.
 */
export function createAgentGraph({
  model,
  tools,
  maxIterations = MAX_TOOL_ROUNDS,
}: AgentGraphDeps) {
  if (typeof model.bindTools !== "function") {
    throw new Error(
      "createAgentGraph: the provided chat model does not support bindTools; " +
        "a tool-capable model is required to run the supervisor agent",
    );
  }
  // LOW: never hand a provider an empty tool array — a model with zero tools
  // would be asked to decide between nothing. Log and run chat-only instead.
  const hasTools = tools.length > 0;
  if (!hasTools) {
    console.warn(
      "[agents] createAgentGraph: no tools bound; running a chat-only agent " +
        "(no tool calls will be emitted)",
    );
  }
  const modelWithTools = hasTools ? model.bindTools(tools) : model;
  // M7: `handleToolErrors: false` — a tool failure must NOT become a ToolMessage
  // (which the graph would feed back to the model and let the job complete
  // `succeeded`). With the default `true` the runner's failJob path never sees
  // the error; here it surfaces as a thrown error and the job is failed with a
  // recorded error step.
  const toolNode = new ToolNode(tools, { handleToolErrors: false });

  /** Decide the next action: emit an AIMessage (possibly with tool_calls). */
  const orchestrator = async (state: AgentState): Promise<AgentUpdate> => {
    const system = new SystemMessage(SUPERVISOR_PROMPT);
    const response = await modelWithTools.invoke([system, ...state.messages]);
    return { messages: [response] };
  };

  /** Execute requested tool calls; results become ToolMessages fed back to the loop. */
  const toolExecutor = async (state: AgentState): Promise<AgentUpdate> => {
    const result = await toolNode.invoke(state);
    const toolMessages = result.messages as BaseMessage[];
    const outputs = toolMessages
      .filter((message): message is ToolMessage => message instanceof ToolMessage)
      .map((message) => String(message.content));
    return {
      messages: toolMessages,
      toolRounds: 1,
      toolResults: outputs,
    };
  };

  /** Route back to tools when tool_calls are pending and the loop budget remains. */
  const routeAfterOrchestrator = (
    state: AgentState,
  ): "toolExecutor" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    const hasToolCalls =
      lastMessage instanceof AIMessage &&
      (lastMessage.tool_calls?.length ?? 0) > 0;
    if (hasToolCalls && state.toolRounds < maxIterations) return "toolExecutor";
    return END;
  };

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("orchestrator", orchestrator)
    .addNode("toolExecutor", toolExecutor)
    .addEdge(START, "orchestrator")
    .addConditionalEdges("orchestrator", routeAfterOrchestrator, [
      "toolExecutor",
      END,
    ])
    .addEdge("toolExecutor", "orchestrator")
    .compile();

  return graph;
}