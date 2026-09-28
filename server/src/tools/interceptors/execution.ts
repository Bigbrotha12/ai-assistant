import {
  boundToolResult,
  invokeBoundedToolHandler,
} from "../../tool_bounds.ts";
import { logger } from "../../logger.ts";
import type { ToolInterceptor } from "../pipeline.ts";

/**
 * `execution` interceptor — bounds the body, propagates the timeout abort, and
 * owns the body-scoped cancellation telemetry.
 *
 * `invokeBoundedToolHandler` owns the effective `call.timeoutMs` bound, the
 * `call.maxResultChars` truncation, and the timeout controller. The `run`
 * callback calls `next(signal)`, so the timeout controller's signal is composed
 * into `dispatch.bodySignal` and reaches the body — without this, a timeout
 * would fire but the outbound request would hang, and every slow call would be
 * quarantined. `run` returns `dispatch.content` (set by the body) so the
 * handler's existing bounding still applies.
 *
 * `dispatch.bodySignal` — not `call.signal` — is passed as the bound's signal so
 * a signal narrowed by an *outer* `next(signal)` is part of the bound too, and
 * the composition contract holds end to end.
 *
 * `scope.onToolStart`/`scope.onToolEnd` fire around the BOUNDED race, mirroring
 * production (`runner.ts:878-920`): `onToolEnd` is in a `finally` after the
 * bounded await, so a handler that ignores abort still reports its end when the
 * timeout fires. Anchoring them to the raw body promise instead would leave
 * `onToolEnd` unfired forever for such a handler (the reason `activeToolCallIds`
 * would otherwise report `running_tool` indefinitely).
 *
 * Production bounds twice — `invokeBoundedToolHandler` at `maxResultChars`, then
 * `boundToolResult` at the DEFAULT cap (`runner.ts:980`). The default bound is
 * applied here (and again in the core for short-circuit hit paths) so every
 * outer post-hook (cache store, ledger record) sees the same value production
 * would persist.
 *
 * `scope.track` is job-channel bookkeeping (keeps the job's `settle()` draining
 * in-flight calls); it preserves the bound promise's rejection, so a timeout
 * still surfaces as `tool_timeout`.
 */
export function createExecutionInterceptor(): ToolInterceptor {
  return {
    name: "execution",
    async around(dispatch, next) {
      const call = dispatch.call;
      const scope = dispatch.scope;
      scope.onToolStart?.(call.actionId);
      try {
        const bounded = invokeBoundedToolHandler(
          async (signal) => {
            await next(signal);
            return dispatch.content;
          },
          {
            timeoutMs: call.timeoutMs,
            maxResultChars: call.maxResultChars,
            signal: dispatch.bodySignal,
            timeoutMessage:
              `tool '${call.tool}' of plugin '${call.pluginId}' exceeded the handler timeout`,
          },
        );
        const track = scope.track;
        const result = track ? await track(() => bounded) : await bounded;
        dispatch.content = boundToolResult(result);
      } catch (error) {
        // `invokeBoundedToolHandler` can throw BEFORE the body runs (its own
        // `signal.throwIfAborted()`, or an invalid limit). Release the channel's
        // raw deferred NOW, before the error unwinds out through `budget`, so a
        // body-skipped dispatch releases instead of transiently quarantining
        // (finding m3). The dispatch-level backstop is idempotent.
        if (!dispatch.executed) {
          try {
            scope.onBodySkipped?.();
          } catch (hookError) {
            logger.warn(
              "[tools/execution] onBodySkipped hook threw; dispatch continues:",
              hookError,
            );
          }
        }
        throw error;
      } finally {
        scope.onToolEnd?.(call.actionId);
      }
    },
  };
}