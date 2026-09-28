import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createBudgetInterceptor } from "../../../src/tools/interceptors/budget.ts";
import { createExecutionInterceptor } from "../../../src/tools/interceptors/execution.ts";
import {
  BudgetExhaustedError,
  createBudgetManager,
  DEFAULT_TOOL_CALL_QUARANTINE_MS,
} from "../../../src/middleware/budget.ts";
import type {
  BudgetManager,
  ToolCallBudgetOptions,
} from "../../../src/middleware/budget.ts";
import { ToolResourceError } from "../../../src/tool_bounds.ts";
import type { ToolCallScope, ToolInterceptor } from "../../../src/tools/pipeline.ts";
import { createTrackedExecution } from "../../../src/agents/execution.ts";
import { makeBodies, makeCall } from "../support.ts";

type Captured = { owner: string; pluginId: string; options?: ToolCallBudgetOptions };

/** A minimal BudgetManager stub that records its call and runs the work. */
function fakeBudget(captured: Captured[]): BudgetManager {
  return {
    async withToolCallBudget(
      owner: string,
      pluginId: string,
      run: () => Promise<unknown>,
      options?: ToolCallBudgetOptions,
    ) {
      captured.push({ owner, pluginId, options });
      return run();
    },
  } as unknown as BudgetManager;
}

