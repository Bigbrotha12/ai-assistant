import type { Ledger } from "../ledger.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type { ToolResultCache } from "../middleware/cache.ts";
import { createPluginAuditSink } from "./audit.ts";
import {
  createJobToolInterceptors,
  createSyncToolInterceptors,
} from "./interceptors/order.ts";
import { createToolPipeline } from "./pipeline.ts";
import type { ToolCall, ToolPipeline } from "./pipeline.ts";

/**
 * `channel.ts` — the ONE place the "which interceptors for which channel"
 * decision lives (plan §5, task 1.13).
 *
 * Before this module the channel→engine mapping was re-implemented at every
 * construction site: `bindPluginTools` (`agents/orchestrator.ts`) and the
 * warmup manager both hand-built the sync set, `bindJobTools`
 * (`jobs/runner.ts`) hand-built the job set, and `bindMcpServers`
 * (`agents/mcp.ts`) hand-rolled its own `channel === "job" ? job : sync`
 * selection. Every binder now takes a `ToolPipeline` dependency and falls back
 * to {@link buildPipelineForChannel}, so the mapping (and the audit sink) exists
 * exactly once.
 *
 * The channels share two *shapes*, not one engine:
 *   - **sync-shaped** (`sync-stateless`, `sync-managed`, `warmup`, and MCP
 *     bound for a sync channel): `serialize → cache → budget → execution`;
 *   - **job-shaped** (`job`, and MCP bound by `JobRunner`):
 *     `fence → serialize → replay → cache → budget → execution`.
 *
 * The shape is selected by the channel name; `warmup` uses the sync shape. The
 * engine is stateless between dispatches — every per-call value (owner, task
 * fence, credentials, timeout, bodies, scope) rides `ToolCall`/`ToolCallScope`
 * (plan §4.1/§4.2), so a single engine can be shared by every dispatch of its
 * shape.
 *
 * The `onResult` sink is always attached: `createPluginAuditSink` is
 * plugin-source-only and skips `channel === "warmup"` (plan D5/D6). MCP
 * dispatches reaching it are no-ops (audit stays inside `runMcpOperation`);
 * warmup dispatches are no-ops (warmup emits no `plugin.tool` audit). Sharing
 * one source/channel-filtered sink is what lets a single engine per shape serve
 * plugin and MCP tools alike.
 */
export type ToolChannel = ToolCall["channel"];

export type ChannelPipelineDeps = {
  readonly budget?: BudgetManager;
  readonly cache?: ToolResultCache;
  /** Job shape only: the ledger the `fence`/`replay` interceptors read. */
  readonly ledger?: Ledger;
  /** Job shape only: the per-job task-fence re-check supplied to `fence`. */
  readonly assertActive?: () => void;
};

function requireJobLedger(ledger: Ledger | undefined): Ledger {
  if (ledger === undefined) {
    throw new Error("buildPipelineForChannel: the 'job' channel requires a ledger");
  }
  return ledger;
}

/**
 * Builds the engine for `channel` from the shared deps. The interceptor order
 * itself still lives in `interceptors/order.ts`; this function is the only
 * caller that maps a channel onto that order (and onto the audit sink).
 */
export function buildPipelineForChannel(
  channel: ToolChannel,
  deps: ChannelPipelineDeps = {},
): ToolPipeline {
  const interceptors =
    channel === "job"
      ? createJobToolInterceptors({
          ledger: requireJobLedger(deps.ledger),
          ...(deps.budget === undefined ? {} : { budget: deps.budget }),
          ...(deps.cache === undefined ? {} : { cache: deps.cache }),
          ...(deps.assertActive === undefined
            ? {}
            : { assertActive: deps.assertActive }),
        })
      : createSyncToolInterceptors({
          ...(deps.budget === undefined ? {} : { budget: deps.budget }),
          ...(deps.cache === undefined ? {} : { cache: deps.cache }),
        });
  return createToolPipeline({
    interceptors,
    onResult: createPluginAuditSink(),
  });
}
