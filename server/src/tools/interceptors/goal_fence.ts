import { GoalError } from "../../goals/errors.ts";
import type { GoalLedger } from "../../goals/ledger.ts";
import type { ToolDispatch, ToolInterceptor } from "../pipeline.ts";

/**
 * `fence` interceptor — goal-channel step-fence guard (plan M3).
 *
 * Mirrors the job fence's shape but checks the GOAL row by `goalId`: the goal
 * must be `running`, carry the call's `goalLeaseToken`, and the per-step
 * terminal flag (set by the control tools via `markStepTerminal`) must be unset.
 * The per-step flag closes the same-round race: a control tool that committed
 * during the tool round marks the step terminal, so a sibling whose fence runs
 * after the flag is set is refused (plan §Same-round race).
 *
 * The channel signal's abort state is checked first, then the optional extra
 * guard (`assertActive` — the account-deletion tombstone, exactly as the job
 * fence calls it). The goal channel's fence owns this tombstone check, so the
 * `channel !== "job"` branches in `mcp.ts`/`orchestrator.ts` exclude `"goal"`.
 *
 * The interceptor is per-step (the runner constructs it in `setupGoalStep`);
 * the ledger is a constructor dependency while `stepSeq`/`goalLeaseToken` ride
 * the call — the same split as the job fence (`taskId`/`fenceToken`).
 *
 * The same full `check` is also supplied as the interceptor's `beforeBody`
 * hook: that third guard runs at the innermost point (after serialize/cache/
 * budget admission, immediately before the body) and closes the window where a
 * goal is cancelled (or a control tool commits) during setup but the body
 * would still run. Keeping the guard identical to the pre/post checks avoids
 * drift. See `ToolInterceptor.beforeBody`.
 */
export function createGoalFenceInterceptor(opts: {
  ledger: GoalLedger;
  goalId: string;
  assertActive?: () => void;
}): ToolInterceptor {
  const ledger = opts.ledger;
  const goalId = opts.goalId;
  const check = (dispatch: ToolDispatch): void => {
    const call = dispatch.call;
    call.signal?.throwIfAborted();
    const goal = ledger.getGoal(goalId);
    if (
      !goal ||
      goal.status !== "running" ||
      goal.lease_token !== call.goalLeaseToken
    ) {
      throw new GoalError(
        "GOAL_LEASE_CONFLICT",
        "goal no longer holds a running step fence",
      );
    }
    // Per-step terminal flag: a control tool (update_plan/goal_complete) marked
    // this step terminal during the tool round. The goal row is still
    // `running` (the control tool's CAS targets the step, not the goal), so
    // this is the only signal that refuses the sibling.
    if (call.stepSeq !== undefined) {
      const step = ledger.getStep(goalId, call.stepSeq);
      if (step !== undefined && step.status === "terminal") {
        throw new GoalError(
          "GOAL_INVALID_TRANSITION",
          "goal step was marked terminal by a control tool",
        );
      }
    }
    opts.assertActive?.();
  };
  return {
    name: "fence",
    beforeBody: check,
    async around(dispatch, next) {
      check(dispatch);
      await next();
      if (dispatch.executed) check(dispatch);
    },
  };
}
