import { emitPluginToolAudit } from "../audit/telemetry.ts";
import type { ToolCallResult, ToolDispatch } from "./pipeline.ts";

/**
 * `plugin`-source `onResult` sink — replaces the two duplicated `finally` audit
 * blocks (`agents/orchestrator.ts:125-140`, `jobs/runner.ts:1002-1015`).
 *
 * Scope (plan §1.8 / D5 / D6):
 *   - only `source === "plugin"` — MCP audit stays inside `runMcpOperation`
 *     (`mcp.ts`), which carries fields the pipeline cannot (`circuitState`,
 *     `policyCode`, `ownerBound`, `cacheHit`) and a distinct event name. Routing
 *     MCP through here would double-emit and lose fidelity.
 *   - `channel !== "warmup"` — warmup emits no `plugin.tool` audit today, and
 *     this sink preserves that until enabling it is a deliberate change.
 *
 * A throwing sink cannot break the dispatch: the pipeline core wraps this call.
 */
export function createPluginAuditSink(): (
  dispatch: ToolDispatch,
  result: ToolCallResult,
) => void {
  return (dispatch, result) => {
    const call = dispatch.call;
    if (call.source !== "plugin" || call.channel === "warmup") return;
    emitPluginToolAudit({
      owner: call.owner,
      pluginId: call.pluginId,
      tool: call.tool,
      requestId: call.requestId,
      outcome: result.outcome,
      durationMs: result.durationMs,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    });
  };
}
