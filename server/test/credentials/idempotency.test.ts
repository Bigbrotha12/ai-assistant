import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import {
  canRetryTool,
  getOrCreateTask,
  hasToolResult,
  recordToolResult,
} from "../../src/credentials/idempotency.ts";
import type { Ledger as LedgerType } from "../../src/ledger.ts";

function makeLedger(): { db: Database.Database; ledger: Ledger } {
  const db = new Database(":memory:");
  migrateLedger(db);
  return { db, ledger: new Ledger(db) };
}

function runningTask(ledger: LedgerType) {
  const task = ledger.createTask({
    owner: "user-1",
    intentKey: "msg-1",
    spec: "{}",
  });
  const claimed = ledger.claimTask(task.id, "user-1");
  return { task, claimed };
}

describe("getOrCreateTask (owner-scoped idempotency)", () => {
  test("first call creates; a repeat (owner, intentKey) returns the SAME task, no duplicate row", async () => {
    const { ledger, db } = makeLedger();
    const a = await getOrCreateTask(ledger, {
      owner: "u1",
      intentKey: "msg-1",
      spec: "{}",
    });
    const b = await getOrCreateTask(ledger, {
      owner: "u1",
      intentKey: "msg-1",
      spec: "{}",
    });
    assert.equal(a.id, b.id, "repeat must return the same task id");

    const { c } = db
      .prepare(
        "SELECT COUNT(*) AS c FROM ledger_task WHERE owner = ? AND intent_key = ?",
      )
      .get("u1", "msg-1") as { c: number };
    assert.equal(c, 1, "exactly one task row for the (owner, intentKey) pair");
  });

  test("the same intentKey under different owners creates two separate tasks", async () => {
    const { ledger } = makeLedger();
    const a = await getOrCreateTask(ledger, {
      owner: "u1",
      intentKey: "shared-key",
      spec: "{}",
    });
    const b = await getOrCreateTask(ledger, {
      owner: "u2",
      intentKey: "shared-key",
      spec: "{}",
    });
    assert.notEqual(a.id, b.id);
    assert.equal(a.owner, "u1");
    assert.equal(b.owner, "u2");
  });

  test("the raw INSERT (createTask) throws SQLITE_CONSTRAINT on a repeat — the get-or-create must wrap it", () => {
    const { ledger } = makeLedger();
    ledger.createTask({ owner: "u1", intentKey: "dup", spec: "{}" });
    assert.throws(
      () => ledger.createTask({ owner: "u1", intentKey: "dup", spec: "{}" }),
      (e: unknown) =>
        (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE",
      "raw createTask must 500-style throw on a repeat; callers must use getOrCreateTask",
    );
  });

  test("UNIQUE-constraint race: a concurrently-inserted row is re-read, never a 500", async () => {
    const { ledger, db } = makeLedger();
    db.prepare(
      `INSERT INTO ledger_task
         (id, owner, intent_key, spec, worker, status, created_ts, updated_ts, last_heartbeat_ts)
       VALUES ('race-row', 'u1', 'msg-race', '{}', NULL, 'queued', 1, 1, 1)`,
    ).run();

    // Simulate the racing writer landing between the pre-check and the INSERT:
    // the pre-check is made to miss, so createTask actually hits the unique
    // index; getOrCreateTask must catch it and re-read the row instead of 500ing.
    const real = ledger.getTaskByIntentKey.bind(ledger);
    let first = true;
    ledger.getTaskByIntentKey = (owner: string, intentKey: string) => {
      if (first) {
        first = false;
        return null; // the pre-check misses the concurrent row
      }
      return real(owner, intentKey);
    };

    const task = await getOrCreateTask(ledger, {
      owner: "u1",
      intentKey: "msg-race",
      spec: "{}",
    });
    assert.equal(task.id, "race-row", "the existing row wins, no 500");
    ledger.getTaskByIntentKey = real;
  });
});

describe("tool-call replay dedupe", () => {
  test("recordToolResult then hasToolResult -> true; a different toolCallId -> false", () => {
    const { ledger } = makeLedger();
    const { task, claimed } = runningTask(ledger);
    const step = recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_1",
      toolName: "list_tasks",
      result: '{"ok":true}',
    });
    assert.equal(step.stage, "tool");
    assert.equal(
      hasToolResult(ledger, {
        taskId: task.id,
        owner: "user-1",
        toolCallId: "call_1",
      }),
      true,
    );
    assert.equal(
      hasToolResult(ledger, {
        taskId: task.id,
        owner: "user-1",
        toolCallId: "call_2",
      }),
      false,
      "an unrecorded tool-call-id must report false",
    );
  });

  test("owner mismatch -> false (IDOR: a cross-owner read is a miss)", () => {
    const { ledger } = makeLedger();
    const { task, claimed } = runningTask(ledger);
    recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_1",
      toolName: "list_tasks",
      result: "r",
    });
    assert.equal(
      hasToolResult(ledger, {
        taskId: task.id,
        owner: "intruder",
        toolCallId: "call_1",
      }),
      false,
    );
  });

  test("recording the same toolCallId twice is deduped (same step, no duplicate row)", () => {
    const { ledger } = makeLedger();
    const { task, claimed } = runningTask(ledger);
    const first = recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_1",
      toolName: "list_tasks",
      result: "r1",
    });
    const second = recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_1",
      toolName: "list_tasks",
      result: "r1",
    });
    assert.equal(second.id, first.id, "a replay returns the original step");
    assert.equal(ledger.listSteps(task.id).length, 1, "no duplicate step row");
  });

  test("recording a tool result appends a real step with the tool_call_id persisted", () => {
    const { ledger, db } = makeLedger();
    const { task, claimed } = runningTask(ledger);
    recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_9",
      toolName: "get_recipe",
      result: '{"recipe":"x"}',
    });
    const row = db
      .prepare("SELECT tool_call_id FROM ledger_step WHERE task_id = ?")
      .get(task.id) as { tool_call_id: string | null };
    assert.equal(row.tool_call_id, "call_9", "tool-call-id must be persisted on the step");
    assert.equal(ledger.verifyChain(task.id), true, "chain stays verifiable");
  });
});

describe("canRetryTool (retry rule)", () => {
  test("readOnly tools may be retried on resume; mutating tools cannot", () => {
    assert.equal(canRetryTool({ readOnly: true }), true);
    assert.equal(canRetryTool({ readOnly: false }), false);
  });
});