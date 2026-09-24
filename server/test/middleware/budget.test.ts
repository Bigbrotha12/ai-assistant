import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BudgetExhaustedError, createBudgetManager } from "../../src/middleware/budget.ts";
import { logger } from "../../src/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";
import type {
  AsyncReservation,
  BudgetClearTimeout,
  BudgetSetTimeout,
  SyncReservation,
} from "../../src/middleware/budget.ts";

/** Narrow a reservation union to the admitted variant (throws otherwise). */
function claimed(r: AsyncReservation): { release: () => void; queued: boolean };
function claimed(r: SyncReservation): { release: () => void };
function claimed(
  r: AsyncReservation | SyncReservation,
): { release: () => void; queued?: boolean } {
  if (!r.ok) throw new Error("expected an admitted reservation");
  return r;
}

/** Fake clock with numeric timer ids, satisfying the budget's timer seams. */
function createFakeClock() {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout: ((handler: () => void) => {
      const id = nextId++;
      timers.set(id, handler);
      return id;
    }) as BudgetSetTimeout,
    clearTimeout: ((handle: unknown) => {
      timers.delete(handle as number);
    }) as BudgetClearTimeout,
    fire(id: number) {
      const handler = timers.get(id);
      assert.ok(handler, `no pending timer ${id}`);
      timers.delete(id);
      handler();
    },
    pendingCount: () => timers.size,
    ids: () => [...timers.keys()],
  };
}

describe("model dispatch budget", () => {
  it("shares one counter across sync, async, vision, compaction and warmup dispatches", () => {
    const budget = createBudgetManager({ maxModelCallsPerWindow: 5, now: () => 100 });
    for (const kind of ["sync", "async", "vision", "compaction", "warmup"] as const) {
      budget.beforeModelCall("user", kind);
    }
    assert.equal(budget.modelCallCount("user"), 5);
    assert.deepEqual(budget.reserveModelCall("user", "vision"), {
      ok: false, code: "budget_exhausted", retryAfterSeconds: 60, resetAt: 60_100,
    });
    assert.equal(budget.modelCallCount("user"), 5);
    assert.equal(budget.reserveModelCall("other").ok, true);
  });

  it("reserves synchronously before concurrent dispatches and fails explicitly mid-job", async () => {
    const budget = createBudgetManager({ maxModelCallsPerWindow: 2 });
    let dispatched = 0;
    const dispatch = async () => {
      budget.beforeModelCall("user", "async");
      dispatched += 1;
      await Promise.resolve();
    };
    const results = await Promise.allSettled([dispatch(), dispatch(), dispatch()]);
    assert.equal(dispatched, 2);
    assert.equal(results[2]?.status, "rejected");
    assert.throws(() => budget.beforeModelCall("user"), (error: unknown) => {
      assert.ok(error instanceof BudgetExhaustedError);
      assert.equal(error.code, "budget_exhausted");
      assert.ok(error.retryAfterSeconds > 0);
      return true;
    });
  });

  it("resets at the fixed owner window boundary with rounded Retry-After", () => {
    let now = 500;
    const budget = createBudgetManager({ maxModelCallsPerWindow: 1, modelCallWindowMs: 1500, now: () => now });
    assert.deepEqual(budget.reserveModelCall("user"), { ok: true, remaining: 0, resetAt: 2000 });
    now = 999;
    assert.deepEqual(budget.reserveModelCall("user"), {
      ok: false, code: "budget_exhausted", retryAfterSeconds: 2, resetAt: 2000,
    });
    now = 1999;
    assert.equal(budget.modelCallCount("user"), 1);
    now = 2000;
    assert.equal(budget.modelCallCount("user"), 0);
    assert.deepEqual(budget.reserveModelCall("user"), { ok: true, remaining: 0, resetAt: 3500 });
  });

  it("does not charge admission or refund dispatched failures when concurrency releases", async () => {
    const budget = createBudgetManager({ maxModelCallsPerWindow: 1 });
    const sync = claimed(budget.reserveSync("user"));
    const async = claimed(await budget.reserveAsync("user"));
    assert.equal(budget.modelCallCount("user"), 0);
    await assert.rejects(async () => {
      budget.beforeModelCall("user");
      throw new Error("provider failed");
    }, /provider failed/);
    sync.release();
    async.release();
    assert.equal(budget.activeCount("user"), 0);
    assert.equal(budget.reserveModelCall("user").ok, false);
  });

  it("validates call limits, windows and attribution", () => {
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createBudgetManager({ maxModelCallsPerWindow: value }));
      assert.throws(() => createBudgetManager({ modelCallWindowMs: value }));
    }
    const budget = createBudgetManager();
    assert.throws(() => budget.beforeModelCall(" "), /requires an owner/);
    assert.equal(budget.modelCallCount("unknown"), 0);
  });
});

