import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  Ledger,
  LedgerError,
  migrateLedger,
  applyMigrations,
  CURRENT_LEDGER_VERSION,
  heartbeatIntervalMs,
  SPEC_MAX_LENGTH,
} from "../src/ledger.ts";
import type { Database as DatabaseType } from "better-sqlite3";
import type { TaskRow } from "../src/ledger.ts";

function makeLedger(
  opts: {
    stuck?: number;
    lease?: number;
    retention?: number;
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  } = {},
) {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new Ledger(db, {
    stuckTimeoutMs: opts.stuck ?? 10_000,
    leaseExpiryMs: opts.lease ?? 60_000,
    terminalRetentionMs: opts.retention,
    now: opts.now ?? Date.now,
    setInterval: opts.setInterval,
    clearInterval: opts.clearInterval,
  });
  return { db, ledger };
}

/**
 * A deterministic stand-in for the global timers: `setInterval` registers a
 * callback that the test drives explicitly via `fireAll()`, so timer-driven
 * heartbeats can be exercised against the fake gateway clock without waiting
 * on real time.
 */
function makeFakeScheduler() {
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  return {
    setInterval: ((fn: () => void) => {
      const handle = {} as unknown as ReturnType<typeof setInterval>;
      timers.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval,
    fireAll: () => {
      for (const fn of [...timers.values()]) fn();
    },
    count: () => timers.size,
  };
}

describe("task lifecycle: create -> append -> transitions", () => {
  test("queued -> running -> succeeded with steps", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "flight-booking",
      spec: "book a flight",
    });
    assert.equal(task.status, "queued");
    assert.equal(task.owner, "user-1");

    const running = ledger.claimTask(task.id, "user-1");
    assert.equal(running.status, "running");
    assert.equal(running.lease_owner, "user-1");

    const s1 = ledger.appendStep(task.id, "user-1", {
      stage: "search",
      action: "A",
      result: "ok",
    });
    assert.equal(s1.step.seq, 1);
    assert.equal(ledger.getTask(task.id)!.status, "running");

    const s2 = ledger.appendStep(task.id, "user-1", {
      stage: "search",
      action: "B",
      result: "ok",
    });
    assert.equal(s2.step.seq, 2);

    const done = ledger.completeTask(task.id, "user-1", "succeeded");
    assert.equal(done.status, "succeeded");

    const steps = ledger.listSteps(task.id);
    assert.equal(steps.length, 2);
    assert.deepEqual(
      steps.map((s) => s.action),
      ["A", "B"],
    );
  });

  test("queued -> running -> failed", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    const failed = ledger.completeTask(task.id, "o", "failed");
    assert.equal(failed.status, "failed");
  });

  test("appending to a succeeded task is rejected", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.completeTask(task.id, "o", "succeeded");
    assert.throws(
      () =>
        ledger.appendStep(task.id, "o", {
          stage: "s",
          action: "A",
          result: null,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_TRANSITION",
    );
  });

  test("appending while queued (not yet claimed) is rejected until running", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    assert.throws(
      () =>
        ledger.appendStep(task.id, "o", {
          stage: "s",
          action: "A",
          result: null,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_TRANSITION",
    );
  });
});

