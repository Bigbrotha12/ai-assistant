import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  GOAL_MESSAGE_KEEP_RECENT,
  GOAL_MESSAGE_MAX,
  GOAL_STEP_LEASE_MS,
} from "../../src/goals/constants.ts";
import { GoalError } from "../../src/goals/errors.ts";
import { GoalLedger } from "../../src/goals/ledger.ts";
import type {
  GoalMessageRow,
  GoalRow,
  GoalTransitionTarget,
} from "../../src/goals/types.ts";
import { migrateLedger } from "../../src/ledger.ts";

const EPOCH = 1_700_000_000_000;

/**
 * In-memory goal ledger with a controlled clock. Mirrors the
 * `makeLedgerHarness` idiom in `test/account_delete.test.ts`: every expiry
 * assertion compares against `now()` rather than wall-clock time.
 */
function makeGoalLedger(): {
  db: Database.Database;
  ledger: GoalLedger;
  advance: (ms: number) => void;
  now: () => number;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  let current = EPOCH;
  const ledger = new GoalLedger(db, { now: () => current });
  return {
    db,
    ledger,
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function seedGoal(
  ledger: GoalLedger,
  owner = "owner-1",
  idempotencyKey = "key-1",
): GoalRow {
  return ledger.getOrCreateGoal({
    owner,
    idempotencyKey,
    instruction: "do the thing",
    tokenBudget: 1000,
  });
}

/** No public single-goal getter; raw read keeps the assertion surface direct. */
function readGoal(db: Database.Database, goalId: string): GoalRow {
  return db
    .prepare("SELECT * FROM goal WHERE id = ?")
    .get(goalId) as GoalRow;
}

function readMessages(
  db: Database.Database,
  goalId: string,
): GoalMessageRow[] {
  return db
    .prepare("SELECT * FROM goal_message WHERE goal_id = ? ORDER BY seq ASC")
    .all(goalId) as GoalMessageRow[];
}

function contentOf(row: GoalMessageRow): unknown {
  return JSON.parse(row.content_json);
}

function insertMutation(
  db: Database.Database,
  goalId: string,
  state: string,
  suffix: string,
): void {
  db.prepare(
    `INSERT INTO goal_mutation
       (id, goal_id, plugin_id, tool, args_hash, state, step_seq, created_ts)
     VALUES (?, ?, 'plugin', 'tool', ?, ?, 1, ?)`,
  ).run(`mut-${suffix}`, goalId, `hash-${suffix}`, state, EPOCH);
}

/**
 * Rule 3 of plan §Storage compaction: a `tool` row is only ever deleted with
 * its group head, so every maximal run of consecutive tool rows must still be
 * immediately preceded by the assistant row that heads it.
 */
function assertNoOrphanedTools(rows: GoalMessageRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.role !== "tool") continue;
    if (rows[i - 1]?.role === "tool") continue; // continuation of a run
    assert.equal(
      rows[i - 1]?.role,
      "assistant",
      `tool seq ${row.seq} has no assistant head immediately before it`,
    );
  }
}

/**
 * Seeds one message row DIRECTLY (raw INSERT, like `seedGoalRows` in
 * account_delete.test.ts). The compaction regression tests use this to build
 * an uncompacted log of exactly the adversarial shape the runner can produce:
 * appending the whole history through `appendGoalMessage` would let inline
 * compaction reshape it before it reaches the > `GOAL_MESSAGE_MAX` boundary.
 */
