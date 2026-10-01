import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";

import {
  GOAL_MESSAGE_KEEP_RECENT,
  GOAL_MESSAGE_MAX,
  GOAL_STEP_LEASE_MS,
} from "./constants.ts";
import { GoalError } from "./errors.ts";
import { GOAL_MESSAGE_DELETE_TRIGGER_SQL } from "./migrate.ts";
import { isUniqueConstraintViolation } from "../sqlite_errors.ts";
import type {
  GoalEffectState,
  GoalMessageRow,
  GoalRow,
  GoalStatus,
  GoalTransitionTarget,
} from "./types.ts";
import { GOAL_TRANSITION_TARGETS } from "./types.ts";

/**
 * Goal ledger accessors (Phase 2.2) — the read/write surface over the v9
 * goal tables (`goals/migrate.ts`). Mirrors `Ledger`'s shape: takes the raw
 * `DatabaseType` and owns its own `now` wiring, because `Ledger`'s helpers
 * (`db`, `now`, `appendTx`, `require*`) are all private.
 *
 * Every mutating accessor is a compare-and-set: the guarded read classifies
 * the failure for the caller, the CAS UPDATE re-checks the preconditions in
 * its WHERE clause (a concurrent writer cannot slip between read and write),
 * and `changes === 0` re-reads the row to raise the precise `GoalError`.
 *
 * Phase 3 consumers: `claimGoal`/`renewGoalLease`/`pauseGoal` feed the goal
 * runner and the goal fence (the runner holds `lease_token` for exactly one
 * step since `beforeModelCall` renews); `appendGoalMessage` feeds the control
 * tools' message log; `getOrCreateGoal`/`countActiveGoals` feed route
 * admission (the `GOAL_MAX_CONCURRENT_PER_OWNER` cap is enforced there).
 */

export interface GoalLedgerConfig {
  /** Injectable clock, mirroring `LedgerConfig.now`; defaults to `Date.now`. */
  now?: () => number;
}

export interface GetOrCreateGoalInput {
  owner: string;
  idempotencyKey: string;
  instruction: string;
  tokenBudget: number;
  agentSnapshot?: string;
  pinnedModel?: string;
  authorisedTools?: string[];
  todos?: unknown[];
}

export interface PauseGoalParams {
  /**
   * Transition target, narrowed to [GoalTransitionTarget] and runtime-checked:
   * `running -> queued` re-chaining and cancel own their own CAS in Phase 3
   * and must not be expressed through this accessor.
   */
  next: GoalTransitionTarget;
  reason?: string;
  question?: string;
  summary?: string;
  /** Lease proof held by the caller (the runner knows its own lease). Must be
   *  supplied TOGETHER with [leaseToken] (or both omitted — then the CAS omits
   *  the lease WHERE clauses). A half-fence is rejected: `claimGoal` stamps
   *  `lease_owner := owner`, so an owner-only clause is tautological. */
  leaseOwner?: string;
  leaseToken?: string;
  nowOverride?: number;
}

export interface AppendGoalMessageInput {
  role: "user" | "assistant" | "tool";
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
}

export class GoalLedger {
  private readonly db: DatabaseType;
  private readonly now: () => number;

  constructor(db: DatabaseType, config: GoalLedgerConfig = {}) {
    this.db = db;
    this.now = config.now ?? Date.now;
  }

  // ---------------------------------------------------------------- guards

  /** Guarded read: the goal must exist (else `GOAL_NOT_FOUND`). */
  private requireGoal(goalId: string): GoalRow {
    const row = this.db
      .prepare("SELECT * FROM goal WHERE id = ?")
      .get(goalId) as GoalRow | undefined;
    if (!row) {
      throw new GoalError("GOAL_NOT_FOUND", `goal ${goalId} not found`);
    }
    return row;
  }

  private requireOwnership(row: GoalRow, owner: string): void {
    if (row.owner !== owner) {
      throw new GoalError(
        "GOAL_FORBIDDEN",
        `caller ${owner} does not own goal ${row.id}`,
      );
    }
  }