describe("heartbeat + lease + stuck ordering", () => {
  test("stuck-timeout fires before lease-expiry for a dead worker", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });

    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const running = ledger.claimTask(task.id, "o");
    const claimedAt = now;
    assert.equal(running.status, "running");
    assert.equal(running.lease_expires_at, claimedAt + 5000);

    ledger.heartbeat(task.id, "o");
    now += 2000; // worker silent for 2s

    const stuck = ledger.markStuckIfHeartbeatStale(task.id);
    assert.ok(stuck, "expected task to be marked stuck");
    assert.equal(stuck!.status, "stuck");

    // Proof of ordering: the marked-stuck task's lease had NOT yet lapsed
    // (last heartbeat renewed it to +5000; only 2s passed). Stuck fired first.
    assert.ok(
      stuck!.lease_expires_at! > now,
      "lease should still be valid when stuck-timeout fired",
    );
  });

  test("heartbeat renews the lease within the lease window", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    now += 4000;
    const hb = ledger.heartbeat(task.id, "o");
    assert.equal(hb.lease_expires_at, now + 5000);
  });

  test("heartbeat renews a task that is still alive (not marked stuck)", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    now += 500; // within stuck window; worker heartbeats
    ledger.heartbeat(task.id, "o");
    assert.equal(ledger.markStuckIfHeartbeatStale(task.id), null);
    assert.equal(ledger.getTask(task.id)!.status, "running");
  });

  test("a healthy running task is not marked stuck", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    assert.equal(ledger.markStuckIfHeartbeatStale(task.id), null);
  });

  test("a worker that appends steps but never heartbeats IS marked stuck", () => {
    // Stuck detection is heartbeat-based, NOT step-based: `appendStep` bumps
    // `updated_ts`, so without `last_heartbeat_ts` this worker would *never*
    // be marked stuck despite never heartbeating.
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");

    // The worker appends steps (which bump `updated_ts`) but never heartbeats.
    now += 200; // within stuck window
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r" });
    assert.equal(
      ledger.markStuckIfHeartbeatStale(task.id),
      null,
      "within stuck window despite step append",
    );

    now += 900; // total 1.1s since claim/heartbeat, > stuck timeout (1s)
    ledger.appendStep(task.id, "o", { stage: "s", action: "B", result: "r" });
    const stuck = ledger.markStuckIfHeartbeatStale(task.id);
    assert.ok(stuck, "step-appending worker with no heartbeat must be stuck");
    assert.equal(stuck!.status, "stuck");
  });

  test("a worker that heartbeats but appends nothing is NOT prematurely stuck", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");

    // Worker heartbeats but never appends; heartbeat keeps it alive beyond
    // the stuck timeout.
    now += 800;
    ledger.heartbeat(task.id, "o");
    now += 800;
    ledger.heartbeat(task.id, "o");
    now += 800;
    ledger.heartbeat(task.id, "o");
    assert.equal(ledger.markStuckIfHeartbeatStale(task.id), null);
    assert.equal(ledger.getTask(task.id)!.status, "running");
    assert.equal(ledger.listSteps(task.id).length, 0);
  });

  test("resume after stuck returns to running and grants lease to owner", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    now += 2000;
    ledger.markStuckIfHeartbeatStale(task.id);
    now += 1;
    const resumed = ledger.resumeTask(task.id, "o");
    assert.equal(resumed.status, "running");
    assert.equal(resumed.lease_owner, "o");
    assert.equal(resumed.lease_expires_at, now + 5000);
  });

  test("constructor rejects stuck-timeout >= lease-expiry", () => {
    assert.throws(
      () =>
        new Ledger(new Database(":memory:"), {
          stuckTimeoutMs: 10_000,
          leaseExpiryMs: 5_000,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_CONFIG",
    );
  });
});

describe("hash chain", () => {
  test("verifies an intact chain", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });
    ledger.appendStep(task.id, "o", { stage: "s", action: "B", result: "r2" });
    assert.equal(ledger.verifyChain(task.id), true);
    assert.equal(ledger.readChain(task.id).length, 2);
  });

  test("tampering with a step result breaks verification", () => {
    const { db, ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });
    assert.equal(ledger.verifyChain(task.id), true);

    // An attacker with write access would first disable the append-only
    // guard, then mutate the ledger. verifyChain must then detect the change.
    db.exec("DROP TRIGGER ledger_step_append_only_update");
    db.prepare(
      "UPDATE ledger_step SET result = 'tampered' WHERE task_id = ?",
    ).run(task.id);
    assert.equal(ledger.verifyChain(task.id), false);
  });

  test("tampering with a stored chain digest breaks verification", () => {
    const { db, ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });
    assert.equal(ledger.verifyChain(task.id), true);

    db.exec("DROP TRIGGER ledger_chain_append_only_update");
    db.prepare(
      "UPDATE ledger_chain SET digest = 'deadbeef' WHERE task_id = ?",
    ).run(task.id);
    assert.equal(ledger.verifyChain(task.id), false);
  });

  test("append-only triggers reject step/chain UPDATE and DELETE", () => {
    const { db, ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });

    assert.throws(() =>
      db.prepare("UPDATE ledger_step SET action='X' WHERE task_id = ?").run(task.id),
    );
    assert.throws(() =>
      db.prepare("DELETE FROM ledger_step WHERE task_id = ?").run(task.id),
    );
    assert.throws(() =>
      db.prepare("UPDATE ledger_chain SET digest='x' WHERE task_id = ?").run(task.id),
    );
    assert.throws(() =>
      db.prepare("DELETE FROM ledger_chain WHERE task_id = ?").run(task.id),
    );
  });
});

describe("owner binding", () => {
  test("resume by a non-owner is rejected; owner succeeds", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "user-1", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "user-1");
    now += 2000; // worker goes silent beyond stuck-timeout
    assert.equal(ledger.markStuckIfHeartbeatStale(task.id)!.status, "stuck");

    assert.throws(
      () => ledger.resumeTask(task.id, "intruder"),
      (e: unknown) => e instanceof LedgerError && e.code === "FORBIDDEN",
    );
    const resumed = ledger.resumeTask(task.id, "user-1");
    assert.equal(resumed.status, "running");
  });

  test("append/heartbeat by a non-owner are rejected", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "user-1", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "user-1");
    assert.throws(
      () =>
        ledger.appendStep(task.id, "intruder", {
          stage: "s",
          action: "A",
          result: null,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "FORBIDDEN",
    );
    assert.throws(
      () => ledger.heartbeat(task.id, "intruder"),
      (e: unknown) => e instanceof LedgerError && e.code === "FORBIDDEN",
    );
  });
});