function seedRawMessage(
  db: Database.Database,
  goalId: string,
  seq: number,
  row: { role: string; content: string; toolCalls?: unknown[] },
): void {
  db.prepare(
    `INSERT INTO goal_message
       (id, goal_id, seq, role, content_json, tool_calls_json,
        tool_call_id, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    `m-${seq}`,
    goalId,
    seq,
    row.role,
    JSON.stringify(row.content),
    row.toolCalls === undefined ? null : JSON.stringify(row.toolCalls),
    EPOCH,
  );
}

describe("GoalLedger.getOrCreateGoal", () => {
  test("mints a g_-prefixed id and is idempotent per (owner, idempotencyKey)", () => {
    const { db, ledger } = makeGoalLedger();
    const first = seedGoal(ledger, "user-1", "key-a");
    assert.match(first.id, /^g_/);
    assert.equal(first.status, "queued");
    assert.equal(first.tokens_spent, 0);
    assert.equal(first.owner, "user-1");

    const second = ledger.getOrCreateGoal({
      owner: "user-1",
      idempotencyKey: "key-a",
      instruction: "a different instruction is ignored",
      tokenBudget: 999,
    });
    assert.equal(second.id, first.id, "repeat key returns the SAME row");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM goal").get() as { c: number }).c,
      1,
      "the repeat must not create a second row",
    );

    const differentKey = seedGoal(ledger, "user-1", "key-b");
    assert.notEqual(differentKey.id, first.id);

    // The key namespace is per owner: same key, different owner, distinct goal.
    const otherOwner = seedGoal(ledger, "user-2", "key-a");
    assert.notEqual(otherOwner.id, first.id);
  });

  test("todos and authorised_tools survive a JSON round-trip", () => {
    const { ledger } = makeGoalLedger();
    const todos = [{ id: "t1", text: "book", done: false }];
    const tools = ["search", "email"];
    const row = ledger.getOrCreateGoal({
      owner: "o",
      idempotencyKey: "k",
      instruction: "i",
      tokenBudget: 5,
      todos,
      authorisedTools: tools,
      agentSnapshot: "snap",
      pinnedModel: "model-x",
    });
    assert.deepEqual(JSON.parse(row.todos!), todos);
    assert.deepEqual(JSON.parse(row.authorised_tools!), tools);
    assert.equal(row.agent_snapshot, "snap");
    assert.equal(row.pinned_model, "model-x");
  });
});

describe("GoalLedger.claimGoal", () => {
  test("claims queued -> running and mints a lease expiring one step window out", () => {
    const { ledger, now } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");
    assert.equal(claimed.status, "running");
    assert.ok(claimed.lease_token && claimed.lease_token.length > 0);
    assert.equal(claimed.lease_owner, "owner-1");
    assert.equal(claimed.lease_expiry, now() + GOAL_STEP_LEASE_MS);
    assert.equal(claimed.tokens_spent, 0);
  });

  test("a second claim of a running goal is an invalid transition", () => {
    const { ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    ledger.claimGoal(goal.id, "owner-1");
    assert.throws(
      () => ledger.claimGoal(goal.id, "owner-1"),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_INVALID_TRANSITION",
    );
  });

  test("unknown id is GOAL_NOT_FOUND and a non-owner is GOAL_FORBIDDEN", () => {
    const { ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    assert.throws(
      () => ledger.claimGoal("g_missing", "owner-1"),
      (e: unknown) => e instanceof GoalError && e.code === "GOAL_NOT_FOUND",
    );
    assert.throws(
      () => ledger.claimGoal(goal.id, "intruder"),
      (e: unknown) => e instanceof GoalError && e.code === "GOAL_FORBIDDEN",
    );
  });
});

describe("GoalLedger.pauseGoal", () => {
  test("pausing clears the lease and records reason/question/summary", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    assert.equal(
      ledger.pauseGoal(goal.id, "owner-1", {
        next: "paused",
        reason: "needs_user_input",
        question: "which flight?",
        summary: "reached a fork",
        leaseOwner: "owner-1",
        leaseToken: claimed.lease_token!,
      }),
      true,
    );

    const row = readGoal(db, goal.id);
    assert.equal(row.status, "paused");
    assert.equal(row.pause_reason, "needs_user_input");
    assert.equal(row.pause_question, "which flight?");
    assert.equal(row.result_summary, "reached a fork");
    assert.equal(row.lease_owner, null, "paused goal holds no lease");
    assert.equal(row.lease_token, null);
    assert.equal(row.lease_expiry, null);
  });

  test("a control-tool terminal transition (complete) keeps the lease columns", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    ledger.pauseGoal(goal.id, "owner-1", {
      next: "complete",
      summary: "done",
      leaseOwner: "owner-1",
      leaseToken: claimed.lease_token!,
    });

    const row = readGoal(db, goal.id);
    assert.equal(row.status, "complete");
    assert.equal(row.lease_owner, "owner-1");
    assert.equal(row.lease_token, claimed.lease_token);
    assert.equal(row.lease_expiry, claimed.lease_expiry);
  });

  test("a wrong lease token is GOAL_LEASE_CONFLICT; re-pausing a paused goal is invalid", () => {
    const { ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    assert.throws(
      () =>
        ledger.pauseGoal(goal.id, "owner-1", {
          next: "paused",
          reason: "credentials_required",
          leaseOwner: "owner-1",
          leaseToken: "wrong-token",
        }),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_LEASE_CONFLICT",
    );

    ledger.pauseGoal(goal.id, "owner-1", {
      next: "paused",
      reason: "credentials_required",
      leaseOwner: "owner-1",
      leaseToken: claimed.lease_token!,
    });
    assert.throws(
      () =>
        ledger.pauseGoal(goal.id, "owner-1", {
          next: "paused",
          reason: "credentials_required",
          leaseOwner: "owner-1",
          leaseToken: claimed.lease_token!,
        }),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_INVALID_TRANSITION",
    );
  });

  test("a partial lease (exactly one half) is rejected and the goal stays running", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    // Owner-only is a half-fence: claimGoal stamps lease_owner := owner, so
    // the clause is tautological. Both halves or neither.
    assert.throws(
      () =>
        ledger.pauseGoal(goal.id, "owner-1", {
          next: "paused",
          leaseOwner: "owner-1",
        }),
      (e: unknown) =>
        e instanceof GoalError &&
        e.code === "GOAL_INVALID_TRANSITION" &&
        /supplied together/.test(e.message),
    );
    // The token-only half is the same silent half-fence.
    assert.throws(
      () =>
        ledger.pauseGoal(goal.id, "owner-1", {
          next: "paused",
          leaseToken: claimed.lease_token!,
        }),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_INVALID_TRANSITION",
    );

    assert.equal(readGoal(db, goal.id).status, "running");
    assert.equal(readGoal(db, goal.id).lease_token, claimed.lease_token);
  });

  test("next='queued' is rejected by the runtime guard (re-chaining owns its CAS in Phase 3)", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    ledger.claimGoal(goal.id, "owner-1");

    assert.throws(
      () =>
        ledger.pauseGoal(goal.id, "owner-1", {
          // The type forbids it; the cast asserts the runtime guard.
          next: "queued" as unknown as GoalTransitionTarget,
        }),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_INVALID_TRANSITION",
    );
    assert.equal(readGoal(db, goal.id).status, "running");
  });

  test("composes with a caller transaction: message + pause commit together", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    db.transaction(() => {
      db.prepare(
        `INSERT INTO goal_message
           (id, goal_id, seq, role, content_json, created_ts)
         VALUES ('m-1', ?, 1, 'user', ?, ?)`,
      ).run(goal.id, JSON.stringify("hello"), EPOCH);
      ledger.pauseGoal(goal.id, "owner-1", {
        next: "paused",
        reason: "credentials_required",
        leaseOwner: "owner-1",
        leaseToken: claimed.lease_token!,
      });
    })();

    assert.equal(readGoal(db, goal.id).status, "paused");
    assert.equal(readMessages(db, goal.id).length, 1);
  });

  test("a failing pauseGoal rolls back the caller transaction's message", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    ledger.claimGoal(goal.id, "owner-1"); // running; token below is wrong

    assert.throws(
      () => {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO goal_message
               (id, goal_id, seq, role, content_json, created_ts)
             VALUES ('m-1', ?, 1, 'user', ?, ?)`,
          ).run(goal.id, JSON.stringify("hello"), EPOCH);
          ledger.pauseGoal(goal.id, "owner-1", {
            next: "paused",
            reason: "setup_timeout",
            leaseOwner: "owner-1",
            leaseToken: "wrong-token",
          });
        })();
      },
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_LEASE_CONFLICT",
    );

    assert.equal(
      readMessages(db, goal.id).length,
      0,
      "the message insert must roll back with the failed pause",
    );
    assert.equal(readGoal(db, goal.id).status, "running");
  });
});

