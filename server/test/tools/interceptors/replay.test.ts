import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createReplayInterceptor } from "../../../src/tools/interceptors/replay.ts";
import { createCacheInterceptor } from "../../../src/tools/interceptors/cache.ts";
import type { ToolCallResult } from "../../../src/tools/pipeline.ts";
import type { Ledger, StepRow } from "../../../src/ledger.ts";
import { recordToolResult } from "../../../src/credentials/idempotency.ts";
import { createToolResultCache } from "../../../src/middleware/cache.ts";
import { JobError } from "../../../src/jobs/runner.ts";
import { makeBodies, makeCall, makeLedger, makeRunningTask } from "../support.ts";

function toolSteps(ledger: Ledger, taskId: string): StepRow[] {
  return ledger.listSteps(taskId).filter((step) => step.action.startsWith("tool:"));
}

describe("replay interceptor", () => {
  test("a stored result short-circuits with replayed=true and does not run the body", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    recordToolResult(ledger, {
      taskId,
      owner: "user-1",
      fenceToken,
      toolCallId: "call_done",
      toolName: "create_task",
      result: '{"already":"applied"}',
    });
    let bodyCalls = 0;
    const results: ToolCallResult[] = [];
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
      onResult: (_dispatch, result) => results.push(result),
    });
    const content = await pipeline.dispatch({
      call: makeCall({
        channel: "job",
        tool: "create_task",
        readOnly: false,
        toolCallId: "call_done",
        taskId,
        owner: "user-1",
        fenceToken,
        allowMutatingRetry: false,
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyCalls += 1;
          return "never";
        },
      }),
    });
    assert.equal(content, '{"already":"applied"}');
    assert.equal(bodyCalls, 0);
    assert.equal(results[0]!.replayed, true);
    assert.equal(results[0]!.outcome, "ok");
    assert.equal(
      results[0]!.outputBytes,
      Buffer.byteLength('{"already":"applied"}', "utf8"),
      "outputBytes is computed from the replayed content",
    );
  });

  test("an anonymous read-only invocation executes and writes no ledger step", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await pipeline.dispatch({
      call: makeCall({
        channel: "job",
        toolCallId: undefined,
        taskId,
        owner: "user-1",
        fenceToken,
        allowMutatingRetry: false,
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyCalls += 1;
          return "ok";
        },
      }),
    });
    assert.equal(bodyCalls, 1);
    assert.deepEqual(toolSteps(ledger, taskId), []);
  });

  test("an anonymous mutating invocation is refused without allowMutatingRetry", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({
          channel: "job",
          tool: "create_task",
          readOnly: false,
          toolCallId: undefined,
          taskId,
          owner: "user-1",
          fenceToken,
          allowMutatingRetry: false,
        }),
        bodies: makeBodies({
          plugin: async () => {
            bodyCalls += 1;
            return "never";
          },
        }),
      }),
      (error: unknown) =>
        error instanceof JobError && error.code === "tool_retry_forbidden",
    );
    assert.equal(bodyCalls, 0);
  });

  test("a named mutating invocation with no stored result is refused", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({
          channel: "job",
          tool: "create_task",
          readOnly: false,
          toolCallId: "call_new",
          taskId,
          owner: "user-1",
          fenceToken,
          allowMutatingRetry: false,
        }),
        bodies: makeBodies({
          plugin: async () => {
            bodyCalls += 1;
            return "never";
          },
        }),
      }),
      (error: unknown) =>
        error instanceof JobError && error.code === "tool_retry_forbidden",
    );
    assert.equal(bodyCalls, 0);
  });

  test("an executed call records one ledger step with its tool_call_id", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await pipeline.dispatch({
      call: makeCall({
        channel: "job",
        toolCallId: "call_exec",
        taskId,
        owner: "user-1",
        fenceToken,
        allowMutatingRetry: true,
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyCalls += 1;
          return '{"fresh":true}';
        },
      }),
    });
    assert.equal(bodyCalls, 1);
    const steps = toolSteps(ledger, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.tool_call_id, "call_exec");
  });

  test("a cache hit does NOT write a ledger step (executed && !fromCache guard)", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const cache = createToolResultCache();
    const args = {};
    const key = {
      owner: "user-1",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: "fp-cache",
      tool: "list_tasks",
      argsHash: cache.argsHash(args),
    };
    cache.set(key, "CACHED");
    try {
      let bodyCalls = 0;
      const pipeline = createToolPipeline({
        interceptors: [createReplayInterceptor({ ledger }), createCacheInterceptor({ cache })],
      });
      const content = await pipeline.dispatch({
        call: makeCall({
          channel: "job",
          toolCallId: "call_cache",
          taskId,
          owner: "user-1",
          fenceToken,
          allowMutatingRetry: true,
          credentialFingerprint: "fp-cache",
          args,
        }),
        bodies: makeBodies({
          plugin: async () => {
            bodyCalls += 1;
            return "never";
          },
        }),
      });
      assert.equal(content, "CACHED");
      assert.equal(bodyCalls, 0);
      assert.deepEqual(
        toolSteps(ledger, taskId),
        [],
        "a cache hit must not be recorded to the ledger",
      );
    } finally {
      cache.dispose();
    }
  });

  test("allowMutatingRetry=true executes and records a named mutating call with no stored result", async () => {
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await pipeline.dispatch({
      call: makeCall({
        channel: "job",
        tool: "create_task",
        readOnly: false,
        toolCallId: "call_retry",
        taskId,
        owner: "user-1",
        fenceToken,
        allowMutatingRetry: true,
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyCalls += 1;
          return "applied";
        },
      }),
    });
    assert.equal(bodyCalls, 1);
    assert.equal(toolSteps(ledger, taskId).length, 1);
  });

  test("fails closed on a mutating call with no job context (taskId/owner absent)", async () => {
    const ledger = makeLedger();
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({
          channel: "job",
          tool: "create_task",
          readOnly: false,
          toolCallId: "call_orphan",
          allowMutatingRetry: false,
        }),
        bodies: makeBodies({
          plugin: async () => {
            bodyCalls += 1;
            return "never";
          },
        }),
      }),
      (error: unknown) =>
        error instanceof JobError && error.code === "tool_retry_forbidden",
    );
    assert.equal(bodyCalls, 0);
  });

  test("a read-only call with no job context still executes", async () => {
    const ledger = makeLedger();
    let bodyCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createReplayInterceptor({ ledger })],
    });
    const content = await pipeline.dispatch({
      call: makeCall({ channel: "job", toolCallId: undefined }),
      bodies: makeBodies({
        plugin: async () => {
          bodyCalls += 1;
          return "ok";
        },
      }),
    });
    assert.equal(content, "ok");
    assert.equal(bodyCalls, 1);
  });
});