describe("owner-scoped reads (IDOR)", () => {
  test("listTasks(owner) only returns that owner's tasks", () => {
    const { ledger } = makeLedger();
    ledger.createTask({ owner: "user-1", intentKey: "a", spec: "s" });
    ledger.createTask({ owner: "user-1", intentKey: "b", spec: "s" });
    ledger.createTask({ owner: "user-2", intentKey: "c", spec: "s" });

    const u1 = ledger.listTasks("user-1");
    assert.equal(u1.length, 2);
    assert.ok(u1.every((t) => t.owner === "user-1"));

    const u2 = ledger.listTasks("user-2");
    assert.equal(u2.length, 1);
    assert.ok(u2.every((t) => t.owner === "user-2"));

    // No owner filter returns everything (namespace for the caller).
    assert.equal(ledger.listTasks().length, 3);
  });

  test("a second owner cannot read another's task by id (404 semantics)", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "user-1", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "user-1");
    ledger.appendStep(task.id, "user-1", { stage: "s", action: "A", result: "r" });

    // The owner reads their task and its steps/chain fine.
    assert.equal(ledger.getTask(task.id, "user-1")!.owner, "user-1");
    assert.equal(ledger.listSteps(task.id, "user-1").length, 1);
    assert.equal(ledger.readChain(task.id, "user-1").length, 1);

    // An intruder sees a miss on the task, and empty steps/chain.
    assert.equal(ledger.getTask(task.id, "intruder"), null);
    assert.deepEqual(ledger.listSteps(task.id, "intruder"), []);
    assert.deepEqual(ledger.readChain(task.id, "intruder"), []);
  });
});

describe("fence token (superseded-worker fencing)", () => {
  test("claim mints a fence token; heartbeat with wrong fence is rejected", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    assert.ok(claimed.fence_token.length > 0, "claim must mint a fence token");
    assert.equal(ledger.getTask(task.id)!.fence_token, claimed.fence_token);

    assert.throws(
      () => ledger.heartbeat(task.id, "o", "wrong-fence"),
      (e: unknown) => e instanceof LedgerError && e.code === "FENCE_CONFLICT",
    );

    const hb = ledger.heartbeat(task.id, "o", claimed.fence_token);
    assert.equal(hb.status, "running");
  });

  test("heartbeat without a fence token still works (backwards compatible)", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    const hb = ledger.heartbeat(task.id, "o");
    assert.equal(hb.status, "running");
  });

  test("resume rotates the fence: old fence rejected, new fence accepted", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    now += 2000;
    ledger.markStuckIfHeartbeatStale(task.id);
    now += 1;
    const resumed = ledger.resumeTask(task.id, "o");
    assert.notEqual(resumed.fence_token, claimed.fence_token);
    assert.ok(resumed.fence_token.length > 0);

    assert.throws(
      () => ledger.heartbeat(task.id, "o", claimed.fence_token),
      (e: unknown) => e instanceof LedgerError && e.code === "FENCE_CONFLICT",
    );
    const hb = ledger.heartbeat(task.id, "o", resumed.fence_token);
    assert.equal(hb.status, "running");
  });

  test("appendStep with a stale fence is rejected with FENCE_CONFLICT", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");

    assert.throws(
      () =>
        ledger.appendStep(
          task.id,
          "o",
          { stage: "s", action: "A", result: null },
          "wrong-fence",
        ),
      (e: unknown) => e instanceof LedgerError && e.code === "FENCE_CONFLICT",
    );
    assert.equal(ledger.listSteps(task.id).length, 0, "no step appended");

    const ok = ledger.appendStep(
      task.id,
      "o",
      { stage: "s", action: "A", result: null },
      claimed.fence_token,
    );
    assert.equal(ok.step.seq, 1);
  });

  test("appendStep without a fence token still works (backwards compatible)", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    const out = ledger.appendStep(task.id, "o", {
      stage: "s",
      action: "A",
      result: null,
    });
    assert.equal(out.step.seq, 1);
  });
});