describe("createBudgetManager", () => {
  it("reserveSync caps concurrent slots per owner and reports Retry-After when full", () => {
    const budget = createBudgetManager({ maxConcurrentPerUser: 2 });

    const r1 = claimed(budget.reserveSync("user-1"));
    const r2 = claimed(budget.reserveSync("user-1"));
    assert.equal(budget.activeCount("user-1"), 2);

    const r3 = budget.reserveSync("user-1");
    assert.deepEqual(r3, { ok: false, retryAfterSeconds: 10 });

    r1.release();
    const r4 = claimed(budget.reserveSync("user-1"));
    assert.equal(budget.activeCount("user-1"), 2);

    r2.release();
    r4.release();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("release is idempotent", () => {
    const budget = createBudgetManager({ maxConcurrentPerUser: 1 });
    const r1 = claimed(budget.reserveSync("user-1"));

    r1.release();
    r1.release();
    assert.equal(budget.activeCount("user-1"), 0);

    // Slot freed exactly once: a new reservation succeeds.
    const r2 = claimed(budget.reserveSync("user-1"));
    r2.release();
  });

  it("reserveAsync queues (parks) when the pool is full and promotes in FIFO order", async () => {
    const budget = createBudgetManager({
      maxConcurrentPerUser: 1,
      queueMaxPerUser: 3,
      waitMs: 10_000,
    });

    const order: number[] = [];
    const r1 = claimed(await budget.reserveAsync("user-1"));
    assert.equal(r1.queued, false);

    const p2 = budget.reserveAsync("user-1").then(async (r) => {
      const c = claimed(r);
      assert.equal(c.queued, true);
      order.push(2);
      return c.release;
    });
    const p3 = budget.reserveAsync("user-1").then(async (r) => {
      const c = claimed(r);
      assert.equal(c.queued, true);
      order.push(3);
      return c.release;
    });
    assert.equal(budget.activeCount("user-1"), 1);

    r1.release();
    const release2 = await p2;
    assert.equal(budget.activeCount("user-1"), 1);
    release2();
    const release3 = await p3;
    assert.deepEqual(order, [2, 3]);
    assert.equal(budget.activeCount("user-1"), 1);

    release3();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("reserveAsync rejects immediately when the queue is full", async () => {
    const budget = createBudgetManager({
      maxConcurrentPerUser: 2,
      queueMaxPerUser: 3,
      waitMs: 10_000,
    });

    const r1 = claimed(await budget.reserveAsync("user-1"));
    const r2 = claimed(await budget.reserveAsync("user-1"));
    assert.equal(r1.queued, false);
    assert.equal(r2.queued, false);

    // Fire the three slots but do NOT await them yet — each stays parked until
    // the pool frees up, so the queue is full to reserve the 6th against.
    const parked = [
      budget.reserveAsync("user-1"),
      budget.reserveAsync("user-1"),
      budget.reserveAsync("user-1"),
    ];

    const r6 = await budget.reserveAsync("user-1");
    assert.equal(r6.ok, false);
    assert.equal(r6.retryAfterSeconds, 10);

    // Drain in FIFO order: free slots to promote, release each promotion.
    r1.release();
    r2.release();
    const c0 = claimed(await parked[0]!);
    const c1 = claimed(await parked[1]!);
    c0.release();
    c1.release();
    const c2 = claimed(await parked[2]!);
    c2.release();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("sync and async reservations share the same per-user pool", async () => {
    const budget = createBudgetManager({ maxConcurrentPerUser: 1 });

    const sync = claimed(budget.reserveSync("user-1"));
    const parked = budget.reserveAsync("user-1");
    sync.release();
    const async = claimed(await parked);
    assert.equal(async.queued, true);
    async.release();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("isolates pools per owner", async () => {
    const budget = createBudgetManager({ maxConcurrentPerUser: 1 });

    const a = claimed(budget.reserveSync("user-a"));
    const b = claimed(budget.reserveSync("user-b"));
    // Different owner: unaffected by user-a filling its pool.
    a.release();
    b.release();
    assert.equal(budget.activeCount("user-a"), 0);
    assert.equal(budget.activeCount("user-b"), 0);
  });

  it("activeCount is 0 for unknown owners", () => {
    const budget = createBudgetManager();
    assert.equal(budget.activeCount("nobody"), 0);
  });

  it("times out a parked reservation via the injected clock, bounded by waitMs", async () => {
    const clock = createFakeClock();
    const budget = createBudgetManager({
      maxConcurrentPerUser: 1,
      waitMs: 500,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const r1 = claimed(await budget.reserveAsync("user-1"));
    const parked = budget.reserveAsync("user-1");
    assert.equal(clock.pendingCount(), 1);

    clock.fire(clock.ids()[0]!);
    const r2 = await parked;
    assert.equal(r2.ok, false);
    assert.equal(r2.retryAfterSeconds, 1);
    assert.equal(clock.pendingCount(), 0);

    // The active slot is untouched by the timeout.
    assert.equal(budget.activeCount("user-1"), 1);
    r1.release();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("clears the parked timer when promoted, so it never fires later", async () => {
    const clock = createFakeClock();
    const budget = createBudgetManager({
      maxConcurrentPerUser: 1,
      waitMs: 10_000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const r1 = claimed(await budget.reserveAsync("user-1"));
    const parked = budget.reserveAsync("user-1").then(async (r) => {
      const c = claimed(r);
      assert.equal(c.queued, true);
      return c.release;
    });
    assert.equal(clock.pendingCount(), 1);

    r1.release();
    const release2 = await parked;
    // Promotion cleared the timer instead of letting it fire later.
    assert.equal(clock.pendingCount(), 0);
    release2();
    assert.equal(budget.activeCount("user-1"), 0);
  });

  it("rejects tool calls above per-owner and global in-flight caps without queueing", async () => {
    const budget = createBudgetManager({
      maxToolCallsPerOwner: 2,
      maxGlobalToolCalls: 3,
      now: () => 1_000,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = [
      budget.withToolCallBudget("owner-a", async () => gate),
      budget.withToolCallBudget("owner-a", async () => gate),
      budget.withToolCallBudget("owner-b", async () => gate),
    ];
    assert.equal(budget.toolCallCount("owner-a"), 2);
    assert.equal(budget.toolCallCount("owner-b"), 1);
    assert.equal(budget.globalToolCallCount(), 3);
    await assert.rejects(
      budget.withToolCallBudget("owner-c", async () => undefined),
      (error: unknown) =>
        error instanceof BudgetExhaustedError &&
        error.code === "budget_exhausted" &&
        /Tool call concurrency/.test(error.message),
    );
    release();
    await Promise.all(calls);
    assert.equal(budget.toolCallCount("owner-a"), 0);
    assert.equal(budget.globalToolCallCount(), 0);
    assert.equal(await budget.withToolCallBudget("owner-c", async () => "ok"), "ok");
  });

  it("isolates per-plugin tool concurrency so one backend cannot consume the global pool", async () => {
    const budget = createBudgetManager({
      maxToolCallsPerOwner: 4,
      maxToolCallsPerPlugin: 1,
      maxGlobalToolCalls: 2,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = budget.withToolCallBudget("owner", "plugin-a", () => gate);
    const second = await budget.withToolCallBudget("owner", "plugin-b", async () => "plugin-b-ok");
    assert.equal(second, "plugin-b-ok");
    await assert.rejects(
      budget.withToolCallBudget("owner", "plugin-a", async () => "blocked"),
      (error: unknown) =>
        error instanceof BudgetExhaustedError &&
        /plugin-a/.test(error.message),
    );
    assert.equal(budget.pluginToolCallCount("plugin-a"), 1);
    assert.equal(budget.pluginToolCallCount("plugin-b"), 0);
    assert.equal(budget.globalToolCallCount(), 1);
    release();
    await first;
    assert.equal(budget.globalToolCallCount(), 0);
  });

  it("caps one tool per owner and turn while leaving another tool in the plugin unaffected", async () => {
    const budget = createBudgetManager({
      maxToolCallsPerOwnerPluginPerTurn: 2,
      maxToolCallsPerOwnerPluginPerWindow: 10,
      now: () => 1_000,
    });
    await budget.withToolCallBudget("owner", "plugin-a", async () => "a1", {
      requestId: "turn-1", tool: "alpha",
    });
    await budget.withToolCallBudget("owner", "plugin-a", async () => "a2", {
      requestId: "turn-1", tool: "alpha",
    });
    assert.equal(await budget.withToolCallBudget("owner", "plugin-a", async () => "b1", {
      requestId: "turn-1", tool: "beta",
    }), "b1");
    await assert.rejects(
      budget.withToolCallBudget("owner", "plugin-a", async () => "blocked", {
        requestId: "turn-1", tool: "alpha",
      }),
      (error: unknown) =>
        error instanceof BudgetExhaustedError &&
        /in this turn/.test(error.message) &&
        error.retryAfterSeconds > 0,
    );
    assert.equal(await budget.withToolCallBudget("owner", "plugin-a", async () => "next", {
      requestId: "turn-2", tool: "alpha",
    }), "next");
  });

  it("resets the per-owner plugin window and reports retry-after semantics", async () => {
    let now = 0;
    const budget = createBudgetManager({
      maxToolCallsPerOwnerPluginPerTurn: 10,
      maxToolCallsPerOwnerPluginPerWindow: 2,
      toolCallRateWindowMs: 1_000,
      now: () => now,
    });
    await budget.withToolCallBudget("owner", "plugin", async () => "one");
    await budget.withToolCallBudget("owner", "plugin", async () => "two");
    await assert.rejects(
      budget.withToolCallBudget("owner", "plugin", async () => "blocked"),
      (error: unknown) =>
        error instanceof BudgetExhaustedError &&
        error.retryAfterSeconds === 1 &&
        /in this window/.test(error.message),
    );
    now = 1_000;
    assert.equal(await budget.withToolCallBudget("owner", "plugin", async () => "next"), "next");
  });

  it("holds tool slots until a timed-out raw handler settles", async () => {
    const clock = createFakeClock();
    const budget = createBudgetManager({
      toolCallQuarantineMs: 100,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    let settleRaw!: () => void;
    const rawSettled = new Promise<void>((resolve) => { settleRaw = resolve; });
    const timeout = Object.assign(new Error("tool timeout"), { code: "tool_timeout" });
    await assert.rejects(
      budget.withToolCallBudget("owner", "plugin", async () => { throw timeout; }, { rawSettled }),
      /tool timeout/,
    );
    assert.equal(budget.toolCallCount("owner"), 1);
    assert.equal(budget.pluginToolCallCount("plugin"), 1);
    assert.equal(budget.globalToolCallCount(), 1);
    settleRaw();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(budget.toolCallCount("owner"), 0);
    assert.equal(budget.pluginToolCallCount("plugin"), 0);
    assert.equal(budget.globalToolCallCount(), 0);
    assert.equal(clock.pendingCount(), 0);
  });

  it("quarantines a non-cooperative timed-out handler until the force-release bound", async () => {
    const clock = createFakeClock();
    const originalInfo = logger.info;
    const records: Record<string, unknown>[] = [];
    logger.info = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
      }
    };
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      const budget = createBudgetManager({
        toolCallQuarantineMs: 100,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      const timeout = Object.assign(new Error("tool timeout"), { code: "tool_timeout" });
      await assert.rejects(
        budget.withToolCallBudget(
          "owner",
          "plugin",
          async () => { throw timeout; },
          { requestId: "quarantined-request", tool: "side-effect", rawSettled: new Promise<void>(() => undefined) },
        ),
        /tool timeout/,
      );
      await assert.rejects(
        budget.withToolCallBudget("owner", "plugin", async () => "overlap"),
        (error: unknown) => error instanceof BudgetExhaustedError && /plugin/.test(error.message),
      );
      assert.equal(budget.pluginToolCallCount("plugin"), 1);
      clock.fire(clock.ids()[0]!);
      await flushAuditTelemetry();
      assert.equal(budget.pluginToolCallCount("plugin"), 0);
      assert.equal(budget.globalToolCallCount(), 0);
      assert.equal(
        records.some((record) =>
          record.requestId === "quarantined-request" &&
          record.errorCode === "tool_quarantine_forced"),
        true,
      );
    } finally {
      await flushAuditTelemetry();
      logger.info = originalInfo;
      resetAuditTelemetryConfig();
    }
  });

  it("force-releases a never-settling budget run after timeout plus quarantine", async () => {
    const clock = createFakeClock();
    const budget = createBudgetManager({
      toolCallTimeoutMs: 10,
      toolCallQuarantineMs: 50,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    let entered!: () => void;
    const isEntered = new Promise<void>((resolve) => { entered = resolve; });
    const pending = budget.withToolCallBudget("owner", "plugin", async () => {
      entered();
      return new Promise<string>(() => undefined);
    }, { tool: "side-effect" });
    void pending.catch(() => undefined);
    await isEntered;
    clock.fire(clock.ids()[0]!);
    await assert.rejects(
      budget.withToolCallBudget("owner", "plugin", async () => "overlap"),
      (error: unknown) => error instanceof BudgetExhaustedError && /quarantined/.test(error.message),
    );
    assert.equal(budget.pluginToolCallCount("plugin"), 1);
    clock.fire(clock.ids()[0]!);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(budget.pluginToolCallCount("plugin"), 0);
    assert.equal(budget.globalToolCallCount(), 0);
  });

  it("rejects invalid per-plugin tool concurrency limits", () => {
    assert.throws(
      () => createBudgetManager({ maxToolCallsPerPlugin: 0 }),
      /maxToolCallsPerPlugin/,
    );
  });

  it("rejects invalid tool concurrency limits", () => {
    assert.throws(
      () => createBudgetManager({ maxToolCallsPerOwner: 0 }),
      /maxToolCallsPerOwner/,
    );
    assert.throws(
      () => createBudgetManager({ maxGlobalToolCalls: -1 }),
      /maxGlobalToolCalls/,
    );
  });
});
