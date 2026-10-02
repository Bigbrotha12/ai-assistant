import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import type { ToolInterceptor } from "../../../src/tools/pipeline.ts";
import { createGoalFenceInterceptor } from "../../../src/tools/interceptors/goal_fence.ts";
import { createSerializeInterceptor } from "../../../src/tools/interceptors/serialize.ts";
import { GoalError } from "../../../src/goals/errors.ts";
import type { GoalLedger } from "../../../src/goals/ledger.ts";
import { DEFAULT_TOOL_ARGS_MAX_BYTES } from "../../../src/tool_bounds.ts";
import { makeBodies, makeCall } from "../support.ts";

type FakeGoal = { status: string; lease_token: string | null };
type FakeStep = { status: string };

function fakeGoalLedger(opts: {
  goal: FakeGoal | null;
  step?: FakeStep;
}): { ledger: GoalLedger; getGoalCalls: () => number } {
  let calls = 0;
  const ledger = {
    getGoal(_id: string) {
      calls += 1;
      return opts.goal;
    },
    getStep(_id: string, _seq: number): FakeStep | undefined {
      return opts.step;
    },
  } as unknown as GoalLedger;
  return { ledger, getGoalCalls: () => calls };
}

function goalCall(overrides: Record<string, unknown> = {}) {
  return makeCall({
    channel: "goal",
    goalId: "goal-1",
    stepSeq: 1,
    goalLeaseToken: "lease-1",
    ...overrides,
  });
}

function isGoalCode(code: GoalError["code"]) {
  return (error: unknown) => error instanceof GoalError && error.code === code;
}

/**
 * The goal fence (4.3): a per-step guard built by the runner that rides
 * `goalId`/`stepSeq`/`goalLeaseToken` on `ToolCall`. It refuses the body when
 * the goal is no longer `running`, the lease token is stale, the goal row is
 * gone, the step was marked terminal by a control tool this round, or the
 * account-deletion tombstone fires (`assertActive`). It re-checks between the
 * fence pre-check and the body (`beforeBody`) so a pause landing mid-setup
 * still wins.
 */
describe("goal fence interceptor (4.3)", () => {
  test("a healthy executed call runs pre-check, beforeBody, and post-check", async () => {
    const { ledger, getGoalCalls } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
      step: { status: "running" },
    });
    let assertActiveCalls = 0;
    const pipeline = createToolPipeline({
      interceptors: [
        createGoalFenceInterceptor({
          ledger,
          goalId: "goal-1",
          assertActive: () => {
            assertActiveCalls += 1;
          },
        }),
      ],
    });
    const content = await pipeline.dispatch({
      call: goalCall(),
      bodies: makeBodies({
        plugin: async () => "ok",
      }),
    });
    assert.equal(content, "ok");
    assert.equal(
      getGoalCalls(),
      3,
      "pre-check, beforeBody, and post-check all run when executed",
    );
    assert.equal(assertActiveCalls, 3);
  });

  test("skips the post-check when a short-circuit leaves executed=false", async () => {
    const { ledger, getGoalCalls } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
      step: { status: "running" },
    });
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "hit";
      },
    };
    const pipeline = createToolPipeline({
      interceptors: [
        createGoalFenceInterceptor({ ledger, goalId: "goal-1" }),
        short,
      ],
    });
    const content = await pipeline.dispatch({
      call: goalCall(),
      bodies: makeBodies(),
    });
    assert.equal(content, "hit");
    assert.equal(getGoalCalls(), 1, "only the pre-check runs on a short-circuit");
  });

  test("throws GOAL_LEASE_CONFLICT before the body when the goal is not running", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "paused", lease_token: null },
      step: { status: "running" },
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      isGoalCode("GOAL_LEASE_CONFLICT"),
    );
    assert.equal(bodyRan, false);
  });

  test("throws GOAL_LEASE_CONFLICT when the lease token does not match", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "running", lease_token: "superseded" },
    });
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({ call: goalCall(), bodies: makeBodies() }),
      isGoalCode("GOAL_LEASE_CONFLICT"),
    );
  });

  test("throws GOAL_LEASE_CONFLICT when the goal row is missing", async () => {
    const { ledger } = fakeGoalLedger({ goal: null });
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({ call: goalCall(), bodies: makeBodies() }),
      isGoalCode("GOAL_LEASE_CONFLICT"),
    );
  });

  test("throws GOAL_INVALID_TRANSITION when the step was marked terminal (same-round race)", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
      step: { status: "terminal" },
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      isGoalCode("GOAL_INVALID_TRANSITION"),
    );
    assert.equal(bodyRan, false, "the sibling tool must not run after the step closed");
  });

  test("an absent step row (no terminal flag) passes the fence", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
    });
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    const content = await pipeline.dispatch({
      call: goalCall(),
      bodies: makeBodies({
        plugin: async () => "ok",
      }),
    });
    assert.equal(content, "ok");
  });

  test("an aborted signal short-circuits before any ledger read", async () => {
    const { ledger, getGoalCalls } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall({ signal: controller.signal }),
        bodies: makeBodies(),
      }),
      /cancelled/,
    );
    assert.equal(
      getGoalCalls(),
      0,
      "the signal is checked before the ledger read",
    );
  });

  test("assertActive failures (account-deletion tombstone) stop the body", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "running", lease_token: "lease-1" },
      step: { status: "running" },
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [
        createGoalFenceInterceptor({
          ledger,
          goalId: "goal-1",
          assertActive: () => {
            throw new Error("account deleted");
          },
        }),
      ],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      /account deleted/,
    );
    assert.equal(bodyRan, false);
  });

  test("the beforeBody re-check catches a goal paused between pre-check and body", async () => {
    let checks = 0;
    const ledger = {
      getGoal() {
        checks += 1;
        return checks === 1
          ? { status: "running", lease_token: "lease-1" }
          : { status: "paused", lease_token: null };
      },
      getStep() {
        return undefined;
      },
    } as unknown as GoalLedger;
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createGoalFenceInterceptor({ ledger, goalId: "goal-1" })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      isGoalCode("GOAL_LEASE_CONFLICT"),
    );
    assert.equal(bodyRan, false, "the body must not run after the goal is paused");
    assert.equal(
      checks,
      2,
      "the fence pre-check, then the beforeBody re-check catches the pause",
    );
  });

  test("GOAL_LEASE_CONFLICT wins over tool_args_too_large (fence before serialize)", async () => {
    const { ledger } = fakeGoalLedger({
      goal: { status: "failed", lease_token: null },
    });
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [
        createGoalFenceInterceptor({ ledger, goalId: "goal-1" }),
        createSerializeInterceptor(),
      ],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: goalCall({ args: { blob: "x".repeat(DEFAULT_TOOL_ARGS_MAX_BYTES + 1) } }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      isGoalCode("GOAL_LEASE_CONFLICT"),
      "the fence's GOAL_LEASE_CONFLICT must precede serialize's tool_args_too_large",
    );
    assert.equal(bodyRan, false);
  });
});