describe("timer-driven heartbeat", () => {
  test("default heartbeat interval is at most stuck-timeout/3", () => {
    assert.equal(heartbeatIntervalMs(10_000), 3333);
    assert.ok(heartbeatIntervalMs(10_000) <= 10_000 / 3);
  });

  test("startHeartbeat rejects an interval larger than stuck-timeout/3", () => {
    const { ledger } = makeLedger({ stuck: 1000, lease: 5000 });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    assert.throws(
      () =>
        ledger.startHeartbeat(task.id, "o", claimed.fence_token, {
          intervalMs: 400, // > floor(1000/3) = 333
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_CONFIG",
    );
  });

  test("task stays not-stuck across many intervals while heartbeating", () => {
    let now = 1_000_000;
    const scheduler = makeFakeScheduler();
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    const hb = ledger.startHeartbeat(task.id, "o", claimed.fence_token, {
      intervalMs: 300,
    });

    // 12 intervals of 300ms = 3.6s of "streaming", each < stuck-timeout.
    for (let i = 0; i < 12; i++) {
      now += 300;
      scheduler.fireAll();
      assert.equal(
        ledger.markStuckIfHeartbeatStale(task.id),
        null,
        `tick ${i} must not be marked stuck`,
      );
    }
    assert.equal(ledger.getTask(task.id)!.status, "running");

    hb.stop();
    assert.equal(scheduler.count(), 0, "stop() clears the interval");
  });

  test("a task whose timer heartbeat has stopped is eventually stuck", () => {
    let now = 1_000_000;
    const scheduler = makeFakeScheduler();
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    const hb = ledger.startHeartbeat(task.id, "o", claimed.fence_token, {
      intervalMs: 300,
    });

    now += 300;
    scheduler.fireAll();
    assert.equal(ledger.markStuckIfHeartbeatStale(task.id), null);

    hb.stop(); // worker gone mid-stream
    now += 2000; // silent past stuck-timeout
    const stuck = ledger.markStuckIfHeartbeatStale(task.id);
    assert.ok(stuck, "silent task must be marked stuck");
    assert.equal(stuck!.status, "stuck");
  });

  test("startHeartbeat forwards tick errors to onError without throwing", () => {
    let now = 1_000_000;
    const scheduler = makeFakeScheduler();
    const errors: unknown[] = [];
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    const claimed = ledger.claimTask(task.id, "o");
    ledger.startHeartbeat(task.id, "o", claimed.fence_token, {
      intervalMs: 300,
      onError: (err) => errors.push(err),
    });

    // Rotate the fence via resume, making the timer's stored token stale.
    now += 2000;
    ledger.markStuckIfHeartbeatStale(task.id);
    now += 1;
    ledger.resumeTask(task.id, "o");

    scheduler.fireAll();
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof LedgerError);
    assert.equal((errors[0] as LedgerError).code, "FENCE_CONFLICT");
    assert.equal(ledger.getTask(task.id)!.status, "running");
  });
});

describe("startup orphan reconciliation", () => {
  test("running task with stale heartbeat is marked stuck", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    now += 2000; // heartbeat stale (> 1s), lease still valid (5s)
    const res = ledger.reconcileOrphans();
    assert.deepEqual(res.marked, [task.id]);
    assert.equal(ledger.getTask(task.id)!.status, "stuck");
  });

  test("running task with lapsed lease is marked stuck (lease branch)", () => {
    let now = 1_000_000;
    const { db, ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    // Lapse only the lease; keep the heartbeat fresh (can't happen via the
    // API — heartbeat renews both — but the reconciliation must cover it).
    db.prepare("UPDATE ledger_task SET lease_expires_at = ? WHERE id = ?").run(
      now - 1,
      task.id,
    );
    const res = ledger.reconcileOrphans();
    assert.deepEqual(res.marked, [task.id]);
    assert.equal(ledger.getTask(task.id)!.status, "stuck");
  });

  test("a healthy running task is untouched", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    assert.deepEqual(ledger.reconcileOrphans().marked, []);
    assert.equal(ledger.getTask(task.id)!.status, "running");
  });

  test("queued and terminal tasks are untouched", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const queued = ledger.createTask({ owner: "o", intentKey: "q", spec: "s" });
    const done = ledger.createTask({ owner: "o", intentKey: "d", spec: "s" });
    ledger.claimTask(done.id, "o");
    ledger.completeTask(done.id, "o", "succeeded");
    now += 2000; // everything stale by now, but none of these are running

    const res = ledger.reconcileOrphans();
    assert.deepEqual(res.marked, []);
    assert.equal(ledger.getTask(queued.id)!.status, "queued");
    assert.equal(ledger.getTask(done.id)!.status, "succeeded");
  });

  test("reconciliation is idempotent", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    now += 2000;
    assert.deepEqual(ledger.reconcileOrphans().marked, [task.id]);
    assert.deepEqual(ledger.reconcileOrphans().marked, []);
    assert.equal(ledger.getTask(task.id)!.status, "stuck");
  });
});

describe("spec cap (D4)", () => {
  test("a spec longer than 80 chars is stored truncated to 80 at the write boundary", () => {
    const { ledger } = makeLedger();
    const long = "x".repeat(500);
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: long });
    assert.equal(task.spec.length, SPEC_MAX_LENGTH);
    assert.equal(task.spec, "x".repeat(SPEC_MAX_LENGTH));
  });

  test("a spec at or under 80 chars is stored verbatim", () => {
    const { ledger } = makeLedger();
    const exact = "a".repeat(SPEC_MAX_LENGTH);
    assert.equal(
      ledger.createTask({ owner: "o", intentKey: "k", spec: exact }).spec,
      exact,
    );
    assert.equal(
      ledger.createTask({ owner: "o", intentKey: "k2", spec: "short" }).spec,
      "short",
    );
  });

  test("getOrCreateTask's spec flows through the same 80-char cap", async () => {
    const { ledger } = makeLedger();
    const { getOrCreateTask } = await import("../src/credentials/idempotency.ts");
    const task = await getOrCreateTask(ledger, {
      owner: "o",
      intentKey: "k",
      spec: "y".repeat(300),
    });
    assert.equal(task.spec.length, SPEC_MAX_LENGTH);
  });
});

