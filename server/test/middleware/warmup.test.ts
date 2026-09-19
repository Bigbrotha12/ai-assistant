import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import { createWarmupManager, type WarmupAdmission, type WarmupOptions } from "../../src/middleware/warmup.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";

function setup(t: TestContext, overrides: Partial<WarmupOptions> = {}) {
  const plugin: ToolPluginDefinition = {
    id: "tasks", type: "tool", name: "Tasks", description: "Tasks", version: "1.0.0",
    schemaVersion: 1, baseUrls: [],
    credentials: { apiKey: { label: "Key", required: true } },
    tools: [
      { name: "list", description: "List", readOnly: true, inputSchema: { type: "object" } },
      { name: "delete", description: "Delete", readOnly: false, inputSchema: { type: "object" } },
    ],
  };
  const cache = createToolResultCache();
  const budget = createBudgetManager();
  const executions: unknown[] = [];
  const manager = createWarmupManager({
    enabled: true,
    registry: { requirePlugin: () => plugin },
    cache,
    budget,
    createHandler: () => ({ execute: async (...args) => { executions.push(args); return "result"; } }),
    ...overrides,
  });
  t.after(() => { manager.dispose(); cache.dispose(); });
  const call = { owner: "user", pluginId: "tasks", tool: "list", args: { page: 1 }, credentials: { apiKey: "secret" } };
  return { manager, cache, budget, executions, plugin, call };
}

function admitted(admission: WarmupAdmission) {
  assert.ok(admission.ok);
  return admission.done;
}

