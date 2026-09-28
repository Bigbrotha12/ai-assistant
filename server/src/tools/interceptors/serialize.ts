import { serializeBoundedToolArguments } from "../../tool_bounds.ts";
import type { ToolInterceptor } from "../pipeline.ts";

/**
 * `serialize` interceptor — validates and measures the call arguments.
 *
 * Sets `dispatch.inputBytes` from `serializeBoundedToolArguments(call.args)`,
 * which also enforces the args size/depth/serializability bounds. It is
 * deliberately an interceptor (registered AFTER `fence`, BEFORE
 * `replay`/`cache`) rather than a pipeline prologue: that ordering preserves the
 * job path's error precedence — a `task_conflict` from `fence` must win over a
 * `tool_args_too_large` from serialization.
 *
 * If serialization throws, the pipeline core still settles `onResult` with
 * `outcome:"error"` and the `tool_args_*` code, then rethrows.
 */
export function createSerializeInterceptor(): ToolInterceptor {
  return {
    name: "serialize",
    async around(dispatch, next) {
      dispatch.inputBytes = Buffer.byteLength(
        serializeBoundedToolArguments(dispatch.call.args),
        "utf8",
      );
      await next();
    },
  };
}