describe("GoalLedger.resumeGoal", () => {
  test("appends the durable answer and requeues paused -> queued atomically", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    ledger.claimGoal(goal.id, "owner-1");
    const claimed = readGoal(db, goal.id);
    ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "assistant",
      content: { question: "which flight?" },
    });
    ledger.pauseGoal(goal.id, "owner-1", {
      next: "paused",
      reason: "needs_user_input",
      question: "which flight?",
      leaseOwner: "owner-1",
      leaseToken: claimed.lease_token!,
    });

    ledger.resumeGoal(goal.id, "owner-1", "the 8am one");

    const row = readGoal(db, goal.id);
    assert.equal(row.status, "queued");
    assert.equal(row.pause_reason, null, "the answered prompt is cleared");
    assert.equal(row.pause_question, null);
    assert.equal(row.run_started_ts, null, "the next claim starts a fresh run");
    const messages = readMessages(db, goal.id);
    assert.equal(messages.at(-1)!.role, "user");
    assert.equal(contentOf(messages.at(-1)!), "the 8am one");
  });

  test("a refused resume appends NOTHING even without a caller transaction (5.1)", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    ledger.claimGoal(goal.id, "owner-1");
    const claimed = readGoal(db, goal.id);
    ledger.pauseGoal(goal.id, "owner-1", {
      next: "paused",
      reason: "needs_user_input",
      question: "which flight?",
      leaseOwner: "owner-1",
      leaseToken: claimed.lease_token!,
    });
    // A paused row that still carries a lease is the CAS refusal case — and
    // this call deliberately has NO route-level `transaction(...)` around it:
    // atomicity must not be caller-dependent. A `false` return (the old
    // contract) would let `appendGoalMessage`'s own transaction COMMIT the
    // answer onto a goal that never resumed, leaving the log with an answer to
    // a question the user was never shown.
    db.prepare(
      "UPDATE goal SET lease_owner = 'someone', lease_token = 'tok' WHERE id = ?",
    ).run(goal.id);
    const messagesBefore = readMessages(db, goal.id).length;

    assert.throws(
      () => ledger.resumeGoal(goal.id, "owner-1", "the 8am one"),
      (error: unknown) =>
        error instanceof GoalError && error.code === "GOAL_INVALID_TRANSITION",
      "a lost CAS is classified, not swallowed",
    );

    assert.equal(
      readMessages(db, goal.id).length,
      messagesBefore,
      "the answer rolled back with the refused resume",
    );
    const row = readGoal(db, goal.id);
    assert.equal(row.status, "paused");
    assert.equal(row.pause_reason, "needs_user_input");
    assert.equal(row.pause_question, "which flight?");
  });
});

