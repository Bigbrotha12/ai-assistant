import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createFenceInterceptor } from "../../../src/tools/interceptors/fence.ts";
import { createSerializeInterceptor } from "../../../src/tools/interceptors/serialize.ts";
import type { ToolInterceptor } from "../../../src/tools/pipeline.ts";
import type { Ledger } from "../../../src/ledger.ts";
import { JobError } from "../../../src/jobs/runner.ts";
import { DEFAULT_TOOL_ARGS_MAX_BYTES } from "../../../src/tool_bounds.ts";
import { makeBodies, makeCall } from "../support.ts";

type FakeTask = { status: string; fence_token: string };

function fakeLedger(
  handler: (taskId: string, owner?: string) => FakeTask | null,
): { ledger: Ledger; calls: () => number } {
  let calls = 0;
  const ledger = {
    getTask(taskId: string, owner?: string) {
      calls += 1;
      return handler(taskId, owner);
    },
  } as unknown as Ledger;
  return { ledger, calls: () => calls };
}

function jobCall(overrides: Record<string, unknown> = {}) {
  return makeCall({
    channel: "job",
    taskId: "task-1",
    owner: "user-1",
    fenceToken: "fence-1",
    ...overrides,
  });
}

describe("fence interceptor", () => {
  test("checks before and (when executed) after the body", async () => {
    const { ledger, calls } = fakeLedger(() => ({ status: "running", fence_token: "fence-1" }));
    let assertActiveCalls = 0;
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger, assertActive: () => { assertActiveCalls += 1; } })],
    });
    const content = await pipeline.dispatch({
      call: jobCall(),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "ok";
        },
      }),
    });
    assert.equal(content, "ok");
    assert.equal(bodyRan, true);
    assert.equal(
      calls(),
      3,
      "pre-check, beforeBody, and post-check all run when executed",
    );
    assert.equal(assertActiveCalls, 3);
  });

  test("skips the post-check when a short-circuit leaves executed=false", async () => {
    const { ledger, calls } = fakeLedger(() => ({ status: "running", fence_token: "fence-1" }));
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "hit";
      },
    };
    let assertActiveCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [
        createFenceInterceptor({ ledger, assertActive: () => { assertActiveCalls += 1; } }),
        short,
      ],
    });
    const content = await pipeline.dispatch({ call: jobCall(), bodies: makeBodies() });
    assert.equal(content, "hit");
    assert.equal(calls(), 1, "only the pre-check runs on a short-circuit");
    assert.equal(assertActiveCalls, 1);
  });

  test("throws task_conflict before the body when the task is not running", async () => {
    const { ledger } = fakeLedger(() => ({ status: "succeeded", fence_token: "fence-1" }));
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: jobCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      (error: unknown) => error instanceof JobError && error.code === "task_conflict",
    );
    assert.equal(bodyRan, false);
  });

  test("throws task_conflict when the fence token does not match", async () => {
    const { ledger } = fakeLedger(() => ({ status: "running", fence_token: "superseded" }));
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({ call: jobCall(), bodies: makeBodies() }),
      (error: unknown) => error instanceof JobError && error.code === "task_conflict",
    );
  });

  test("throws task_conflict from the post-check when the fence is lost during the body", async () => {
    let call = 0;
    const { ledger, calls } = fakeLedger(() => {
      call += 1;
      return call <= 2
        ? { status: "running", fence_token: "fence-1" }
        : { status: "cancelled", fence_token: "fence-1" };
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: jobCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "ok";
          },
        }),
      }),
      (error: unknown) => error instanceof JobError && error.code === "task_conflict",
    );
    assert.equal(bodyRan, true);
    assert.equal(calls(), 3, "pre-check, beforeBody, then the post-check catches it");
  });

  test("checks the channel signal before reading the ledger", async () => {
    const { ledger, calls } = fakeLedger(() => ({ status: "running", fence_token: "fence-1" }));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: jobCall({ signal: controller.signal }),
        bodies: makeBodies(),
      }),
      /cancelled/,
    );
    assert.equal(calls(), 0, "an aborted signal short-circuits before the ledger read");
  });

  test("task_conflict wins over tool_args_too_large (fence before serialize)", async () => {
    const { ledger } = fakeLedger(() => ({ status: "succeeded", fence_token: "fence-1" }));
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger }), createSerializeInterceptor()],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: jobCall({ args: { blob: "x".repeat(DEFAULT_TOOL_ARGS_MAX_BYTES + 1) } }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      (error: unknown) => error instanceof JobError && error.code === "task_conflict",
      "the fence's task_conflict must precede serialize's tool_args_too_large",
    );
    assert.equal(bodyRan, false);
  });

  test("the fence re-check catches a task cancelled during setup, before the body", async () => {
    // Pre-check sees a running task; the task is cancelled between the
    // pre-check and the body (serialize/replay/cache/budget setup). The
    // fence-supplied beforeBody must catch it and stop the body.
    let checks = 0;
    const { ledger, calls } = fakeLedger(() => {
      checks += 1;
      return checks === 1
        ? { status: "running", fence_token: "fence-1" }
        : { status: "cancelled", fence_token: "fence-1" };
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createFenceInterceptor({ ledger })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: jobCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      (error: unknown) => error instanceof JobError && error.code === "task_conflict",
    );
    assert.equal(bodyRan, false, "the body must not run after the task is cancelled");
    assert.equal(
      calls(),
      2,
      "fence pre-check, then the beforeBody re-check catches the cancellation",
    );
  });

  test("a healthy executed call runs pre-check, beforeBody, and post-check", async () => {
    const { ledger, calls } = fakeLedger(() => ({ status: "running", fence_token: "fence-1" }));
    let assertActiveCalls = 0;
    const events: string[] = [];
    const pipeline = createToolPipeline({
      interceptors: [
        createFenceInterceptor({
          ledger,
          assertActive: () => {
            assertActiveCalls += 1;
          },
        }),
      ],
    });
    await pipeline.dispatch({
      call: jobCall(),
      bodies: makeBodies({
        plugin: async () => {
          events.push("body");
          return "ok";
        },
      }),
    });
    assert.deepEqual(events, ["body"]);
    assert.equal(calls(), 3, "pre-check, beforeBody, and post-check all run");
    assert.equal(assertActiveCalls, 3);
  });
});
