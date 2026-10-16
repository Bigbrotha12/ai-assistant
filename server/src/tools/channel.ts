import type { GoalLedger } from "../goals/ledger.ts";
import type { Ledger } from "../ledger/index.ts";
import type { BudgetManager } from "../managers/budget.ts";
import type { ToolResultCache } from "../managers/cache.ts";
import { createPluginAuditSink } from "./audit.ts";
import {
  createGoalToolInterceptors,
  createJobToolInterceptors,
  createSyncToolInterceptors,
} from "./interceptors/order.ts";
import { createToolPipeline } from "./pipeline.ts";
import type { ToolCall, ToolPipeline } from "./pipeline.ts";

/**
 * `channel.ts` — the ONE place the "which interceptors for which channel"
 * decision lives.
 *
 * Every binder takes a `ToolPipeline` dependency and falls back to
 * {@link buildPipelineForChannel}, so the channel→engine mapping (and the audit
 * sink) exists exactly once instead of being re-implemented at each
 * construction site.
 *
 * The channels share three *shapes*, not one engine:
 *   - **sync-shaped** (`sync-stateless`, `sync-managed`, `warmup`, and MCP
 *     bound for a sync channel): `serialize → cache → budget → execution`;
 *   - **job-shaped** (`job`, and MCP bound by `JobRunner`):
 *     `fence → serialize → replay → cache → budget → execution`;
 *   - **goal-shaped** (`goal`, and MCP bound by `GoalRunner`):
 *     `fence → serialize → authorize → cache → budget → reserve → execution`
 *     (no `replay` — a step is never re-run; `authorize` refuses an unlisted
 *     mutation and `reserve` is the `goal_mutation` at-most-once guard).
 *
 * The shape is selected by the channel name; `warmup` uses the sync shape. The
 * engine is stateless between dispatches — every per-call value (owner, task
 * fence, credentials, timeout, bodies, scope) rides `ToolCall`/`ToolCallScope`
 * , so a single engine can be shared by every dispatch of its
 * shape.
 *
 * The `onResult` sink is always attached: `createPluginAuditSink` is
 * plugin-source-only and skips `channel === "warmup"` (plan ). MCP
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
  /**
   * Goal shape only: the goal ledger read/written by the `fence` (lease +
   * step), `authorize` (refusals) and `reserve` (mutation rows) interceptors.
   */
  readonly goalLedger?: GoalLedger;
  /** Goal shape only: the goal id those interceptors scope to. */
  readonly goalId?: string;
};

function requireJobLedger(ledger: Ledger | undefined): Ledger {
  if (ledger === undefined) {
    throw new Error("buildPipelineForChannel: the 'job' channel requires a ledger");
  }
  return ledger;
}

function requireGoalLedger(ledger: GoalLedger | undefined): GoalLedger {
  if (ledger === undefined) {
    throw new Error("buildPipelineForChannel: the 'goal' channel requires a goal ledger");
  }
  return ledger;
}

function requireGoalId(goalId: string | undefined): string {
  if (goalId === undefined) {
    throw new Error("buildPipelineForChannel: the 'goal' channel requires a goal id");
  }
  return goalId;
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
      : channel === "goal"
        ? createGoalToolInterceptors({
            ledger: requireGoalLedger(deps.goalLedger),
            goalId: requireGoalId(deps.goalId),
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
