import {
  DEFAULT_TOOL_CALL_QUARANTINE_MS,
} from "../../middleware/budget.ts";
import type { BudgetManager } from "../../middleware/budget.ts";
import type { ToolInterceptor } from "../pipeline.ts";

/**
 * `budget` interceptor — the per-owner/per-plugin concurrency gate plus
 * quarantine.
 *
 * Registered OUTER of `execution` so `withToolCallBudget` wraps the bounded
 * body: its `finally` therefore runs when the bounded race settles, which is
 * what lets it observe an unsettled raw body and quarantine the plugin (the
 * sync channel's current slot-leak / no-quarantine behaviour, D7, is fixed by
 * this ordering for every channel).
 *
 * `rawSettled` is the CHANNEL-owned deferred that resolves when the RAW body
 * settles (see `ToolCallScope.rawSettled`); budget reads it to decide between
 * release and quarantine. It is passed through to `withToolCallBudget`.
 *
 * `trackUntil` is registered INSIDE the admitted callback — never before
 * admission. If admission rejects (quarantine or a full budget), the body never
 * runs and the channel-owned `rawSettled` never resolves; registering the
 * tracked promise beforehand would leave it in `execution.pending` until the
 * quarantine deadline (~6 min by default), blocking `execution.settle()`. The
 * runner does the same (`runner.ts:908-913`).
 *
 * When the body never starts for any reason downstream of admission — a
 * `beforeBody` denial, or `invokeBoundedToolHandler` throwing before it runs
 * (invalid `timeoutMs`, an already-aborted `dispatch.bodySignal`) — the core
 * calls `scope.onBodySkipped`, and the channel (not this interceptor) resolves
 * `rawSettled`. `withToolCallBudget` then releases rather than quarantines: the
 * plugin did nothing wrong and there is no in-flight raw work to be uncertain
 * about (plan D9). This interceptor deliberately does not register the hook
 * itself; the deferred is channel-owned (`ToolCallScope.rawSettled`).
 *
 * `middleware/budget.ts` is intentionally NOT modified: the only change is this
 * caller, which now threads the effective `call.timeoutMs` (fixing D8) and the
 * channel's raw-settlement promise.
 */
export function createBudgetInterceptor(opts: {
  budget?: BudgetManager;
}): ToolInterceptor {
  const budget = opts.budget;
  return {
    name: "budget",
    async around(dispatch, next) {
      if (!budget) {
        await next();
        return;
      }
      const call = dispatch.call;
      const scope = dispatch.scope;
      const rawSettled = scope.rawSettled;
      await budget.withToolCallBudget(
        call.owner ?? "",
        call.pluginId,
        async () => {
          if (rawSettled !== undefined) {
            scope.trackUntil?.(
              () => rawSettled,
              call.timeoutMs + DEFAULT_TOOL_CALL_QUARANTINE_MS,
            );
          }
          await next();
        },
        {
          requestId: call.requestId,
          tool: call.tool,
          timeoutMs: call.timeoutMs,
          rawSettled,
        },
      );
    },
  };
}