describe("GoalLedger.renewGoalLease", () => {
  test("extends expiry by one step window without rotating the token", () => {
    const { db, ledger, advance, now } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");
    const tokenBefore = claimed.lease_token;

    advance(60_000);
    ledger.renewGoalLease(goal.id, "owner-1", "owner-1", tokenBefore!);

    const row = readGoal(db, goal.id);
    assert.equal(row.lease_expiry, now() + GOAL_STEP_LEASE_MS);
    assert.notEqual(row.lease_expiry, claimed.lease_expiry, "expiry moved");
    assert.equal(row.lease_token, tokenBefore, "token must not rotate");
  });

  test("a wrong token is GOAL_LEASE_CONFLICT and leaves the lease untouched", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const claimed = ledger.claimGoal(goal.id, "owner-1");

    assert.throws(
      () => ledger.renewGoalLease(goal.id, "owner-1", "owner-1", "wrong"),
      (e: unknown) =>
        e instanceof GoalError && e.code === "GOAL_LEASE_CONFLICT",
    );

    const row = readGoal(db, goal.id);
    assert.equal(row.lease_token, claimed.lease_token);
    assert.equal(row.lease_expiry, claimed.lease_expiry);
  });
});

describe("GoalLedger.appendGoalMessage", () => {
  test("seq starts at 1 and increments per goal independently", () => {
    const { ledger } = makeGoalLedger();
    const a = seedGoal(ledger, "owner-1", "a");
    const b = seedGoal(ledger, "owner-1", "b");

    assert.equal(
      ledger.appendGoalMessage(a.id, "owner-1", { role: "user", content: "1" })
        .seq,
      1,
    );
    assert.equal(
      ledger.appendGoalMessage(a.id, "owner-1", {
        role: "assistant",
        content: "2",
      }).seq,
      2,
    );
    assert.equal(
      ledger.appendGoalMessage(b.id, "owner-1", { role: "user", content: "1" })
        .seq,
      1,
      "each goal has its own seq counter",
    );
    assert.equal(
      ledger.appendGoalMessage(a.id, "owner-1", { role: "user", content: "3" })
        .seq,
      3,
    );
  });

  test("content_json and tool_calls_json round-trip through JSON", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const content = { role: "assistant", content: "hi", extra: [1, 2, 3] };
    const toolCalls = [{ id: "call-1", name: "search", args: { q: "x" } }];

    const appended = ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "assistant",
      content,
      toolCalls,
      toolCallId: "call-1",
    });
    assert.deepEqual(JSON.parse(appended.content_json), content);
    assert.deepEqual(JSON.parse(appended.tool_calls_json!), toolCalls);
    assert.equal(appended.tool_call_id, "call-1");

    const [row] = readMessages(db, goal.id);
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.content_json), content);
    assert.deepEqual(JSON.parse(row.tool_calls_json!), toolCalls);
  });

  test("compacts the oldest messages once the log exceeds GOAL_MESSAGE_MAX", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    const total = GOAL_MESSAGE_MAX + 5;
    for (let i = 1; i <= total; i++) {
      ledger.appendGoalMessage(goal.id, "owner-1", {
        role: "user",
        content: `m-${i}`,
      });
    }

    const rows = readMessages(db, goal.id);
    assert.ok(
      rows.length <= GOAL_MESSAGE_MAX,
      `surviving count ${rows.length} exceeds GOAL_MESSAGE_MAX`,
    );
    assert.ok(
      rows.length >= GOAL_MESSAGE_KEEP_RECENT,
      `surviving count ${rows.length} fell below KEEP_RECENT`,
    );
    const seqs = rows.map((r) => r.seq);
    assert.equal(seqs.at(-1), total, "the newest message survives");
    assert.ok(!seqs.includes(1), "the oldest message was compacted");
    assert.ok(seqs[0]! > 1, "compaction walks from the oldest");
  });

  test("compacts oldest groups first, preserves a recent group, and never orphans a tool", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);

    // 92 complete assistant->tool groups (184 rows) form the oldest block.
    const oldGroups = 92;
    for (let i = 0; i < oldGroups; i++) {
      ledger.appendGoalMessage(goal.id, "owner-1", {
        role: "assistant",
        content: i === 0 ? "OLDEST-GROUP" : `old-assistant-${i}`,
      });
      ledger.appendGoalMessage(goal.id, "owner-1", {
        role: "tool",
        content: i === 0 ? "OLDEST-TOOL" : `old-tool-${i}`,
      });
    }
    // The tail group: assistant + two tools, then more appends so it sits
    // inside the retained recent window when compaction runs at the cap.
    ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "assistant",
      content: "TAIL-GROUP",
    });
    ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "tool",
      content: "TAIL-TOOL-1",
    });
    ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "tool",
      content: "TAIL-TOOL-2",
    });

    const total = GOAL_MESSAGE_MAX + 5;
    for (let i = oldGroups * 2 + 3; i < total; i++) {
      ledger.appendGoalMessage(goal.id, "owner-1", {
        role: "user",
        content: `single-${i}`,
      });
    }

    const rows = readMessages(db, goal.id);
    assert.ok(
      rows.length <= GOAL_MESSAGE_MAX && rows.length >= GOAL_MESSAGE_KEEP_RECENT,
    );

    const contents = rows.map((r) => contentOf(r));
    assert.ok(
      !contents.includes("OLDEST-GROUP"),
      "the oldest group head must be compacted first",
    );
    assert.ok(
      !contents.includes("OLDEST-TOOL"),
      "the oldest group's tool must be deleted with its head",
    );
    assert.ok(contents.includes("TAIL-GROUP"), "recent group head survives");
    assert.ok(contents.includes("TAIL-TOOL-1"));
    assert.ok(contents.includes("TAIL-TOOL-2"));

    const tailStart = rows.findIndex((r) => contentOf(r) === "TAIL-GROUP");
    assert.ok(tailStart >= 0);
    assert.ok(
      tailStart >= rows.length - GOAL_MESSAGE_KEEP_RECENT,
      "the tail group must sit inside the retained recent window",
    );
    assert.equal(rows[tailStart + 1]!.role, "tool");
    assert.equal(rows[tailStart + 2]!.role, "tool");
    assertNoOrphanedTools(rows);
  });

  test("regression: compaction never deletes the just-appended in-progress group head (M2/M3 orphaning)", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);

    // 201-row adversarial history, seeded raw (see `seedRawMessage`):
    //   seq 1-2:   an old assistant->tool group (deletable, oldest-first);
    //   seq 3:     one assistant head with 195 parallel tool_calls —
    //   seq 4-198: its 195 tool results (ONE group of 196 rows, the plan
    //              allows N sibling calls per ToolNode round);
    //   seq 199-201: three user singles.
    seedRawMessage(db, goal.id, 1, { role: "assistant", content: "OLD-HEAD" });
    seedRawMessage(db, goal.id, 2, { role: "tool", content: "OLD-TOOL" });
    seedRawMessage(db, goal.id, 3, {
      role: "assistant",
      content: "HUGE-HEAD",
      toolCalls: Array.from({ length: 195 }, (_, i) => ({ id: `call-${i}` })),
    });
    for (let i = 0; i < 195; i++) {
      seedRawMessage(db, goal.id, 4 + i, {
        role: "tool",
        content: `HUGE-TOOL-${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      seedRawMessage(db, goal.id, 199 + i, {
        role: "user",
        content: `SINGLE-${i}`,
      });
    }

    // The runner appends the assistant BEFORE its tool responses exist; the
    // append crosses the cap and triggers the walk with the returned row as
    // the max-seq row.
    const appended = ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "assistant",
      content: "QUESTION",
      toolCalls: [{ id: "call-final", name: "search", args: {} }],
    });

    const rows = readMessages(db, goal.id);
    assert.ok(
      rows.some((r) => r.id === appended.id),
      "the returned GoalMessageRow must still be persisted after the append",
    );
    assert.ok(
      rows.some((r) => contentOf(r) === "QUESTION"),
      "the question survives compaction (plan §Control tools)",
    );
    assertNoOrphanedTools(rows);
    assert.ok(
      rows.length >= GOAL_MESSAGE_KEEP_RECENT &&
        rows.length <= GOAL_MESSAGE_MAX,
      `surviving count ${rows.length} outside [KEEP_RECENT, MAX]`,
    );

    // The huge group is untouched: head + all 195 tool results survive and
    // stay adjacent.
    const hugeHead = rows.findIndex((r) => contentOf(r) === "HUGE-HEAD");
    assert.ok(hugeHead >= 0, "the huge group head survives");
    assert.equal(rows[hugeHead + 1]!.role, "tool");
    const hugeTools = rows.filter(
      (r) =>
        typeof contentOf(r) === "string" &&
        (contentOf(r) as string).startsWith("HUGE-TOOL-"),
    );
    assert.equal(hugeTools.length, 195, "the huge group's tool rows survive");

    // The oldest group is what the walk could afford to delete.
    assert.ok(!rows.some((r) => contentOf(r) === "OLD-HEAD"));
    assert.ok(!rows.some((r) => contentOf(r) === "OLD-TOOL"));
  });

  test("regression: the row an append just returned is never compacted away, even as a deletable single", () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);

    // 200 raw rows: one huge assistant->tool group (196 rows) floor-blocking
    // the walk, plus four user singles. The next append crosses the cap and
    // the singles walk runs to the end of the log.
    seedRawMessage(db, goal.id, 1, {
      role: "assistant",
      content: "HUGE-HEAD",
      toolCalls: Array.from({ length: 195 }, (_, i) => ({ id: `call-${i}` })),
    });
    for (let i = 0; i < 195; i++) {
      seedRawMessage(db, goal.id, 2 + i, {
        role: "tool",
        content: `HUGE-TOOL-${i}`,
      });
    }
    for (let i = 0; i < 4; i++) {
      seedRawMessage(db, goal.id, 197 + i, {
        role: "user",
        content: `SINGLE-${i}`,
      });
    }

    const appended = ledger.appendGoalMessage(goal.id, "owner-1", {
      role: "user",
      content: "NEWEST",
    });

    const rows = readMessages(db, goal.id);
    assert.ok(
      rows.some((r) => r.id === appended.id),
      "the just-returned row (max seq) must never be a deletion candidate",
    );
    assert.ok(
      rows.some((r) => contentOf(r) === "NEWEST"),
      "the newest message survives compaction",
    );
    assertNoOrphanedTools(rows);
    assert.ok(
      rows.length >= GOAL_MESSAGE_KEEP_RECENT &&
        rows.length <= GOAL_MESSAGE_MAX,
      `surviving count ${rows.length} outside [KEEP_RECENT, MAX]`,
    );
    assert.equal(
      rows.filter((r) => contentOf(r) === "SINGLE-3").length,
      0,
      "the deletable singles older than the newest are compacted",
    );
  });
});

describe("GoalLedger.effectState", () => {
  // Plan §Storage literal rule: "unknown if any unresolved or pending; else
  // completed_steps_only if any applied; else none_known".
  test('no mutations -> "none_known"', () => {
    const { ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    assert.equal(ledger.effectState(goal.id), "none_known");
  });

  test('a pending mutation -> "unknown"', () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    insertMutation(db, goal.id, "pending", "pending");
    assert.equal(ledger.effectState(goal.id), "unknown");
  });

  test('an unresolved mutation -> "unknown"', () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    insertMutation(db, goal.id, "unresolved", "unresolved");
    assert.equal(ledger.effectState(goal.id), "unknown");
  });

  test('an applied mutation -> "completed_steps_only"', () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    insertMutation(db, goal.id, "applied", "applied");
    assert.equal(ledger.effectState(goal.id), "completed_steps_only");
  });

  test('only retryable mutations -> "none_known" (plan §Storage literal rule)', () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    insertMutation(db, goal.id, "retryable", "retryable-1");
    insertMutation(db, goal.id, "retryable", "retryable-2");
    assert.equal(ledger.effectState(goal.id), "none_known");
  });

  test('applied + unresolved -> "unknown" (any-wins)', () => {
    const { db, ledger } = makeGoalLedger();
    const goal = seedGoal(ledger);
    insertMutation(db, goal.id, "applied", "applied");
    insertMutation(db, goal.id, "unresolved", "unresolved");
    assert.equal(ledger.effectState(goal.id), "unknown");
  });
});

describe("GoalLedger.countActiveGoals", () => {
  test("counts queued + running only, isolated per owner", () => {
    const { ledger } = makeGoalLedger();

    seedGoal(ledger, "o1", "queued"); // queued (never claimed)

    const running = seedGoal(ledger, "o1", "running");
    ledger.claimGoal(running.id, "o1");

    const paused = seedGoal(ledger, "o1", "paused");
    ledger.claimGoal(paused.id, "o1");
    ledger.pauseGoal(paused.id, "o1", { next: "paused", reason: "needs_mutation_resolution" });

    const complete = seedGoal(ledger, "o1", "complete");
    ledger.claimGoal(complete.id, "o1");
    ledger.pauseGoal(complete.id, "o1", { next: "complete" });

    const failed = seedGoal(ledger, "o1", "failed");
    ledger.claimGoal(failed.id, "o1");
    ledger.pauseGoal(failed.id, "o1", { next: "failed" });

    const cancelled = seedGoal(ledger, "o1", "cancelled");
    ledger.claimGoal(cancelled.id, "o1");
    ledger.pauseGoal(cancelled.id, "o1", { next: "cancelled" });

    seedGoal(ledger, "o2", "queued"); // other owner's queued goal

    assert.equal(ledger.countActiveGoals("o1"), 2);
    assert.equal(ledger.countActiveGoals("o2"), 1);
    assert.equal(ledger.countActiveGoals("nobody"), 0);
  });
});
