import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import type {
  ToolCall,
  ToolCallResult,
  ToolInterceptor,
} from "../../../src/tools/pipeline.ts";
import { createGoalToolInterceptors } from "../../../src/tools/interceptors/order.ts";
import { createReserveInterceptor } from "../../../src/tools/interceptors/reserve.ts";
import {
  GOAL_TOOL_REFUSED,
  goalToolRefusalContent,
} from "../../../src/tools/interceptors/authorize.ts";
import { GoalLedger } from "../../../src/goals/ledger.ts";
import { migrateLedger } from "../../../src/ledger/index.ts";
import { toolArgsHash } from "../../../src/managers/cache.ts";
import { makeBodies, makeCall } from "../support.ts";

type MutationRow = {
  goal_id: string;
  plugin_id: string;
  tool: string;
  args_hash: string;
  state: string;
  step_seq: number | null;
};

type RefusalRow = {
  goal_id: string;
  step_seq: number;
  tool_call_id: string | null;
  tool: string;
  args_json: string | null;
  reason: string;
};

/**
 * A real in-memory ledger (v9 migration) with one CLAIMED running goal, so the
 * goal fence (part of the real M4 pipeline) passes and the `reserve`
 * interceptor writes genuine `goal_mutation`/`goal_refusal` rows.
 */
function makeGoalLedger(): {
  db: Database.Database;
  ledger: GoalLedger;
  goalId: string;
  leaseToken: string;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new GoalLedger(db);
  const goal = ledger.getOrCreateGoal({
    owner: "owner-1",
    idempotencyKey: "key-reserve",
    instruction: "do the thing",
    tokenBudget: 10_000,
  });
  const claimed = ledger.claimGoal(goal.id, "owner-1");
  return {
    db,
    ledger,
    goalId: goal.id,
    leaseToken: claimed.lease_token!,
  };
}

function mutationRows(db: Database.Database): MutationRow[] {
  return db
    .prepare("SELECT * FROM goal_mutation ORDER BY created_ts, rowid")
    .all() as MutationRow[];
}

function refusalRows(db: Database.Database): RefusalRow[] {
  return db
    .prepare("SELECT * FROM goal_refusal ORDER BY created_ts, rowid")
    .all() as RefusalRow[];
}

/** A mutating, authorised goal call; override per test. */
function goalCall(
  goalId: string,
  leaseToken: string,
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return makeCall({
    channel: "goal",
    pluginId: "vikunja",
    tool: "create_task",
    readOnly: false,
    goalAuthorised: true,
    goalId,
    stepSeq: 1,
    goalLeaseToken: leaseToken,
    ...overrides,
  });
}

/**
 * The goal-channel `reserve` guard (plan F3(b) / M4): mutating calls reserve
 * `(pluginId, tool, argsHash)` before egress and stamp the body's outcome after,
 * making identical mutations at-most-once. The matrix below is the full F3(b)
 * acceptance set: applied / unresolved (threw) / unresolved (domain failure) /
 * retryable (body never ran) / read-only no-op / redaction.
 */