describe("warmups", () => {
  it("is disabled by default without touching registry, executor or budget", (t) => {
    const { manager, executions, budget, call } = setup(t, {
      enabled: undefined,
      registry: { requirePlugin() { throw new Error("must not resolve"); } },
    });
    assert.deepEqual(manager.schedule(call), { ok: false, reason: "disabled" });
    assert.equal(executions.length, 0);
    assert.equal(budget.activeCount("user"), 0);
  });

  it("only executes registered read-only tools with valid credentials", (t) => {
    const { manager, executions, budget, call, plugin } = setup(t);
    assert.deepEqual(manager.schedule({ ...call, tool: "delete" }), { ok: false, reason: "not_read_only" });
    assert.deepEqual(manager.schedule({ ...call, tool: "unknown" }), { ok: false, reason: "not_read_only" });
    assert.deepEqual(manager.schedule({ ...call, credentials: {} }), { ok: false, reason: "invalid_credentials" });
    assert.deepEqual(manager.schedule({ ...call, owner: " " }), { ok: false, reason: "invalid_request" });
    plugin.type = "model" as "tool";
    assert.deepEqual(manager.schedule(call), { ok: false, reason: "not_read_only" });
    assert.equal(executions.length, 0);
    assert.equal(budget.activeCount("user"), 0);
  });

  it("runs in background, snapshots inputs, uses shared cache keys and avoids charging tool-only work", async (t) => {
    const { manager, executions, cache, budget, call } = setup(t);
    const done = admitted(manager.schedule(call));
    assert.equal(executions.length, 0);
    call.args.page = 9;
    call.credentials.apiKey = "changed";
    assert.deepEqual(await done, { status: "warmed" });
    assert.deepEqual(executions[0], ["tasks", "list", { page: 1 }, { apiKey: "secret" }]);
    assert.equal(cache.get({
      owner: "user", pluginId: "tasks", pluginVersion: "1.0.0", tool: "list",
      credentialFingerprint: credentialFingerprint({ apiKey: "secret" }), argsHash: cache.argsHash({ page: 1 }),
    }), "result");
    assert.equal(budget.modelCallCount("user"), 0);
    assert.equal(budget.activeCount("user"), 0);
    assert.equal(manager.activeCount, 0);
    assert.deepEqual(await admitted(manager.schedule({ ...call, args: { page: 1 }, credentials: { apiKey: "secret" } })), { status: "cached" });
    assert.equal(executions.length, 1);
  });

  it("isolates cache by owner, credential rotation, version and arguments", async (t) => {
    const { manager, executions, call, plugin, cache } = setup(t);
    await admitted(manager.schedule(call));
    await admitted(manager.schedule({ ...call, owner: "other" }));
    await admitted(manager.schedule({ ...call, credentials: { apiKey: "rotated" } }));
    await admitted(manager.schedule({ ...call, args: { page: 2 } }));
    plugin.version = "2.0.0";
    await admitted(manager.schedule(call));
    assert.equal(executions.length, 5);
    cache.invalidateForUser("user");
    await admitted(manager.schedule(call));
    assert.equal(executions.length, 6);
  });

  it("rechecks read-only policy before background dispatch", async (t) => {
    const { manager, executions, call, plugin } = setup(t);
    const done = admitted(manager.schedule(call));
    plugin.tools[0]!.readOnly = false;
    assert.deepEqual(await done, { status: "cancelled" });
    assert.equal(executions.length, 0);
    assert.equal(manager.activeCount, 0);
  });

  it("bounds background work globally and shares per-owner concurrency without queueing", async (t) => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const { manager, call, budget } = setup(t, {
      maxConcurrent: 1,
      createHandler: () => ({ execute: async () => { await blocker; return "result"; } }),
    });
    const done = admitted(manager.schedule(call));
    assert.deepEqual(manager.schedule(call), { ok: false, reason: "busy" });
    assert.deepEqual(manager.schedule({ ...call, owner: "other" }), { ok: false, reason: "busy" });
    assert.equal(budget.activeCount("user"), 1);
    release();
    await done;
    const first = budget.reserveSync("user");
    const second = budget.reserveSync("user");
    assert.ok(first.ok && second.ok);
    assert.deepEqual(manager.schedule({ ...call, args: { page: 2 } }), { ok: false, reason: "busy" });
    first.release();
    second.release();
  });

  it("deduplicates identical in-flight cache keys below the global cap", async (t) => {
    const { manager, call } = setup(t, { maxConcurrent: 3 });
    const done = admitted(manager.schedule(call));
    assert.deepEqual(manager.schedule(call), { ok: false, reason: "busy" });
    await done;
  });

  it("attributes every model dispatch to the owner and returns explicit exhaustion", async (t) => {
    const budget = createBudgetManager({ maxModelCallsPerWindow: 2 });
    budget.beforeModelCall("user", "vision");
    let dispatched = 0;
    const { manager, cache, call } = setup(t, {
      budget,
      createHandler: ({ owner, beforeModelCall }) => ({
        execute: async () => {
          assert.equal(owner, "user");
          beforeModelCall();
          dispatched += 1;
          beforeModelCall();
          dispatched += 1;
          return "unreachable";
        },
      }),
    });
    const result = await admitted(manager.schedule(call));
    assert.equal(result.status, "budget_exhausted");
    assert.equal(dispatched, 1);
    assert.equal(budget.modelCallCount("user"), 2);
    assert.equal(budget.modelCallCount("other"), 0);
    assert.equal(budget.activeCount("user"), 0);
    assert.equal(cache.size, 0);
  });

  it("settles failures without exposing secrets or caching and releases slots", async (t) => {
    const { manager, budget, cache, call } = setup(t, {
      createHandler: () => { throw new Error("secret credential value"); },
    });
    assert.deepEqual(await admitted(manager.schedule(call)), { status: "failed" });
    assert.equal(budget.activeCount("user"), 0);
    assert.equal(cache.size, 0);
  });

  it("times out without freeing capacity for still-running work or caching late results", async (t) => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let hook!: () => void;
    const { manager, call, cache, budget } = setup(t, {
      timeoutMs: 5, maxConcurrent: 1,
      createHandler: ({ beforeModelCall }) => {
        hook = beforeModelCall;
        return { execute: async () => { await blocker; return "late"; } };
      },
    });
    const done = admitted(manager.schedule(call));
    await delay(15);
    assert.deepEqual(await done, { status: "timed_out" });
    assert.throws(() => hook());
    assert.equal(budget.modelCallCount("user"), 0);
    assert.equal(manager.activeCount, 1);
    assert.deepEqual(manager.schedule({ ...call, owner: "other" }), { ok: false, reason: "busy" });
    release();
    await tick();
    assert.equal(manager.activeCount, 0);
    assert.equal(budget.activeCount("user"), 0);
    assert.equal(cache.size, 0);
  });

  it("dispose cancels scheduled work and rejects future admissions", async (t) => {
    const { manager, call, executions, budget } = setup(t);
    const done = admitted(manager.schedule(call));
    manager.dispose();
    manager.dispose();
    assert.deepEqual(await done, { status: "cancelled" });
    await tick();
    assert.equal(executions.length, 0);
    assert.equal(budget.activeCount("user"), 0);
    assert.deepEqual(manager.schedule(call), { ok: false, reason: "disposed" });
  });
});