describe("terminal-task retention purge (D6)", () => {
  const complete = (
    ledger: Ledger,
    owner: string,
    intentKey: string,
    to: "succeeded" | "failed" | "cancelled" | "awaiting_review",
  ): TaskRow => {
    const task = ledger.createTask({ owner, intentKey, spec: "s" });
    ledger.claimTask(task.id, owner);
    return ledger.completeTask(task.id, owner, to);
  };

  test("a terminal task older than retention is purged along with its steps and chain", () => {
    let now = 1_000_000;
    const { db, ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 86_400_000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });
    ledger.appendStep(task.id, "o", { stage: "s", action: "B", result: "r2" });
    ledger.completeTask(task.id, "o", "succeeded");
    now += 86_400_000 + 1;

    assert.equal(ledger.purgeTerminalTasks(), 1);
    assert.equal(ledger.getTask(task.id), null);
    const stepCount = (
      db.prepare("SELECT COUNT(*) AS c FROM ledger_step WHERE task_id = ?").get(task.id) as { c: number }
    ).c;
    const chainCount = (
      db.prepare("SELECT COUNT(*) AS c FROM ledger_chain WHERE task_id = ?").get(task.id) as { c: number }
    ).c;
    assert.equal(stepCount, 0, "steps of the purged task must be deleted");
    assert.equal(chainCount, 0, "chain rows of the purged task must be deleted");
  });

  test("a terminal task younger than retention is kept", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 86_400_000,
      now: () => now,
    });
    const task = complete(ledger, "o", "k", "succeeded");
    now += 86_400_000 - 1; // still inside the window

    assert.equal(ledger.purgeTerminalTasks(), 0);
    assert.equal(ledger.getTask(task.id)!.status, "succeeded");
  });

  test("running/queued/stuck tasks are never purged however old", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const queued = ledger.createTask({ owner: "o", intentKey: "q", spec: "s" });
    const running = ledger.createTask({ owner: "o", intentKey: "r", spec: "s" });
    ledger.claimTask(running.id, "o");
    const stuck = ledger.createTask({ owner: "o", intentKey: "st", spec: "s" });
    ledger.claimTask(stuck.id, "o");
    now += 2000; // heartbeat stale past stuck-timeout
    ledger.markStuckIfHeartbeatStale(stuck.id);
    now += 100_000; // everything far past the retention window

    assert.equal(ledger.purgeTerminalTasks(), 0);
    assert.equal(ledger.getTask(queued.id)!.status, "queued");
    assert.equal(ledger.getTask(running.id)!.status, "running");
    assert.equal(ledger.getTask(stuck.id)!.status, "stuck");
  });

  test("all terminal statuses are purged after the window", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const succeeded = complete(ledger, "o", "s", "succeeded");
    const failed = complete(ledger, "o", "f", "failed");
    const cancelled = complete(ledger, "o", "c", "cancelled");
    const awaiting = complete(ledger, "o", "a", "awaiting_review");
    now += 2000;

    assert.equal(ledger.purgeTerminalTasks(), 4);
    for (const t of [succeeded, failed, cancelled, awaiting]) {
      assert.equal(ledger.getTask(t.id), null, `${t.status} task must be purged`);
    }
  });

  test("cross-owner: purging owner A's expired tasks leaves owner B's intact", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const a = complete(ledger, "A", "a", "succeeded");
    now += 2000; // A's task is now expired
    const b = complete(ledger, "B", "b", "succeeded"); // B's task is fresh

    assert.equal(ledger.purgeTerminalTasks(), 1);
    assert.equal(ledger.getTask(a.id), null);
    assert.equal(ledger.getTask(b.id)!.status, "succeeded");
  });

  test("append-only delete guard is restored after a purge", () => {
    let now = 1_000_000;
    const { db, ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r" });
    ledger.completeTask(task.id, "o", "succeeded");
    now += 2000;
    assert.equal(ledger.purgeTerminalTasks(), 1);

    const t2 = ledger.createTask({ owner: "o", intentKey: "k2", spec: "s" });
    ledger.claimTask(t2.id, "o");
    ledger.appendStep(t2.id, "o", { stage: "s", action: "A", result: "r" });
    assert.throws(() =>
      db.prepare("DELETE FROM ledger_step WHERE task_id = ?").run(t2.id),
      /append-only/,
    );
    assert.throws(() =>
      db.prepare("DELETE FROM ledger_chain WHERE task_id = ?").run(t2.id),
      /append-only/,
    );
  });

  test("purgeTerminalTasks() uses the injected now by default", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const task = complete(ledger, "o", "k", "failed");
    now += 2000;
    assert.equal(ledger.purgeTerminalTasks(), 1);
    assert.equal(ledger.getTask(task.id), null);
  });
});