describe("goal reserve interceptor (M4 / F3b)", () => {
  test("first mutating call applies; an identical second call is refused duplicate_mutation", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const results: ToolCallResult[] = [];
    let bodyRuns = 0;
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
      onResult: (_dispatch, result) => {
        results.push(result);
      },
    });
    const args = { title: "buy milk" };
    const call = goalCall(goalId, leaseToken, { args });

    const first = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async () => {
          bodyRuns += 1;
          return "created";
        },
      }),
    });
    assert.equal(first, "created");
    assert.equal(bodyRuns, 1);
    assert.equal(results[0]!.ok, true);

    const applied = mutationRows(db);
    assert.equal(applied.length, 1, "the reservation row is created once");
    assert.equal(applied[0]!.state, "applied", "a clean executed body is applied");
    assert.equal(applied[0]!.goal_id, goalId);
    assert.equal(applied[0]!.plugin_id, "vikunja");
    assert.equal(applied[0]!.tool, "create_task");
    assert.equal(
      applied[0]!.args_hash,
      toolArgsHash(args),
      "the row is keyed by the canonical args hash",
    );

    const second = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async () => {
          bodyRuns += 1;
          return "should-not-run";
        },
      }),
    });
    assert.equal(bodyRuns, 1, "the duplicate must not re-run the body");
    assert.equal(
      second,
      goalToolRefusalContent("duplicate_mutation", "create_task"),
      "the refusal is tool-visible",
    );
    assert.equal(results.length, 2);
    const refused = results[1]!;
    assert.equal(refused.ok, false);
    assert.equal(refused.outcome, "error");
    assert.equal(refused.errorCode, GOAL_TOOL_REFUSED);
    assert.equal(refused.bodyFailed, false);

    assert.equal(
      mutationRows(db).length,
      1,
      "the refusal must not add a mutation row",
    );
    assert.equal(mutationRows(db)[0]!.state, "applied");
    const refusals = refusalRows(db);
    assert.equal(refusals.length, 1, "exactly one refusal row is recorded");
    assert.equal(refusals[0]!.reason, "duplicate_mutation");
    assert.equal(refusals[0]!.tool, "create_task");
  });

  test("a throwing body is unresolved; an identical retry is refused unresolved_mutation", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    let bodyRuns = 0;
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
    });
    const call = goalCall(goalId, leaseToken, { args: { title: "x" } });
    const boom = new Error("provider exploded");

    await assert.rejects(
      pipeline.dispatch({
        call,
        bodies: makeBodies({
          plugin: async () => {
            bodyRuns += 1;
            throw boom;
          },
        }),
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(bodyRuns, 1);
    assert.equal(mutationRows(db).length, 1);
    assert.equal(
      mutationRows(db)[0]!.state,
      "unresolved",
      "a thrown body may have reached the provider",
    );

    const second = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async () => {
          bodyRuns += 1;
          return "should-not-run";
        },
      }),
    });
    assert.equal(bodyRuns, 1, "an unresolved identical call must not re-run");
    assert.equal(
      second,
      goalToolRefusalContent("unresolved_mutation", "create_task"),
    );
    const refusals = refusalRows(db);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]!.reason, "unresolved_mutation");
  });

  test("a body-reported domain failure is unresolved, not applied (tombstone regression)", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const results: ToolCallResult[] = [];
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
      onResult: (_dispatch, result) => {
        results.push(result);
      },
    });
    const call = goalCall(goalId, leaseToken, { args: { title: "x" } });

    const content = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async (dispatch) => {
          dispatch.bodyFailed = true;
          return "domain-error";
        },
      }),
    });
    assert.equal(content, "domain-error");
    assert.equal(results.length, 1);
    assert.equal(
      results[0]!.ok,
      true,
      "a domain failure is not a denial: ok stays true",
    );
    assert.equal(results[0]!.outcome, "ok");
    assert.equal(results[0]!.bodyFailed, true);
    assert.equal(
      mutationRows(db)[0]!.state,
      "unresolved",
      "an isError result must not be recorded applied",
    );
  });

  test("a body that never ran is retryable; the identical retry is permitted and applies", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    // An inner short-circuit: it denies WITHOUT running the body, so `executed`
    // stays false. It sits INSIDE `reserve` so the reservation row exists and
    // txn2 classifies it `retryable`.
    let deny = true;
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch, next) {
        if (deny) {
          dispatch.content = "short-circuited";
          dispatch.errorCode = "test_short";
          return;
        }
        await next();
      },
    };
    let bodyRuns = 0;
    const pipeline = createToolPipeline({
      interceptors: [
        createReserveInterceptor({ ledger, goalId }),
        short,
      ],
    });
    const call = goalCall(goalId, leaseToken, { args: { title: "x" } });

    const denied = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async () => {
          bodyRuns += 1;
          return "should-not-run";
        },
      }),
    });
    assert.equal(denied, "short-circuited");
    assert.equal(bodyRuns, 0, "the short-circuit must stop the body");
    assert.equal(mutationRows(db).length, 1);
    assert.equal(
      mutationRows(db)[0]!.state,
      "retryable",
      "a body that never ran is retryable, not a tombstone",
    );
    const firstId = (db.prepare("SELECT id FROM goal_mutation").get() as { id: string }).id;

    deny = false;
    const retried = await pipeline.dispatch({
      call,
      bodies: makeBodies({
        plugin: async () => {
          bodyRuns += 1;
          return "created";
        },
      }),
    });
    assert.equal(retried, "created");
    assert.equal(bodyRuns, 1);
    const rows = mutationRows(db);
    assert.equal(rows.length, 1, "the retryable row is replaced, not duplicated");
    assert.equal(rows[0]!.state, "applied");
    assert.notEqual(
      (db.prepare("SELECT id FROM goal_mutation").get() as { id: string }).id,
      firstId,
      "the retry re-inserts a fresh pending row",
    );
  });

  test("M2: a throwing markMutation does not mask a clean body or a body error", async () => {
    // (a) A clean body still yields ok:true even when txn2 bookkeeping throws.
    {
      const { db, ledger, goalId, leaseToken } = makeGoalLedger();
      (ledger as unknown as { markMutation: () => void }).markMutation = () => {
        throw new Error("db closed during shutdown");
      };
      const results: ToolCallResult[] = [];
      const pipeline = createToolPipeline({
        interceptors: createGoalToolInterceptors({ ledger, goalId }),
        onResult: (_dispatch, result) => results.push(result),
      });
      const content = await pipeline.dispatch({
        call: goalCall(goalId, leaseToken, { args: { title: "clean" } }),
        bodies: makeBodies({ plugin: async () => "created" }),
      });
      assert.equal(content, "created", "the clean body outcome survives");
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, true);
      assert.equal(results[0]!.outcome, "ok");
      // F3: the failed settle adopts the still-`pending` reservation to
      // `unresolved` (with adoptPendingMutations succeeding), so the goal is
      // resolvable instead of stranded until restart — pending rows are
      // invisible to `resolveMutations`.
      const rows = mutationRows(db);
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0]!.state,
        "unresolved",
        "a failed settle must leave the row resolvable, not pending",
      );
    }

    // (b) A throwing body still propagates ITS error, not the markMutation one.
    {
      const { ledger, goalId, leaseToken } = makeGoalLedger();
      (ledger as unknown as { markMutation: () => void }).markMutation = () => {
        throw new Error("bookkeeping exploded");
      };
      const pipeline = createToolPipeline({
        interceptors: createGoalToolInterceptors({ ledger, goalId }),
      });
      const boom = new Error("provider exploded");
      await assert.rejects(
        pipeline.dispatch({
          call: goalCall(goalId, leaseToken, { args: { title: "boom" } }),
          bodies: makeBodies({
            plugin: async () => {
              throw boom;
            },
          }),
        }),
        (error: unknown) => error === boom,
      );
    }
  });

  test("L6: a throwing recordGoalRefusal does not break a reserve denial", async () => {
    const { ledger, goalId, leaseToken } = makeGoalLedger();
    (ledger as unknown as { recordGoalRefusal: () => void }).recordGoalRefusal =
      () => {
        throw new Error("refusal log unavailable");
      };
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
    });
    const call = goalCall(goalId, leaseToken, { args: { title: "x" } });
    // Prime the mutation row so the identical second call is refused.
    await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => "created" }),
    });
    const second = await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => "should-not-run" }),
    });
    assert.equal(
      second,
      goalToolRefusalContent("duplicate_mutation", "create_task"),
    );
  });

  test("a read-only call is never reserved and never refused", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
    });
    const content = await pipeline.dispatch({
      call: goalCall(goalId, leaseToken, {
        tool: "list_tasks",
        readOnly: true,
        // No goalAuthorised needed: read-only calls are free.
      }),
      bodies: makeBodies({ plugin: async () => "tasks" }),
    });
    assert.equal(content, "tasks");
    assert.equal(mutationRows(db).length, 0, "read-only calls create no row");
    assert.equal(refusalRows(db).length, 0);
  });

  test("a refusal redacts args and never mutates the mutation row", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const pipeline = createToolPipeline({
      interceptors: createGoalToolInterceptors({ ledger, goalId }),
    });
    const call = goalCall(goalId, leaseToken, {
      args: { title: "x", apiKey: "supersecret-should-be-redacted" },
    });

    await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => "created" }),
    });
    const first = mutationRows(db);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.state, "applied");
    const appliedId = (db.prepare("SELECT id FROM goal_mutation").get() as { id: string }).id;

    await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => "should-not-run" }),
    });

    const refusals = refusalRows(db);
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.args_json !== null);
    assert.ok(
      !refusals[0]!.args_json!.includes("supersecret"),
      "the secret argument must not land in the durable refusal log",
    );
    assert.ok(
      refusals[0]!.args_json!.includes("***"),
      "the credential-shaped field is redacted",
    );

    const after = mutationRows(db);
    assert.equal(after.length, 1, "the refusal does not add a row");
    assert.equal(after[0]!.state, "applied", "the refusal does not change state");
    assert.equal(
      (db.prepare("SELECT id FROM goal_mutation").get() as { id: string }).id,
      appliedId,
      "the applied row is untouched",
    );
  });
});
