import type { Ledger } from "../../ledger.ts";
import type { BudgetManager } from "../../middleware/budget.ts";
import type { ToolResultCache } from "../../middleware/cache.ts";
import { createBudgetInterceptor } from "./budget.ts";
import { createCacheInterceptor } from "./cache.ts";
import { createExecutionInterceptor } from "./execution.ts";
import { createFenceInterceptor } from "./fence.ts";
import { createReplayInterceptor } from "./replay.ts";
import { createSerializeInterceptor } from "./serialize.ts";
import type { ToolInterceptor } from "../pipeline.ts";

/**
 * The canonical job-channel interceptor order, outer→inner.
 *
 * This ordering is load-bearing and must not be rearranged casually:
 *   - `fence` before `serialize` preserves `task_conflict` winning over
 *     `tool_args_too_large` (`runner.ts:859` before `:860`).
 *   - `replay` before `cache` preserves "a cache hit writes no ledger step"
 *     (the `executed && !fromCache` guard).
 *   - `budget` OUTSIDE `execution` is what makes quarantine possible: budget's
 *     `finally` runs when the bounded race settles, so it can observe an
 *     unsettled raw body (`runner.ts:908`, plan D7).
 *
 * The composition root builds the job channel's interceptor array through
 * `createJobToolInterceptors` (via `buildPipelineForChannel`, `tools/channel.ts`)
 * so the order lives in one place; `bindJobTools` (`jobs/runner.ts`) receives
 * the resulting engine (task 1.13) rather than re-deriving the set.
 */
export const JOB_TOOL_INTERCEPTOR_ORDER = [
  "fence",
  "serialize",
  "replay",
  "cache",
  "budget",
  "execution",
] as const;

export type JobToolInterceptorOptions = {
  ledger: Ledger;
  budget?: BudgetManager;
  cache?: ToolResultCache;
  /** Job fence's pre/post check, also used as the interceptor's `beforeBody` guard. */
  assertActive?: () => void;
};

/**
 * Builds the ordered job-channel interceptor list. `budget`/`cache` are
 * optional so a test or a degraded composition can omit them; the order is
 * identical either way.
 */
export function createJobToolInterceptors(
  opts: JobToolInterceptorOptions,
): ToolInterceptor[] {
  return [
    createFenceInterceptor({
      ledger: opts.ledger,
      ...(opts.assertActive === undefined ? {} : { assertActive: opts.assertActive }),
    }),
    createSerializeInterceptor(),
    createReplayInterceptor({ ledger: opts.ledger }),
    createCacheInterceptor(
      opts.cache === undefined ? {} : { cache: opts.cache },
    ),
    createBudgetInterceptor(
      opts.budget === undefined ? {} : { budget: opts.budget },
    ),
    createExecutionInterceptor(),
  ];
}

/**
 * The canonical sync-channel interceptor order, outer→inner.
 *
 * The sync channels (`sync-stateless`, `sync-managed`) deliberately omit two
 * job-only interceptors:
 *   - `fence` — there is no background task to guard;
 *   - `replay` — there is no per-task ledger to dedupe against (sync responses
 *     are not crash-resumable).
 *
 * The order below is the shared prefix of the job order with those removed:
 *   - `serialize` first preserves the sync path's "args are bounded before any
 *     policy runs" behaviour (`orchestrator.ts` used to serialize at the top of
 *     `bindPluginTool.func`);
 *   - `budget` OUTSIDE `execution` is what makes quarantine possible (plan D7):
 *     the sync channel previously abandoned the inner promise from an outer
 *     bound, so `withToolCallBudget`'s `finally` never ran and no quarantine was
 *     ever registered. Unifying budget around execution fixes that.
 *
 * `buildPipelineForChannel` (`tools/channel.ts`) builds the sync-shaped engine
 * through this factory, so the order lives in one place; `bindPluginTools`,
 * `bindMcpServers` and the warmup manager receive that engine (task 1.13)
 * rather than re-deriving the set.
 */
export const SYNC_TOOL_INTERCEPTOR_ORDER = [
  "serialize",
  "cache",
  "budget",
  "execution",
] as const;

export type SyncToolInterceptorOptions = {
  budget?: BudgetManager;
  cache?: ToolResultCache;
};

/**
 * Builds the ordered sync-channel interceptor list. `budget`/`cache` are
 * optional so a test or a degraded composition can omit them; the order is
 * identical either way.
 */
export function createSyncToolInterceptors(
  opts: SyncToolInterceptorOptions,
): ToolInterceptor[] {
  return [
    createSerializeInterceptor(),
    createCacheInterceptor(
      opts.cache === undefined ? {} : { cache: opts.cache },
    ),
    createBudgetInterceptor(
      opts.budget === undefined ? {} : { budget: opts.budget },
    ),
    createExecutionInterceptor(),
  ];
}
