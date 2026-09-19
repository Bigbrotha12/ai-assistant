import type { BaseCheckpointSaver, CompiledStateGraph } from "@langchain/langgraph";

/** Any compiled state graph, ignoring the generic parameters. */
type AnyCompiledStateGraph = CompiledStateGraph<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * Recompile an agent graph with a durable checkpointer (Phase 2, Wave B1).
 *
 * `createAgentGraph` (graph.ts) builds and compiles the supervisor graph
 * WITHOUT a checkpointer — it is deliberately checkpointer-free so this seam
 * owns persistence. LangGraph's `CompiledStateGraph` retains its source
 * `StateGraph` on `.builder`, so recompiling from the builder with a
 * checkpointer yields a fresh compiled graph backed by the same nodes/edges
 * plus durable conversation state (verified round-trip in the store tests).
 * The graph's state type is preserved through the generic.
 *
 * Pure and side-effect-free: the transport does
 *
 *   const graph = compileGraphWithCheckpointer(createAgentGraph(deps), store.checkpointer);
 *
 * and then invokes/streams it with `{ configurable: { thread_id } }`.
 */
export function compileGraphWithCheckpointer<G extends AnyCompiledStateGraph>(
  graph: G,
  checkpointer: BaseCheckpointSaver,
): G {
  // Recompiling from the same builder with a checkpointer yields the identical
  // graph shape, so the input type is the honest output type.
  return graph.builder.compile({ checkpointer }) as G;
}
