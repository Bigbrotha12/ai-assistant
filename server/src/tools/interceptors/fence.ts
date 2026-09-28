import { JobError } from "../../jobs/errors.ts";
import type { Ledger } from "../../ledger.ts";
import type { ToolDispatch, ToolInterceptor } from "../pipeline.ts";

/**
 * `fence` interceptor — job-channel task-fence guard.
 *
 * `assertActive()` before delegation, and after `next()` ONLY when
 * `dispatch.executed`. The post-check is gated on `executed` to preserve
 * today's behaviour: a replay/cache hit short-circuits (the body never runs), so
 * only the pre-check applies. The predicate is today's exact one
 * (`runner.ts:850-859`): the task must exist, be `running`, and carry the
 * call's fence token; otherwise `JobError("task_conflict", ...)`. The channel
 * signal's abort state is checked first, then the optional extra guard.
 *
 * The interceptor is a shared singleton; the ledger is a constructor dependency
 * while `taskId`/`fenceToken` ride the call.
 *
 * The same full `check` is also supplied as the interceptor's `beforeBody`
 * hook: that third guard runs at the innermost point (after serialize/replay/
 * cache/budget admission, immediately before the body) and closes the window
 * where a task is cancelled during setup but the body would still run. Keeping
 * the guard identical to the pre/post checks avoids drift, and the core owns
 * invocation, so nothing mutates the dispatch scope. See
 * `ToolInterceptor.beforeBody`.
 */
export function createFenceInterceptor(opts: {
  ledger: Ledger;
  assertActive?: () => void;
}): ToolInterceptor {
  const ledger = opts.ledger;
  const check = (dispatch: ToolDispatch): void => {
    const call = dispatch.call;
    call.signal?.throwIfAborted();
    const task =
      call.taskId === undefined
        ? null
        : ledger.getTask(call.taskId, call.owner);
    if (
      !task ||
      task.status !== "running" ||
      task.fence_token !== call.fenceToken
    ) {
      throw new JobError(
        "task_conflict",
        "background job no longer holds a running task fence",
      );
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
