import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import type { ToolCallResult } from "../../../src/tools/pipeline.ts";
import {
  createAuthorizeInterceptor,
  GOAL_TOOL_REFUSED,
  goalToolRefusalContent,
} from "../../../src/tools/interceptors/authorize.ts";
import { GoalLedger } from "../../../src/goals/ledger.ts";
import { migrateLedger } from "../../../src/ledger.ts";
import { makeBodies, makeCall } from "../support.ts";

type RefusalRow = {
  goal_id: string;
  step_seq: number;
  tool_call_id: string | null;
  tool: string;
  args_json: string | null;
  reason: string;
};

/**
 * A real in-memory ledger (v9 migration) with one admitted goal, so the
 * `authorize` interceptor's `recordGoalRefusal` writes a genuine append-only
 * `goal_refusal` row instead of hitting a test double.
 */
function makeGoalLedger(): {
  db: Database.Database;
  ledger: GoalLedger;
  goalId: string;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new GoalLedger(db);
  const goal = ledger.getOrCreateGoal({
    owner: "owner-1",
    idempotencyKey: "key-authorize",
    instruction: "do the thing",
    tokenBudget: 10_000,
  });
  return { db, ledger, goalId: goal.id };
}

function refusalRows(db: Database.Database): RefusalRow[] {
  return db
    .prepare("SELECT * FROM goal_refusal ORDER BY created_ts, rowid")
    .all() as RefusalRow[];
}

function goalCall(
  goalId: string,
  overrides: Record<string, unknown> = {},
) {
  return makeCall({
    channel: "goal",
    goalId,
    stepSeq: 3,
    goalLeaseToken: "lease-1",
    ...overrides,
  });
}

/**
 * The goal-channel `authorize` guard (M4/§goalAuthorised): a MUTATING call is
 * refused unless the binder stamped `goalAuthorised` from the goal's
 * admission-time `authorised_tools`. A refusal is a pipeline denial — it
 * records an append-only, redacted `goal_refusal`, sets the tool-visible
 * content + `goal_tool_refused`, and returns without running the body.
 */
describe("goal authorize interceptor (M4)", () => {
  test("a read-only call passes without a refusal", async () => {
    const { db, ledger, goalId } = makeGoalLedger();
    const pipeline = createToolPipeline({
      interceptors: [createAuthorizeInterceptor({ ledger, goalId })],
    });
    const content = await pipeline.dispatch({
      call: goalCall(goalId, { readOnly: true }),
      bodies: makeBodies({ plugin: async () => "read-ok" }),
    });
    assert.equal(content, "read-ok");
    assert.equal(refusalRows(db).length, 0);
  });

  test("a goalAuthorised mutating call passes without a refusal", async () => {
    const { db, ledger, goalId } = makeGoalLedger();
    const pipeline = createToolPipeline({
      interceptors: [createAuthorizeInterceptor({ ledger, goalId })],
    });
    const content = await pipeline.dispatch({
      call: goalCall(goalId, { readOnly: false, goalAuthorised: true }),
      bodies: makeBodies({ plugin: async () => "write-ok" }),
    });
    assert.equal(content, "write-ok");
    assert.equal(refusalRows(db).length, 0);
  });

  test("a non-read-only, non-authorised call is refused, logged, and never dispatched", async () => {
    const { db, ledger, goalId } = makeGoalLedger();
    const results: ToolCallResult[] = [];
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createAuthorizeInterceptor({ ledger, goalId })],
      onResult: (_dispatch, result) => {
        results.push(result);
      },
    });
    const content = await pipeline.dispatch({
      call: goalCall(goalId, {
        readOnly: false,
        // No `goalAuthorised` stamp: the binder never surfaced this name.
        tool: "write_tool",
        toolCallId: "call-refused",
        args: { value: "x", apiKey: "supersecret-should-be-redacted" },
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "never";
        },
      }),
    });

    assert.equal(bodyRan, false, "the body must not run on a refusal");
    assert.ok(content.length > 0, "the refusal content is tool-visible");
    assert.equal(content, goalToolRefusalContent("unauthorized", "write_tool"));

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "error");
    assert.equal(result.errorCode, GOAL_TOOL_REFUSED);
    assert.equal(result.bodyFailed, false);

    const rows = refusalRows(db);
    assert.equal(rows.length, 1, "exactly one refusal row is recorded");
    const row = rows[0]!;
    assert.equal(row.goal_id, goalId);
    assert.equal(row.step_seq, 3);
    assert.equal(row.tool_call_id, "call-refused");
    assert.equal(row.tool, "write_tool");
    assert.equal(row.reason, "unauthorized");
    assert.ok(row.args_json !== null);
    assert.ok(
      !row.args_json.includes("supersecret"),
      "the secret argument must not land in the durable refusal log",
    );
    assert.ok(row.args_json.includes("***"), "the credential field is redacted");
  });

  test("L6: a throwing recordGoalRefusal does not convert the denial into a throw", async () => {
    const { ledger, goalId } = makeGoalLedger();
    (ledger as unknown as { recordGoalRefusal: () => void }).recordGoalRefusal =
      () => {
        throw new Error("refusal log unavailable");
      };
    const results: ToolCallResult[] = [];
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createAuthorizeInterceptor({ ledger, goalId })],
      onResult: (_dispatch, result) => results.push(result),
    });
    const content = await pipeline.dispatch({
      call: goalCall(goalId, {
        readOnly: false,
        tool: "write_tool",
        args: { value: "x" },
      }),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "never";
        },
      }),
    });
    assert.equal(bodyRan, false);
    assert.equal(content, goalToolRefusalContent("unauthorized", "write_tool"));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.outcome, "error");
    assert.equal(results[0]!.errorCode, GOAL_TOOL_REFUSED);
  });
});