describe("retention sweep timer (D6)", () => {
  test("startRetentionSweep purges expired terminal tasks per tick and stops cleanly", () => {
    let now = 1_000_000;
    const scheduler = makeFakeScheduler();
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const errors: unknown[] = [];
    const sweep = ledger.startRetentionSweep(1000, {
      onError: (err) => errors.push(err),
    });
    assert.equal(scheduler.count(), 1, "sweep registers one interval");

    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.completeTask(task.id, "o", "succeeded");
    now += 2000; // terminal + past retention

    scheduler.fireAll();
    assert.equal(ledger.getTask(task.id), null, "sweep purges expired tasks");
    assert.deepEqual(errors, []);

    sweep.stop();
    assert.equal(scheduler.count(), 0, "stop() clears the interval");
  });

  test("a tick that throws is forwarded to onError, never escaping the timer", () => {
    let now = 1_000_000;
    const scheduler = makeFakeScheduler();
    const { db, ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const errors: unknown[] = [];
    ledger.startRetentionSweep(1000, { onError: (err) => errors.push(err) });

    // Poison the DB so the purge select throws mid-tick.
    db.close();
    scheduler.fireAll();
    assert.equal(errors.length, 1);
  });

  test("startRetentionSweep rejects interval <= 0", () => {
    const { ledger } = makeLedger();
    assert.throws(
      () => ledger.startRetentionSweep(0),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_CONFIG",
    );
  });

  test("startRetentionSweep is guarded against a double start", () => {
    const scheduler = makeFakeScheduler();
    const { ledger } = makeLedger({
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const sweep = ledger.startRetentionSweep(1000);
    assert.throws(
      () => ledger.startRetentionSweep(1000),
      (e: unknown) => e instanceof LedgerError && e.code === "INVALID_CONFIG",
    );
    assert.equal(scheduler.count(), 1, "a double start registers only one timer");
    sweep.stop();
    assert.equal(scheduler.count(), 0);
  });

  test("stop() is idempotent and a stale handle cannot clear a new sweep", () => {
    const scheduler = makeFakeScheduler();
    const { ledger } = makeLedger({
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
    });
    const first = ledger.startRetentionSweep(1000);
    first.stop();
    first.stop(); // second stop is a no-op
    assert.equal(scheduler.count(), 0);

    const second = ledger.startRetentionSweep(1000);
    assert.equal(scheduler.count(), 1);
    first.stop(); // stale handle must not clear the new sweep
    assert.equal(scheduler.count(), 1);
    second.stop();
    assert.equal(scheduler.count(), 0);
  });
});

describe("snapshot payload (v5)", () => {
  test("createTask stores the payload and every read path returns it", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "k",
      spec: "s",
      payload: JSON.stringify([{ role: "user", content: "hello" }]),
    });
    assert.equal(task.payload, JSON.stringify([{ role: "user", content: "hello" }]));
    assert.equal(ledger.getTask(task.id)?.payload, task.payload);
    assert.equal(ledger.getTaskByIntentKey("user-1", "k")?.payload, task.payload);
    assert.equal(ledger.listTasks("user-1")[0]?.payload, task.payload);
  });

  test("a task created without a payload reads back null (routes never store one)", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    assert.equal(task.payload, null);
    assert.equal(ledger.getTask(task.id)?.payload, null);
  });

  test("updateTaskPayload backfills an admitted-without-payload task, owner-scoped", () => {
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "user-1", intentKey: "k", spec: "s" });
    assert.equal(task.payload, null);
    const updated = ledger.updateTaskPayload(
      task.id,
      "user-1",
      JSON.stringify([{ role: "user", content: "snapshot" }]),
    );
    assert.equal(updated.payload, JSON.stringify([{ role: "user", content: "snapshot" }]));
    assert.equal(ledger.getTask(task.id)?.payload, updated.payload);
    assert.throws(
      () => ledger.updateTaskPayload(task.id, "intruder", "{}"),
      (e: unknown) => e instanceof LedgerError && e.code === "FORBIDDEN",
    );
  });

  test("the payload is purged WITH the task by the retention sweep (no separate purge)", () => {
    let now = 1_000_000;
    const { ledger } = makeLedger({
      stuck: 1000,
      lease: 5000,
      retention: 1000,
      now: () => now,
    });
    const task = ledger.createTask({
      owner: "o",
      intentKey: "k",
      spec: "s",
      payload: JSON.stringify([{ role: "user", content: "transient" }]),
    });
    ledger.claimTask(task.id, "o");
    ledger.completeTask(task.id, "o", "succeeded");
    now += 2000;
    assert.equal(ledger.purgeTerminalTasks(), 1);
    assert.equal(ledger.getTask(task.id), null, "the task (and its payload) is purged");
  });

  test("v5 migration adds the payload column with a null default over existing data", () => {
    // Rebuild the full v1 ledger_task schema (the real chain's v2-v5 ALTERs
    // and the v4 dedupe reference columns the real v1 defines), seed a row,
    // then run the REAL migration chain through v5.
    const db = new Database(":memory:") as DatabaseType;
    const v1 = (d: DatabaseType) => {
      d.exec(`
        CREATE TABLE ledger_task (
          id               TEXT PRIMARY KEY,
          owner            TEXT NOT NULL,
          intent_key       TEXT NOT NULL,
          spec             TEXT NOT NULL,
          worker           TEXT,
          status           TEXT NOT NULL CHECK (
            status IN ('queued','running','succeeded','failed','cancelled','stuck','awaiting_review')
          ),
          created_ts       INTEGER NOT NULL,
          updated_ts       INTEGER NOT NULL,
          lease_expires_at INTEGER,
          lease_owner      TEXT
        );
        CREATE TABLE ledger_step (
          id      TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES ledger_task(id),
          seq     INTEGER NOT NULL,
          stage   TEXT NOT NULL,
          action  TEXT NOT NULL,
          result  TEXT,
          ts      INTEGER NOT NULL,
          UNIQUE (task_id, seq)
        );
        CREATE TABLE ledger_chain (
          seq         INTEGER NOT NULL,
          task_id     TEXT NOT NULL,
          step_id     TEXT NOT NULL,
          digest      TEXT NOT NULL,
          prev_digest TEXT,
          ts          INTEGER NOT NULL,
          PRIMARY KEY (task_id, seq),
          UNIQUE (task_id, step_id)
        );
        CREATE TRIGGER ledger_step_append_only_update
        BEFORE UPDATE ON ledger_step
        BEGIN SELECT RAISE(ABORT, 'ledger_step is append-only'); END;
        CREATE TRIGGER ledger_step_append_only_delete
        BEFORE DELETE ON ledger_step
        BEGIN SELECT RAISE(ABORT, 'ledger_step is append-only'); END;
        CREATE TRIGGER ledger_chain_append_only_update
        BEFORE UPDATE ON ledger_chain
        BEGIN SELECT RAISE(ABORT, 'ledger_chain is append-only'); END;
        CREATE TRIGGER ledger_chain_append_only_delete
        BEFORE DELETE ON ledger_chain
        BEGIN SELECT RAISE(ABORT, 'ledger_chain is append-only'); END;
      `);
    };
    applyMigrations(db, [v1], 1);
    db.prepare(
      `INSERT INTO ledger_task (id, owner, intent_key, spec, status, created_ts, updated_ts)
       VALUES ('t1', 'o', 'k', 's', 'queued', 1, 1)`,
    ).run();
    migrateLedger(db); // upgrades v1 -> current (incl. the v5 payload column)
    assert.equal(db.pragma("user_version", { simple: true }), CURRENT_LEDGER_VERSION);
    const row = db
      .prepare("SELECT id, payload FROM ledger_task WHERE id = 't1'")
      .get() as { id: string; payload: string | null };
    assert.equal(row.payload, null, "existing rows get a NULL payload");
    const fresh = new Database(":memory:");
    migrateLedger(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(ledger_task)")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(cols.includes("payload"), "fresh DB must have the payload column");
  });
});