  private requireStatus(
    row: GoalRow,
    statuses: readonly GoalStatus[],
  ): GoalRow {
    if (!statuses.includes(row.status)) {
      throw new GoalError(
        "GOAL_INVALID_TRANSITION",
        `goal ${row.id} is ${row.status}, expected ${statuses.join(" or ")}`,
      );
    }
    return row;
  }

  // --------------------------------------------------------------- goals

  /**
   * Owner-scoped get-or-create by idempotency key — the
   * `credentials/idempotency.ts` `getOrCreateTask` pattern. The client mints
   * one key per send and reuses it across retries, so a repeat MUST return
   * the SAME row (`g_${randomUUID()}` is only minted for a real create; the
   * `g_` prefix is the WIRE_SPEC `goalId` shape). The v9
   * `UNIQUE (owner, idempotency_key)` means a concurrent writer can win the
   * INSERT race: the UNIQUE violation (classified narrowly via
   * `sqlite_errors.isUniqueConstraintViolation`) is caught and the existing
   * row re-read instead of 500ing — any other constraint abort surfaces.
   */
  getOrCreateGoal(input: GetOrCreateGoalInput): GoalRow {
    const existing = this.db
      .prepare("SELECT * FROM goal WHERE owner = ? AND idempotency_key = ?")
      .get(input.owner, input.idempotencyKey) as GoalRow | undefined;
    if (existing) return existing;

    const id = `g_${randomUUID()}`;
    const ts = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO goal
             (id, owner, instruction, status, pause_reason, pause_question,
              result_summary, failure_reason, todos, authorised_tools,
              token_budget, tokens_spent, agent_snapshot, pinned_model,
              run_started_ts, lease_owner, lease_token, lease_expiry,
              created_ts, updated_ts, idempotency_key)
           VALUES
             (@id, @owner, @instruction, 'queued', NULL, NULL, NULL, NULL,
              @todos, @authorisedTools, @tokenBudget, 0, @agentSnapshot,
              @pinnedModel, NULL, NULL, NULL, NULL, @ts, @ts, @idempotencyKey)`,
        )
        .run({
          id,
          owner: input.owner,
          instruction: input.instruction,
          todos:
            input.todos === undefined ? null : JSON.stringify(input.todos),
          authorisedTools:
            input.authorisedTools === undefined
              ? null
              : JSON.stringify(input.authorisedTools),
          tokenBudget: input.tokenBudget,
          agentSnapshot: input.agentSnapshot ?? null,
          pinnedModel: input.pinnedModel ?? null,
          ts,
          idempotencyKey: input.idempotencyKey,
        });
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        const raced = this.db
          .prepare("SELECT * FROM goal WHERE owner = ? AND idempotency_key = ?")
          .get(input.owner, input.idempotencyKey) as GoalRow | undefined;
        if (raced) return raced;
        throw new GoalError(
          "GOAL_NOT_FOUND",
          `goal for owner ${input.owner}, idempotency key ` +
            `${input.idempotencyKey} vanished after unique-constraint race`,
        );
      }
      throw e;
    }
    return this.requireGoal(id);
  }

  /**
   * Claims a queued goal: mints a fresh lease token and moves the goal to
   * `running` in ONE guarded CAS. The CAS re-checks
   * `owner + status='queued'` in its WHERE clause, so a concurrent claim
   * cannot both win — the loser sees `changes === 0` and raises
   * `GOAL_INVALID_TRANSITION` naming the transition. `run_started_ts` is
   * deliberately NOT touched (M3 owns it; M2 anchors its clock at admission).
   * The returned row (with `lease_token`) is what the Phase 3 runner holds
   * and must present on `renewGoalLease` / `pauseGoal`.
   */
  claimGoal(goalId: string, owner: string): GoalRow {
    const goal = this.requireGoal(goalId);
    this.requireOwnership(goal, owner);
    this.requireStatus(goal, ["queued"]);
    const now = this.now();
    const token = randomUUID();
    const result = this.db
      .prepare(
        `UPDATE goal
         SET status = 'running', lease_owner = @owner, lease_token = @token,
             lease_expiry = @expiry, updated_ts = @now
         WHERE id = @id AND owner = @owner AND status = 'queued'`,
      )
      .run({ id: goalId, owner, token, expiry: now + GOAL_STEP_LEASE_MS, now });
    if (result.changes === 0) {
      throw new GoalError(
        "GOAL_INVALID_TRANSITION",
        `goal ${goalId} could not transition queued -> running`,
      );
    }
    return this.requireGoal(goalId);
  }

  /**
   * CAS status transition away from `running` (pause/complete/fail/cancel),
   * clearing the lease when [PauseGoalParams.next] is `paused`. Called by the
   * Phase 3 control tools and the goal fence.
   *
   * [next] is restricted to [GoalTransitionTarget] at the type level AND by a
   * runtime guard: `running -> queued` re-chaining and cancel own their own
   * CAS in Phase 3 and must not be expressed through this accessor.
   *
   * Deliberately NOT wrapped in a transaction: the single-statement UPDATE is
   * atomic on its own, and the control tools must compose it with their
   * message-log append inside ONE `db.transaction` (better-sqlite3 nests
   * transaction functions via SAVEPOINT, but the accessor still keeps its
   * write to a single statement so composition stays trivial). A successful
   * `pauseGoal` clears `lease_owner`/`lease_token`/`lease_expiry` (the
   * paused goal holds no step lease); other transitions keep the columns
   * verbatim per the plan's CAS.
   *
   * Lease proof is all-or-nothing: [PauseGoalParams.leaseOwner] and
   * [PauseGoalParams.leaseToken] must be supplied TOGETHER, each adding its
   * own CAS clause (a superseded runner cannot pause a goal it no longer
   * owns); when both are omitted the CAS omits the lease match entirely.
   * A half-fence is rejected outright: `claimGoal` stamps `lease_owner :=
   * owner`, so an owner-only clause is tautological and would silently pass
   * for any runner of the same owner.
   */
  pauseGoal(
    goalId: string,
    owner: string,
    params: PauseGoalParams,
  ): boolean {
    this.requireOwnership(this.requireGoal(goalId), owner);
    const next: string = params.next;
    if (!(GOAL_TRANSITION_TARGETS as readonly string[]).includes(next)) {
      throw new GoalError(
        "GOAL_INVALID_TRANSITION",
        `goal ${goalId} cannot transition running -> ${next} via pauseGoal`,
      );
    }
    const hasLeaseOwner = params.leaseOwner !== undefined;
    const hasLeaseToken = params.leaseToken !== undefined;
    if (hasLeaseOwner !== hasLeaseToken) {
      throw new GoalError(
        "GOAL_INVALID_TRANSITION",
        "leaseOwner and leaseToken must be supplied together",
      );
    }
    const now = params.nowOverride ?? this.now();
    const bind: Record<string, unknown> = {
      id: goalId,
      owner,
      next: params.next,
      reason: params.reason ?? null,
      question: params.question ?? null,
      summary: params.summary ?? null,
      now,
    };
    // Lease proof (all-or-nothing, validated above): both halves add their
    // own WHERE clause; when both are omitted the CAS omits the lease match
    // entirely.
    let leaseClauses = "";
    if (params.leaseOwner !== undefined) {
      leaseClauses += " AND lease_owner = @leaseOwner";
      bind.leaseOwner = params.leaseOwner;
    }
    if (params.leaseToken !== undefined) {
      leaseClauses += " AND lease_token = @leaseToken";
      bind.leaseToken = params.leaseToken;
    }
    const result = this.db
      .prepare(
        `UPDATE goal
         SET status = @next, pause_reason = @reason,
             pause_question = @question, result_summary = @summary,
             lease_owner = CASE WHEN @next = 'paused' THEN NULL ELSE lease_owner END,
             lease_token = CASE WHEN @next = 'paused' THEN NULL ELSE lease_token END,
             lease_expiry = CASE WHEN @next = 'paused' THEN NULL ELSE lease_expiry END,
             updated_ts = @now
         WHERE id = @id AND owner = @owner AND status = 'running'${leaseClauses}`,
      )
      .run(bind);
    if (result.changes === 0) {
      const current = this.db
        .prepare("SELECT * FROM goal WHERE id = ?")
        .get(goalId) as GoalRow | undefined;
      if (!current) {
        throw new GoalError("GOAL_NOT_FOUND", `goal ${goalId} not found`);
      }
      if (current.status === "running") {
        throw new GoalError(
          "GOAL_LEASE_CONFLICT",
          `goal ${goalId} pause rejected: lease token mismatch for owner ${owner}`,
        );
      }
      throw new GoalError(
        "GOAL_INVALID_TRANSITION",
        `goal ${goalId} could not transition running -> ${params.next}` +
          ` (currently ${current.status})`,
      );
    }
    return true;
  }

  /**
   * Extends a held step lease by one `GOAL_STEP_LEASE_MS` window — expiry
   * ONLY, the token is never rotated (the plan test: "renewal extends expiry
   * without rotating the token"). The runner renews before each model call,
   * so the lease bounds exactly one round. `changes === 0` raises
   * `GOAL_LEASE_CONFLICT`.
   *
   * No post-UPDATE token re-check: the CAS WHERE clause already pins
   * `lease_token`, so on a synchronous single connection a re-read here is
   * unreachable — and if it ever fired it would throw AFTER the renewal had
   * committed. The no-rotation requirement is covered by the 2.5 test
   * asserting the token is unchanged across a renewal (pre/post via an
   * external read).
   */
  renewGoalLease(
    goalId: string,
    owner: string,
    leaseOwner: string,
    leaseToken: string,
  ): void {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE goal
         SET lease_expiry = @expiry, updated_ts = @now
         WHERE id = @id AND owner = @owner AND status = 'running'
           AND lease_owner = @leaseOwner AND lease_token = @leaseToken`,
      )
      .run({
        id: goalId,
        owner,
        expiry: now + GOAL_STEP_LEASE_MS,
        now,
        leaseOwner,
        leaseToken,
      });
    if (result.changes === 0) {
      throw new GoalError(
        "GOAL_LEASE_CONFLICT",
        `goal ${goalId} lease renewal rejected: token/lease mismatch`,
      );
    }
  }

  // ------------------------------------------------------------- messages

  /**
   * Appends one message to the goal's log and compacts the log in ONE
   * transaction (composable insert+compact: a failure rolls both back).
   * `seq` is taken from the last row (+1, else 1) — the `appendStep`
   * idiom — so compaction gaps never collide (`UNIQUE (goal_id, seq)`).
   * Consumed by the Phase 3 control tools (message-log append alongside
   * `pauseGoal`) and the runner.
   */
  appendGoalMessage(
    goalId: string,
    owner: string,
    input: AppendGoalMessageInput,
  ): GoalMessageRow {
    this.requireOwnership(this.requireGoal(goalId), owner);
    const append = this.db.transaction((): GoalMessageRow => {
      const last = this.db
        .prepare(
          "SELECT seq FROM goal_message WHERE goal_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(goalId) as { seq: number } | undefined;
      const seq = last ? last.seq + 1 : 1;
      const row: GoalMessageRow = {
        id: randomUUID(),
        goal_id: goalId,
        seq,
        role: input.role,
        content_json: JSON.stringify(input.content ?? {}),
        tool_calls_json:
          input.toolCalls === undefined ? null : JSON.stringify(input.toolCalls),
        tool_call_id: input.toolCallId ?? null,
        created_ts: this.now(),
      };
      this.db
        .prepare(
          `INSERT INTO goal_message
             (id, goal_id, seq, role, content_json, tool_calls_json,
              tool_call_id, created_ts)
           VALUES
             (@id, @goalId, @seq, @role, @contentJson, @toolCallsJson,
              @toolCallId, @createdTs)`,
        )
        .run({
          id: row.id,
          goalId: row.goal_id,
          seq: row.seq,
          role: row.role,
          contentJson: row.content_json,
          toolCallsJson: row.tool_calls_json,
          toolCallId: row.tool_call_id,
          createdTs: row.created_ts,
        });
      this.truncate(goalId);
      return row;
    });
    return append();
  }

  /**
   * Message-log compaction (plan §Storage). Runs inside the append
   * transaction above and is also usable standalone (it owns a transaction,
   * so the trigger dance below is always rolled back with its deletes).
   *
   * No-op while the log holds <= `GOAL_MESSAGE_MAX` rows. Past the cap the
   * walk deletes FROM THE OLDEST while the remaining count would still be
   * `>= GOAL_MESSAGE_KEEP_RECENT`, under three rules:
   *   1. complete assistant->tool groups (head + its trailing tool rows) are
   *      deleted first and atomically, oldest-first — a group is never split;
   *   2. standalone `user`/`assistant` rows are deleted only in that walk
   *      when the group rule does not apply to them AND the floor permits;
   *   3. a `tool` row is deleted only with its group — a lone ToolMessage
   *      (no assistant head directly before it) is never deleted, so no tool
   *      row is ever orphaned from its assistant message.
   *
   * Rules 3 and the two invariants below are CROSS-PASS: they hold on every
   * call and across the append+truncate transaction, not just within one
   * walk's candidate list:
   *   A. the newest row (max `seq`) is NEVER a deletion candidate — not even
   *      as part of a group (a group containing it is skipped whole), so the
   *      `GoalMessageRow` `appendGoalMessage` just returned is always
   *      persisted ("the question survives", plan §Control tools);
   *   B. an assistant row whose `tool_calls_json IS NOT NULL` and whose next
   *      row (if any) is not a tool is an IN-PROGRESS group head — the
   *      runner appends the assistant BEFORE its tool responses exist — and
   *      is never deleted (symmetric with rule 3: skip it, never crash).
   *      Deleting it would orphan the tool rows appended by the NEXT call,
   *      which rule 3 then protects forever and the log ratchets above
   *      `GOAL_MESSAGE_MAX` while Phase 3's input-vector rebuild feeds a
   *      parentless ToolMessage to the model provider.
   *
   * If the walk is blocked (groups are indivisible, or everything left is
   * protected) and the count still exceeds `GOAL_MESSAGE_MAX`, the overage is
   * accepted: the newest rows are kept and nothing is deleted mid-group.
   *
   * The v9 `goal_message_append_only_delete` trigger would abort the
   * compaction deletes, so — following `Ledger.purgeTerminalTasks` exactly —
   * the guard is dropped, the rows deleted, and the guard recreated (from the
   * shared `goals/migrate.ts` DDL constant) inside the surrounding
   * transaction. Returns the surviving rows (re-read after the walk) as the
   * deterministic assertion surface.
   */
  private truncate(goalId: string): GoalMessageRow[] {
    return this.db.transaction(() => this.truncateRows(goalId))();
  }

  private truncateRows(goalId: string): GoalMessageRow[] {
    const readAll = (): GoalMessageRow[] =>
      this.db
        .prepare(
          `SELECT id, goal_id, seq, role, content_json, tool_calls_json,
                  tool_call_id, created_ts
           FROM goal_message WHERE goal_id = ? ORDER BY seq ASC`,
        )
        .all(goalId) as GoalMessageRow[];

    const rows = readAll();
    if (rows.length <= GOAL_MESSAGE_MAX) return rows;

    // Invariant A: rows are ordered by seq ASC, so the last row IS the max-seq
    // row. It is excluded from every candidate list below — and any group
    // containing it is skipped whole (a group is never split, and its head
    // must survive alongside the newest row).
    const newestId = rows[rows.length - 1]!.id;

    // Parse the log into deletion units: a "group head" is an assistant row
    // whose immediately-following row is a tool row; the unit is the head
    // plus its contiguous trailing tool rows. Everything else is standalone.
    // Two shapes are never deletable (cross-pass invariants): a standalone
    // tool row (rule 3) and an in-progress group head (invariant B — an
    // assistant with tool_calls whose tool rows are not appended yet).
    const groups: GoalMessageRow[][] = [];
    const singles: GoalMessageRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.role === "assistant" && rows[i + 1]?.role === "tool") {
        const group = [row];
        while (rows[i + 1]?.role === "tool") {
          i++;
          group.push(rows[i]!);
        }
        if (!group.some((r) => r.id === newestId)) groups.push(group);
      } else if (row.role === "tool") {
        continue; // lone tool: never deletable, never orphaned
      } else if (
        row.role === "assistant" &&
        row.tool_calls_json !== null &&
        rows[i + 1]?.role !== "tool"
      ) {
        continue; // in-progress group head: its tool rows are not appended yet
      } else if (row.id !== newestId) {
        singles.push(row);
      }
    }

    // Rule 1: complete groups first, oldest-first; rule 2: standalone
    // user/assistant rows after, oldest-first. Each deletion must leave
    // >= GOAL_MESSAGE_KEEP_RECENT rows; the walk stops at the first unit
    // that would break the floor (groups are indivisible).
    const deleteIds: string[] = [];
    let remaining = rows.length;
    for (const group of groups) {
      if (remaining - group.length < GOAL_MESSAGE_KEEP_RECENT) break;
      for (const row of group) deleteIds.push(row.id);
      remaining -= group.length;
    }
    for (const row of singles) {
      if (remaining - 1 < GOAL_MESSAGE_KEEP_RECENT) break;
      deleteIds.push(row.id);
      remaining -= 1;
    }

    if (deleteIds.length > 0) {
      this.db.exec("DROP TRIGGER IF EXISTS goal_message_append_only_delete");
      const del = this.db.prepare("DELETE FROM goal_message WHERE id = ?");
      for (const id of deleteIds) del.run(id);
      this.db.exec(GOAL_MESSAGE_DELETE_TRIGGER_SQL);
    }
    return readAll();
  }

  // ------------------------------------------------------------- queries

  /**
   * Coarse side-effect summary derived from `goal_mutation` (plan §Effect
   * state): any `pending`/`unresolved` mutation means the goal's effects are
   * `"unknown"`; else any `applied` mutation means at least
   * `"completed_steps_only"`; else `"none_known"`. Consumed by the Phase 3
   * control tools (pause/complete gating) before M6 records mutations.
   *
   * Contract (the invariant this summary rests on): `retryable` is written
   * ONLY for a step that NEVER ran — no egress attempt was made. Any
   * AMBIGUOUS egress (the request may have reached the provider) is recorded
   * `unresolved`, which maps to `unknown` above. If that ever breaks — a
   * ran-but-recorded-`retryable` mutation — `none_known` becomes a false
   * all-clear and the caller would report "no side effects" for a goal whose
   * tools actually fired.
   */
  effectState(goalId: string): GoalEffectState {
    const states = this.db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .all(goalId) as { state: string }[];
    if (states.some((s) => s.state === "pending" || s.state === "unresolved")) {
      return "unknown";
    }
    if (states.some((s) => s.state === "applied")) {
      return "completed_steps_only";
    }
    return "none_known";
  }

  /**
   * Live goal count for [owner] (`queued`/`running`). The
   * `GOAL_MAX_CONCURRENT_PER_OWNER` cap itself is enforced at route
   * admission (Phase 3.6) against this count — this accessor + the constant
   * are what Phase 2.3 delivers now.
   */
  countActiveGoals(owner: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM goal
         WHERE owner = ? AND status IN ('queued', 'running')`,
      )
      .get(owner) as { c: number };
    return row.c;
  }
}
