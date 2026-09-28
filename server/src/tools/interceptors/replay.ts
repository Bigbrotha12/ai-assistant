import { JobError } from "../../jobs/errors.ts";
import {
  canRetryTool,
  hasToolResult,
  recordToolResult,
} from "../../credentials/idempotency.ts";
import { boundToolResult } from "../../tool_bounds.ts";
import type { Ledger } from "../../ledger.ts";
import type { ToolInterceptor } from "../pipeline.ts";

/**
 * `replay` interceptor — job-channel ledger replay dedupe.
 *
 * Pre: a stored result for `call.toolCallId` short-circuits with the stored
 * content, setting `replayed`. A mutating tool with no stored result and
 * `allowMutatingRetry:false` is refused (`tool_retry_forbidden`), including the
 * anonymous-id (no `toolCallId`) case — the retry guard does NOT require an id.
 *
 * The retry guard is enforced even when the job ledger context (`taskId`/`owner`)
 * is absent: the interceptor fails CLOSED rather than delegating an
 * un-dedupable mutating call through. `fence` already fails closed in the same
 * situation, so a partially-wired channel cannot bypass the rule.
 *
 * Post: record the result ONLY when the body actually executed and this was not
 * a cache hit (`dispatch.executed && !dispatch.fromCache`). Today's behaviour
 * (`runner.ts:966-971`) returns on a cache hit without writing a ledger step;
 * this guard preserves that, which the characterization suite pins.
 *
 * The interceptor is a shared singleton; the ledger is a constructor
 * dependency, while `taskId`/`fenceToken`/`allowMutatingRetry` ride the call.
 */
export function createReplayInterceptor(opts: {
  ledger: Ledger;
}): ToolInterceptor {
  const ledger = opts.ledger;
  return {
    name: "replay",
    async around(dispatch, next) {
      const call = dispatch.call;
      const taskId = call.taskId;
      const owner = call.owner;
      const toolCallId = call.toolCallId;

      // The mutating-retry rule never depends on ledger context. Enforce it
      // first so a missing taskId/owner cannot fail open.
      const refuseMutatingRetry = (message: string): void => {
        if (!call.allowMutatingRetry && !canRetryTool({ readOnly: call.readOnly })) {
          throw new JobError("tool_retry_forbidden", message);
        }
      };

      if (toolCallId === undefined) {
        refuseMutatingRetry(
          `tool '${call.tool}' of plugin '${call.pluginId}' is not read-only and has ` +
            "no stored result; refusing to re-execute a possibly-applied side effect",
        );
        await next();
        return;
      }

      if (taskId === undefined || owner === undefined) {
        // No job ledger context: replay dedupe cannot apply, but the
        // mutating-retry rule must still be enforced (fail closed).
        refuseMutatingRetry(
          `tool '${call.tool}' of plugin '${call.pluginId}' is not read-only and has ` +
            "no ledger context; refusing to re-execute a possibly-applied side effect",
        );
        await next();
        return;
      }

      if (hasToolResult(ledger, { taskId, owner, toolCallId })) {
        const step = ledger.getStepByToolCallId(taskId, toolCallId, owner);
        dispatch.content = boundToolResult(step?.result ?? "");
        dispatch.replayed = true;
        return;
      }
      refuseMutatingRetry(
        `tool '${call.tool}' of plugin '${call.pluginId}' is not read-only and has ` +
          "no stored result; refusing to re-execute a possibly-applied side effect",
      );
      await next();
      if (dispatch.executed && !dispatch.fromCache) {
        recordToolResult(ledger, {
          taskId,
          owner,
          fenceToken: call.fenceToken,
          toolCallId,
          toolName: call.tool,
          result: dispatch.content,
        });
      }
    },
  };
}
