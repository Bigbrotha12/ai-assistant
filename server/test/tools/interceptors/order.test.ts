import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_TOOL_INTERCEPTOR_ORDER,
  JOB_TOOL_INTERCEPTOR_ORDER,
  SYNC_TOOL_INTERCEPTOR_ORDER,
  createGoalToolInterceptors,
  createJobToolInterceptors,
  createSyncToolInterceptors,
} from "../../../src/tools/interceptors/order.ts";
import { bindPluginTools } from "../../../src/agents/orchestrator.ts";
import { buildPipelineForChannel } from "../../../src/tools/channel.ts";
import { RequestBodyCredentialResolver } from "../../../src/credentials/request_body.ts";
import { createToolResultCache } from "../../../src/managers/cache.ts";
import { createBudgetManager } from "../../../src/managers/budget.ts";
import { credentialFingerprint } from "../../../src/plugins/credential.ts";
import {
  DEFAULT_TOOL_ARGS_MAX_BYTES,
  ToolResourceError,
} from "../../../src/tools/bounds.ts";
import { GoalError } from "../../../src/goals/errors.ts";
import type { GoalLedger } from "../../../src/goals/ledger.ts";
import type { ToolPluginDefinition } from "../../../src/plugins/types.ts";
import { makeBodies, makeCall, makeLedger } from "../support.ts";

describe("job interceptor order", () => {
  test("the factory emits exactly the documented canonical order", () => {
    const ledger = makeLedger();
    const interceptors = createJobToolInterceptors({ ledger });
    assert.deepEqual(
      interceptors.map((interceptor) => interceptor.name),
      [...JOB_TOOL_INTERCEPTOR_ORDER],
    );
  });

  test("load-bearing pairings: fence<serialize, replay<cache, budget<execution", () => {
    const ledger = makeLedger();
    const names = createJobToolInterceptors({ ledger }).map(
      (interceptor) => interceptor.name,
    );
    assert.ok(names.indexOf("fence") < names.indexOf("serialize"));
    assert.ok(names.indexOf("replay") < names.indexOf("cache"));
    assert.ok(
      names.indexOf("budget") < names.indexOf("execution"),
      "budget must wrap execution for quarantine to fire",
    );
  });
});

describe("sync interceptor order", () => {
  test("the factory emits exactly the documented canonical order", () => {
    const interceptors = createSyncToolInterceptors({});
    assert.deepEqual(
      interceptors.map((interceptor) => interceptor.name),
      [...SYNC_TOOL_INTERCEPTOR_ORDER],
    );
  });

  test("omits the two job-only interceptors (fence, replay)", () => {
    const names = createSyncToolInterceptors({}).map((interceptor) => interceptor.name);
    assert.equal(names.includes("fence"), false);
    assert.equal(names.includes("replay"), false);
  });

  test("budget wraps execution so sync quarantine can fire (D7)", () => {
    const names = createSyncToolInterceptors({}).map((interceptor) => interceptor.name);
    assert.ok(
      names.indexOf("budget") < names.indexOf("execution"),
      "budget must be OUTER of execution for quarantine to fire",
    );
  });
});

/** One read-only tool, enough to drive the real sync binding. */
function syncToolPlugin(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.4.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "tool",
    baseUrls: [],
    credentials: { apiKey: { label: "Token", required: true } },
    tools: [
      { name: "list_tasks", description: "list", readOnly: true, inputSchema: { type: "object" } },
    ],
  };
}

/**
 * The factory-order tests above only compare two hand-maintained
 * representations. These drive the REAL `bindPluginTools` binding and assert
 * the order behaviourally, so a regression that reorders (or drops) an
 * interceptor in the binding is caught.
 */
