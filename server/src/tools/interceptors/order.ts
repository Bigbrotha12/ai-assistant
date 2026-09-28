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
 * Phase 1.9's job composition root should build its interceptor array through
 * `createJobToolInterceptors` so the order lives in one place.
 *
 * 1.9 SEAM: the factory is not load-bearing yet — only its own test calls it
 * today. Production still assembles `bindJobTools`' duplicated body. 1.9 wires
 * this factory into the composition root and deletes that body.
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
