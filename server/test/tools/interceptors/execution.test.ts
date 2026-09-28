import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createExecutionInterceptor } from "../../../src/tools/interceptors/execution.ts";
import { TOOL_RESULT_TRUNCATION_MARKER, ToolResourceError } from "../../../src/tool_bounds.ts";
import { makeBodies, makeCall } from "../support.ts";

function executionPipeline() {
  return createToolPipeline({ interceptors: [createExecutionInterceptor()] });
}

describe("execution interceptor", () => {
  test("bounds the body result by maxResultChars and assigns dispatch.content", async () => {
    const pipeline = executionPipeline();
    const body = async () => "x".repeat(500);
    const content = await pipeline.dispatch({
      call: makeCall({ maxResultChars: 40 }),
      bodies: makeBodies({ plugin: body }),
    });
    assert.equal(content.length, 40);
    assert.ok(content.endsWith(TOOL_RESULT_TRUNCATION_MARKER));
  });

  test("times out with tool_timeout and aborts the signal that reaches the body", async () => {
    let bodySignal: AbortSignal | undefined;
    const body = (_dispatch: unknown, signal: AbortSignal) => {
      bodySignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    let outcome: string | undefined;
    const pipeline = createToolPipeline({
      interceptors: [createExecutionInterceptor()],
      onResult: (_dispatch, result) => {
        outcome = result.outcome;
      },
    });
    await assert.rejects(
      pipeline.dispatch({ call: makeCall({ timeoutMs: 20 }), bodies: makeBodies({ plugin: body }) }),
      (error: unknown) =>
        error instanceof ToolResourceError &&
        error.code === "tool_timeout" &&
        error.limit === 20,
    );
    assert.equal(bodySignal?.aborted, true, "the timeout signal must reach the body");
    assert.equal(outcome, "timeout");
  });

  test("uses scope.track when present", async () => {
    let trackCalls = 0;
    const pipeline = createToolPipeline({ interceptors: [createExecutionInterceptor()] });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "tracked" }),
      scope: {
        track: async (work) => {
          trackCalls += 1;
          return work();
        },
      },
    });
    assert.equal(content, "tracked");
    assert.equal(trackCalls, 1);
  });

  test("fires onToolEnd when a hung handler ignores abort and the bound times out", async () => {
    const events: string[] = [];
    const pipeline = createToolPipeline({
      interceptors: [createExecutionInterceptor()],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ timeoutMs: 10 }),
        bodies: makeBodies({ plugin: () => new Promise<string>(() => undefined) }),
        scope: {
          onToolStart: () => events.push("start"),
          onToolEnd: () => events.push("end"),
        },
      }),
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_timeout",
    );
    assert.deepEqual(
      events,
      ["start", "end"],
      "onToolEnd must fire around the bounded race, not the raw body promise",
    );
  });
});
