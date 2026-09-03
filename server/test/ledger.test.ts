import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  Ledger,
  LedgerError,
  migrateLedger,
  applyMigrations,
  CURRENT_LEDGER_VERSION,
  findLoop,
} from "../src/ledger.ts";
import type { Database as DatabaseType } from "better-sqlite3";

function makeLedger(
  opts: { stuck?: number; lease?: number; now?: () => number } = {},
) {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new Ledger(db, {
    stuckTimeoutMs: opts.stuck ?? 10_000,
    leaseExpiryMs: opts.lease ?? 60_000,
    now: opts.now ?? Date.now,
  });
  return { db, ledger };
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
});