describe("migration", () => {
  test("fresh DB migrates to the current version", () => {
    const db = new Database(":memory:");
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    migrateLedger(db);
    assert.equal(db.pragma("user_version", { simple: true }), CURRENT_LEDGER_VERSION);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ledger_%'",
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    assert.deepEqual(tables, ["ledger_chain", "ledger_step", "ledger_task"]);
  });

  test("migration is idempotent and preserves data on re-run", () => {
    const db = new Database(":memory:");
    migrateLedger(db);
    const ledger = new Ledger(db);
    const task = ledger.createTask({ owner: "o", intentKey: "k", spec: "s" });
    ledger.claimTask(task.id, "o");
    ledger.appendStep(task.id, "o", { stage: "s", action: "A", result: "r1" });

    migrateLedger(db); // no-op
    assert.equal(db.pragma("user_version", { simple: true }), CURRENT_LEDGER_VERSION);
    assert.equal(ledger.getTask(task.id)!.status, "running");
    assert.equal(ledger.listSteps(task.id).length, 1);
  });

  test("upgrade from an older schema version preserves data", () => {
    // Simulate an older version (v1) DB with data, then upgrade it to a
    // hypothetical v2 that adds a column. Demonstrates the upgrade path keeps
    // existing rows intact.
    const db = new Database(":memory:") as DatabaseType;
    const v1 = (d: DatabaseType) => {
      d.exec(
        `CREATE TABLE ledger_task (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL);`,
      );
    };
    const v2 = (d: DatabaseType) => {
      d.exec(`ALTER TABLE ledger_task ADD COLUMN spec TEXT;`);
    };
    applyMigrations(db, [v1], 1);
    db.prepare(
      "INSERT INTO ledger_task (id, owner, status) VALUES ('t1', 'o', 'queued')",
    ).run();
    assert.equal(db.pragma("user_version", { simple: true }), 1);

    applyMigrations(db, [v1, v2], 2);
    assert.equal(db.pragma("user_version", { simple: true }), 2);
    const row = db
      .prepare("SELECT id, owner, status, spec FROM ledger_task WHERE id = 't1'")
      .get() as { id: string; owner: string; status: string; spec: string | null };
    assert.deepEqual(row, { id: "t1", owner: "o", status: "queued", spec: null });
  });

  test("v3 migration adds fence_token over v1->v2 data with default ''", () => {
    // Simulate an older (v2) DB carrying data, then upgrade it to v3 which
    // adds the fence_token column. Existing rows must survive with the
    // empty-token default (no fence held).
    const db = new Database(":memory:") as DatabaseType;
    const v1 = (d: DatabaseType) => {
      d.exec(
        `CREATE TABLE ledger_task (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, spec TEXT);`,
      );
    };
    const v2 = (d: DatabaseType) => {
      d.exec(
        `ALTER TABLE ledger_task ADD COLUMN last_heartbeat_ts INTEGER NOT NULL DEFAULT 0;`,
      );
    };
    const v3 = (d: DatabaseType) => {
      d.exec(
        `ALTER TABLE ledger_task ADD COLUMN fence_token TEXT NOT NULL DEFAULT '';`,
      );
    };
    applyMigrations(db, [v1, v2, v3], 3);
    db.prepare(
      "INSERT INTO ledger_task (id, owner, status, spec, last_heartbeat_ts) VALUES ('t1', 'o', 'queued', 's', 0)",
    ).run();
    assert.equal(db.pragma("user_version", { simple: true }), 3);
    const row = db
      .prepare("SELECT id, fence_token FROM ledger_task WHERE id = 't1'")
      .get() as { id: string; fence_token: string };
    assert.deepEqual(row, { id: "t1", fence_token: "" });

    // The current migration chain produces the same column on a fresh DB.
    const fresh = new Database(":memory:");
    migrateLedger(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(ledger_task)")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(cols.includes("fence_token"), "fresh DB must have fence_token");
    assert.ok(cols.includes("last_heartbeat_ts"));
  });

  test("M4: v4 migration dedupes pre-existing duplicate (owner, intent_key) rows, keeping the newest", () => {
    // Rebuild the exact pre-v4 (v1..v3) schema, seed two duplicate-key rows,
    // then run the REAL migration chain: v4 must delete the older duplicate
    // BEFORE creating the unique index instead of aborting the import.
    const db = new Database(":memory:") as DatabaseType;
    const v1 = (d: DatabaseType) => {
      d.exec(`
        CREATE TABLE ledger_task (
          id               TEXT PRIMARY KEY,
          owner            TEXT NOT NULL,
          intent_key       TEXT NOT NULL,
          spec             TEXT NOT NULL,
          worker           TEXT,
          status           TEXT NOT NULL CHECK (
            status IN ('queued','running','succeeded','failed','cancelled','stuck','awaiting_review')
          ),
          created_ts       INTEGER NOT NULL,
          updated_ts       INTEGER NOT NULL,
          lease_expires_at INTEGER,
          lease_owner      TEXT
        );

        CREATE TABLE ledger_step (
          id      TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES ledger_task(id),
          seq     INTEGER NOT NULL,
          stage   TEXT NOT NULL,
          action  TEXT NOT NULL,
          result  TEXT,
          ts      INTEGER NOT NULL,
          UNIQUE (task_id, seq)
        );

        CREATE TABLE ledger_chain (
          seq         INTEGER NOT NULL,
          task_id     TEXT NOT NULL,
          step_id     TEXT NOT NULL,
          digest      TEXT NOT NULL,
          prev_digest TEXT,
          ts          INTEGER NOT NULL,
          PRIMARY KEY (task_id, seq),
          UNIQUE (task_id, step_id)
        );
      `);
    };
    const v2 = (d: DatabaseType) => {
      d.exec(
        `ALTER TABLE ledger_task ADD COLUMN last_heartbeat_ts INTEGER NOT NULL DEFAULT 0;`,
      );
    };
    const v3 = (d: DatabaseType) => {
      d.exec(
        `ALTER TABLE ledger_task ADD COLUMN fence_token TEXT NOT NULL DEFAULT '';`,
      );
    };
    applyMigrations(db, [v1, v2, v3], 3);
    const insertTask = db.prepare(
      `INSERT INTO ledger_task
         (id, owner, intent_key, spec, status, created_ts, updated_ts, last_heartbeat_ts)
       VALUES (@id, @owner, @intentKey, @spec, 'queued', @ts, @ts, 0)`,
    );
    insertTask.run({ id: "dup-old", owner: "o", intentKey: "k", spec: "old", ts: 1 });
    insertTask.run({ id: "dup-new", owner: "o", intentKey: "k", spec: "new", ts: 2 });

    migrateLedger(db); // applies v4 over the pre-v4 data
    assert.equal(db.pragma("user_version", { simple: true }), CURRENT_LEDGER_VERSION);
    const rows = db
      .prepare("SELECT id FROM ledger_task ORDER BY id")
      .all() as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((r) => r.id),
      ["dup-new"],
      "only the newest duplicate must survive",
    );

    // The unique index now exists and rejects a fresh duplicate insert.
    assert.throws(
      () =>
        insertTask.run({ id: "dup-again", owner: "o", intentKey: "k", spec: "x", ts: 3 }),
      /UNIQUE/i,
      "the unique (owner, intent_key) index must be in force after migration",
    );
  });
});