describe("sync binding dispatches in the factory order (m2)", () => {
  test("serialize runs OUTSIDE cache: a cache hit cannot bypass args bounds", async (t) => {
    const cache = createToolResultCache();
    t.after(() => cache.dispose());
    const [tool] = bindPluginTools(
      { listInstalledPlugins: () => [syncToolPlugin()] } as never,
      { execute: async () => "EXECUTED" },
      undefined,
      {
        owner: "user-1",
        channel: "sync-stateless",
        cache,
        credentialsResolver: new RequestBodyCredentialResolver({ toolCredentialsByPlugin: { vikunja: { apiKey: "tok-123" } } }),
      },
    );
    const oversized: Record<string, unknown> = {
      blob: "x".repeat(DEFAULT_TOOL_ARGS_MAX_BYTES + 1),
    };
    // A matching entry exists: a cache-first pipeline would serve it. The
    // binding's serialize-first order must reject the args instead.
    cache.set(
      {
        owner: "user-1",
        pluginId: "vikunja",
        pluginVersion: "1.4.0",
        credentialFingerprint: credentialFingerprint({ apiKey: "tok-123" }),
        tool: "list_tasks",
        argsHash: cache.argsHash(oversized),
      },
      "CACHED-SHOULD-NOT-SERVE",
    );
    await assert.rejects(
      Promise.resolve(tool!.func(oversized, undefined, { toolCall: { id: "c1" } } as never)),
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_args_too_large",
    );
  });

  test("cache runs OUTSIDE budget: a hit is served with the plugin slot saturated", async (t) => {
    const cache = createToolResultCache();
    t.after(() => cache.dispose());
    const budget = createBudgetManager({
      maxToolCallsPerPlugin: 1,
      maxToolCallsPerOwner: 10,
      maxGlobalToolCalls: 10,
    });
    // Hold the plugin's only slot directly on the budget, so a budget-first
    // binding would reject before the cache is consulted.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = budget.withToolCallBudget("user-1", "vikunja", async () => {
      await held;
      return "held";
    });
    const [tool] = bindPluginTools(
      { listInstalledPlugins: () => [syncToolPlugin()] } as never,
      { execute: async () => "EXECUTED" },
      undefined,
      {
        owner: "user-1",
        channel: "sync-stateless",
        cache,
        budget,
        credentialsResolver: new RequestBodyCredentialResolver({ toolCredentialsByPlugin: { vikunja: { apiKey: "tok-123" } } }),
      },
    );
    cache.set(
      {
        owner: "user-1",
        pluginId: "vikunja",
        pluginVersion: "1.4.0",
        credentialFingerprint: credentialFingerprint({ apiKey: "tok-123" }),
        tool: "list_tasks",
        argsHash: cache.argsHash({}),
      },
      "CACHED-SHOULD-SERVE",
    );
    const result = await tool!.func({}, undefined, { toolCall: { id: "c2" } } as never);
    assert.equal(result, "CACHED-SHOULD-SERVE", "the cache hit is served outside budget");
    release();
    await inFlight;
  });
});

/** A goal ledger stub — the goal fence reads it only at dispatch time. */
function fakeGoalLedger(): GoalLedger {
  return {
    getGoal: () => null,
    getStep: () => undefined,
  } as unknown as GoalLedger;
}

describe("goal interceptor order (4.4 / M4/6.6)", () => {
  test("the factory emits exactly the documented canonical order", () => {
    const interceptors = createGoalToolInterceptors({
      ledger: fakeGoalLedger(),
      goalId: "goal-1",
    });
    assert.deepEqual(
      interceptors.map((interceptor) => interceptor.name),
      // Spelled out, not just compared to the constant: this catches the
      // constant and the factory drifting together.
      [
        "fence",
        "serialize",
        "authorize",
        "cache",
        "budget",
        "reserve",
        "execution",
      ],
    );
    assert.deepEqual(
      interceptors.map((interceptor) => interceptor.name),
      [...GOAL_TOOL_INTERCEPTOR_ORDER],
    );
  });

  test("load-bearing pairings: fence<serialize, serialize<authorize<cache, budget<reserve<execution, and no replay", () => {
    const names = createGoalToolInterceptors({
      ledger: fakeGoalLedger(),
      goalId: "goal-1",
    }).map((interceptor) => interceptor.name);
    assert.ok(
      names.indexOf("fence") < names.indexOf("serialize"),
      "a GOAL_LEASE_CONFLICT must win over tool_args_too_large",
    );
    assert.ok(
      names.indexOf("serialize") < names.indexOf("authorize"),
      "a refusal must be recorded against args that already passed the bounds",
    );
    assert.ok(
      names.indexOf("authorize") < names.indexOf("cache"),
      "an unauthorised call must not pay cache admission",
    );
    assert.ok(
      names.indexOf("budget") < names.indexOf("reserve"),
      "reserve must sit inside budget",
    );
    assert.ok(
      names.indexOf("reserve") < names.indexOf("execution"),
      "reserve must observe the body outcome (inside execution's bound)",
    );
    assert.ok(
      names.indexOf("budget") < names.indexOf("execution"),
      "budget must wrap execution for quarantine to fire",
    );
    assert.ok(!names.includes("replay"), "a step is never re-run (F3a)");
  });

  test("buildPipelineForChannel('goal') requires a goal ledger and a goal id", () => {
    assert.throws(
      () => buildPipelineForChannel("goal", {}),
      /goal ledger/,
    );
    assert.throws(
      () => buildPipelineForChannel("goal", { goalLedger: fakeGoalLedger() }),
      /goal id/,
    );
  });

  test("GOAL_LEASE_CONFLICT wins over tool_args_too_large through the real goal pipeline", async () => {
    const ledger = {
      getGoal: () => ({ status: "paused", lease_token: null }),
      getStep: () => undefined,
    } as unknown as GoalLedger;
    const pipeline = buildPipelineForChannel("goal", {
      goalLedger: ledger,
      goalId: "goal-1",
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({
          channel: "goal",
          goalId: "goal-1",
          stepSeq: 1,
          goalLeaseToken: "lease-1",
          args: { blob: "x".repeat(DEFAULT_TOOL_ARGS_MAX_BYTES + 1) },
        }),
        bodies: makeBodies(),
      }),
      (error: unknown) =>
        error instanceof GoalError && error.code === "GOAL_LEASE_CONFLICT",
      "the fence's GOAL_LEASE_CONFLICT must precede serialize's tool_args_too_large",
    );
  });
});
