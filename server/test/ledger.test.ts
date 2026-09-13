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
  findLoop,
} from "../src/ledger.ts";
import type { Database as DatabaseType } from "better-sqlite3";

function makeLedger(
  opts: {
    stuck?: number;
    lease?: number;
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

describe("sequence-aware loop detection", () => {
  test("A,B,A,B fires", () => {
    assert.deepEqual(findLoop(["A", "B", "A", "B"]), ["A", "B"]);
  });
  test("A,B,C,A,B,C fires", () => {
    assert.deepEqual(findLoop(["A", "B", "C", "A", "B", "C"]), ["A", "B", "C"]);
  });
  test("A,A adjacent retry does NOT fire", () => {
    assert.equal(findLoop(["A", "A"]), null);
  });
  test("A,B,B adjacent retry does NOT fire", () => {
    assert.equal(findLoop(["A", "B", "B"]), null);
  });
  test("A,B plays once does NOT fire", () => {
    assert.equal(findLoop(["A", "B"]), null);
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
});
