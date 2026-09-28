import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_TOOL_INTERCEPTOR_ORDER,
  SYNC_TOOL_INTERCEPTOR_ORDER,
  createJobToolInterceptors,
  createSyncToolInterceptors,
} from "../../../src/tools/interceptors/order.ts";
import { bindPluginTools } from "../../../src/agents/orchestrator.ts";
import { createToolResultCache } from "../../../src/middleware/cache.ts";
import { createBudgetManager } from "../../../src/middleware/budget.ts";
import { credentialFingerprint } from "../../../src/plugins/credential.ts";
import {
  DEFAULT_TOOL_ARGS_MAX_BYTES,
  ToolResourceError,
} from "../../../src/tool_bounds.ts";
import type { ToolPluginDefinition } from "../../../src/plugins/types.ts";
import { makeLedger } from "../support.ts";

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
        credentialsByPlugin: { vikunja: { apiKey: "tok-123" } },
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
        credentialsByPlugin: { vikunja: { apiKey: "tok-123" } },
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