describe("budget interceptor", () => {
  test("passes rawSettled and call.timeoutMs to withToolCallBudget", async () => {
    const captured: Captured[] = [];
    let resolveRaw!: () => void;
    const rawSettled = new Promise<void>((resolve) => {
      resolveRaw = resolve;
    });
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget: fakeBudget(captured) })],
    });
    await pipeline.dispatch({
      call: makeCall({ timeoutMs: 1234, requestId: "req-1", owner: "user-1" }),
      bodies: makeBodies({ plugin: async () => "ok" }),
      scope: { rawSettled },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.owner, "user-1");
    assert.equal(captured[0]!.pluginId, "vikunja");
    assert.equal(captured[0]!.options?.timeoutMs, 1234);
    assert.equal(captured[0]!.options?.tool, "list_tasks");
    assert.equal(captured[0]!.options?.requestId, "req-1");
    assert.equal(captured[0]!.options?.rawSettled, rawSettled);
    resolveRaw();
  });

  test("registers trackUntil with the quarantine deadline and the raw predicate", async () => {
    const captured: Captured[] = [];
    const trackUntilCalls: Array<{ predicate: () => Promise<void>; ms: number }> = [];
    let resolveRaw!: () => void;
    const rawSettled = new Promise<void>((resolve) => {
      resolveRaw = resolve;
    });
    const scope: ToolCallScope = {
      rawSettled,
      trackUntil: (predicate, ms) => {
        trackUntilCalls.push({ predicate, ms });
      },
    };
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget: fakeBudget(captured) })],
    });
    await pipeline.dispatch({
      call: makeCall({ timeoutMs: 50 }),
      bodies: makeBodies({ plugin: async () => "ok" }),
      scope,
    });
    assert.equal(trackUntilCalls.length, 1);
    assert.equal(trackUntilCalls[0]!.ms, 50 + DEFAULT_TOOL_CALL_QUARANTINE_MS);
    assert.equal(trackUntilCalls[0]!.predicate(), rawSettled);
    resolveRaw();
  });

  test("is a pass-through when no budget is configured", async () => {
    const trackUntilCalls: number[] = [];
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({})],
    });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "ok";
        },
      }),
      scope: { trackUntil: (_predicate, ms) => trackUntilCalls.push(ms) },
    });
    assert.equal(content, "ok");
    assert.equal(bodyRan, true);
    assert.deepEqual(trackUntilCalls, []);
  });

  test("propagates a body rejection through the budget wrapper", async () => {
    const captured: Captured[] = [];
    const boom = new Error("tool failed");
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget: fakeBudget(captured) })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({ plugin: async () => Promise.reject(boom) }),
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(captured.length, 1);
  });

  test("does not register trackUntil when admission rejects", async () => {
    const trackUntilCalls: number[] = [];
    const rejecting = {
      async withToolCallBudget() {
        throw new BudgetExhaustedError(1, Date.now() + 1_000);
      },
    } as unknown as BudgetManager;
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget: rejecting })],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ owner: "user-1" }),
        bodies: makeBodies(),
        scope: {
          rawSettled: new Promise<void>(() => {}),
          trackUntil: (_predicate, ms) => {
            trackUntilCalls.push(ms);
          },
        },
      }),
      (error: unknown) => error instanceof BudgetExhaustedError,
    );
    assert.deepEqual(
      trackUntilCalls,
      [],
      "a rejected admission must not leave a tracked promise pending",
    );
  });

  test("quarantine still fires when execution bounds a hung handler", async () => {
    // The realistic composition: budget OUTER of execution, with the channel's
    // rawSettled resolved only when the RAW body settles. A hung handler never
    // resolves it, so budget must quarantine when the bounded race settles.
    const budget = createBudgetManager({
      toolCallTimeoutMs: 5,
      toolCallQuarantineMs: DEFAULT_TOOL_CALL_QUARANTINE_MS,
    });
    const events: string[] = [];
    const scope: ToolCallScope = {
      rawSettled: new Promise<void>(() => {}),
      onToolStart: () => events.push("start"),
      onToolEnd: () => events.push("end"),
    };
    const pipeline = createToolPipeline({
      interceptors: [
        createBudgetInterceptor({ budget }),
        createExecutionInterceptor(),
      ],
    });
    const call = makeCall({
      owner: "user-1",
      pluginId: "vikunja",
      tool: "list_tasks",
      timeoutMs: 5,
    });
    await assert.rejects(
      pipeline.dispatch({
        call,
        bodies: makeBodies({ plugin: () => new Promise<string>(() => undefined) }),
        scope,
      }),
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_timeout",
    );
    assert.equal(
      budget.pluginToolCallCount("vikunja"),
      1,
      "the unsettled raw body holds its slot",
    );
    assert.deepEqual(events, ["start", "end"]);
    await assert.rejects(
      pipeline.dispatch({
        call,
        bodies: makeBodies({ plugin: async () => "never" }),
        scope,
      }),
      (error: unknown) => error instanceof BudgetExhaustedError,
    );
  });

  /** Common fixture for the pre-body-denial release tests. */
  function preBodyDenialFixture(): {
    budget: BudgetManager;
    execution: ReturnType<typeof createTrackedExecution>;
    scope: ToolCallScope;
    guard: ToolInterceptor;
    allowNext: () => void;
  } {
    const budget = createBudgetManager({
      toolCallTimeoutMs: 5,
      toolCallQuarantineMs: DEFAULT_TOOL_CALL_QUARANTINE_MS,
    });
    const execution = createTrackedExecution(new AbortController().signal);
    let deny = true;
    let settleRaw!: () => void;
    const rawSettled = new Promise<void>((resolve) => {
      settleRaw = resolve;
    });
    const scope: ToolCallScope = {
      rawSettled,
      onBodySkipped: () => settleRaw(),
      track: (work) => execution.track(work),
      trackUntil: (predicate, ms) => {
        void execution.trackUntil(predicate, ms);
      },
    };
    const guard: ToolInterceptor = {
      name: "guard",
      beforeBody: () => {
        if (deny) throw new Error("fence lost before body");
      },
      async around(_dispatch, next) {
        await next();
      },
    };
    return { budget, execution, scope, guard, allowNext: () => { deny = false; } };
  }

  test("a pre-body denial releases the budget slot instead of quarantining (D9)", async () => {
    const { budget, scope, guard, allowNext } = preBodyDenialFixture();
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget }), guard],
    });
    let bodyRan = false;
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ owner: "user-1", timeoutMs: 5 }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
        scope,
      }),
      /fence lost before body/,
    );
    assert.equal(bodyRan, false);
    // The channel's onBodySkipped resolved rawSettled, so budget released.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      budget.pluginToolCallCount("vikunja"),
      0,
      "a body-skipped dispatch releases its slot",
    );
    // A subsequent call on the same plugin is admitted, not quarantined.
    allowNext();
    const content = await pipeline.dispatch({
      call: makeCall({ owner: "user-1", timeoutMs: 5 }),
      bodies: makeBodies({ plugin: async () => "admitted" }),
      scope,
    });
    assert.equal(content, "admitted");
    assert.equal(budget.pluginToolCallCount("vikunja"), 0);
  });

  test("a pre-body denial does not hold execution.settle() open for the quarantine deadline (D9)", async () => {
    const { budget, execution, scope, guard } = preBodyDenialFixture();
    const pipeline = createToolPipeline({
      interceptors: [createBudgetInterceptor({ budget }), guard],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ owner: "user-1", timeoutMs: 5 }),
        bodies: makeBodies(),
        scope,
      }),
      /fence lost before body/,
    );
    const outcome = await Promise.race([
      execution.settle().then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(
      outcome,
      "settled",
      "the trackUntil deadline must not be held open on a never-started body",
    );
  });
});
