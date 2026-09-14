import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBudgetManager } from "../../src/middleware/budget.ts";
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
});