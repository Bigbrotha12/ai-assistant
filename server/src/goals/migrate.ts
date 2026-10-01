import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Ledger migration v9 — the goal-loop tables (Phase 2.1, plan §Storage).
 *
 * This module owns the goal-domain DDL; `ledger.ts` wires `migrateGoals` into
 * its `LEDGER_MIGRATIONS` list so there is exactly ONE `PRAGMA user_version`
 * owner per database. Do NOT import from `../ledger.ts` here (import cycle).
 *
 * `goal_mutation` / `goal_refusal` stay empty until Phase 6, but are real,
 * checkable tables (Phase 2.5 inserts rows directly to test `effectState`).
 *
 * `REFERENCES` are declarative only: foreign keys are OFF by default in this
 * codebase and no pragma turns them on. Purge deletes children explicitly.
 */

/**
 * Append-only trigger DDL (goal messages and refusals are write-once).
 * Exported because THREE sites create them: `migrateGoals` below, the
 * account-purge recreate in `ledger.ts`, and the compaction recreate in
 * `goals/ledger.ts` — one definition, so a later drop/recreate can never
 * drift from the migration.
 */
export const GOAL_MESSAGE_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER goal_message_append_only_update
  BEFORE UPDATE ON goal_message
  BEGIN SELECT RAISE(ABORT, 'goal_message is append-only'); END;
`;

export const GOAL_MESSAGE_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER goal_message_append_only_delete
  BEFORE DELETE ON goal_message
  BEGIN SELECT RAISE(ABORT, 'goal_message is append-only'); END;
`;

export const GOAL_REFUSAL_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER goal_refusal_append_only_update
  BEFORE UPDATE ON goal_refusal
  BEGIN SELECT RAISE(ABORT, 'goal_refusal is append-only'); END;
`;

export const GOAL_REFUSAL_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER goal_refusal_append_only_delete
  BEFORE DELETE ON goal_refusal
  BEGIN SELECT RAISE(ABORT, 'goal_refusal is append-only'); END;
`;

export function migrateGoals(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE goal (
      id               TEXT PRIMARY KEY,
      owner            TEXT NOT NULL,
      instruction      TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (
        status IN ('queued','running','paused','complete','failed','cancelled')
      ),
      pause_reason     TEXT,
      pause_question   TEXT,
      result_summary   TEXT,
      failure_reason   TEXT,
      todos            TEXT,
      authorised_tools TEXT,
      token_budget     INTEGER NOT NULL,
      tokens_spent     INTEGER NOT NULL DEFAULT 0,
      agent_snapshot   TEXT,
      pinned_model     TEXT,
      run_started_ts   INTEGER,
      lease_owner      TEXT,
      lease_token      TEXT,
      lease_expiry     INTEGER,
      created_ts       INTEGER NOT NULL,
      updated_ts       INTEGER NOT NULL,
      idempotency_key  TEXT NOT NULL,
      UNIQUE (owner, idempotency_key)
    );

    CREATE TABLE goal_step (
      id               TEXT PRIMARY KEY,
      goal_id          TEXT NOT NULL REFERENCES goal(id),
      seq              INTEGER NOT NULL,
      kind             TEXT NOT NULL,
      status           TEXT NOT NULL,
      mutating         INTEGER NOT NULL DEFAULT 0,
      message_from_seq INTEGER,
      message_to_seq   INTEGER,
      tokens           INTEGER NOT NULL DEFAULT 0,
      created_ts       INTEGER NOT NULL,
      UNIQUE (goal_id, seq)
    );

    CREATE TABLE goal_message (
      id              TEXT PRIMARY KEY,
      goal_id         TEXT NOT NULL REFERENCES goal(id),
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content_json    TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_call_id    TEXT,
      created_ts      INTEGER NOT NULL,
      UNIQUE (goal_id, seq)
    );

    CREATE TABLE goal_mutation (
      id         TEXT PRIMARY KEY,
      goal_id    TEXT NOT NULL REFERENCES goal(id),
      plugin_id  TEXT NOT NULL,
      tool       TEXT NOT NULL,
      args_hash  TEXT NOT NULL,
      state      TEXT NOT NULL CHECK (
        state IN ('pending','applied','retryable','unresolved')
      ),
      step_seq   INTEGER,
      created_ts INTEGER NOT NULL,
      UNIQUE (goal_id, plugin_id, tool, args_hash)
    );

    CREATE TABLE goal_refusal (
      id           TEXT PRIMARY KEY,
      goal_id      TEXT NOT NULL REFERENCES goal(id),
      step_seq     INTEGER NOT NULL,
      tool_call_id TEXT,
      tool         TEXT NOT NULL,
      args_json    TEXT,
      reason       TEXT NOT NULL CHECK (
        reason IN ('unauthorized','duplicate_mutation','unresolved_mutation')
      ),
      created_ts   INTEGER NOT NULL
    );

    -- Append-only enforcement: goal messages and refusals are write-once.
    -- Mirrors the ledger_step / ledger_chain trigger idiom.
    ${GOAL_MESSAGE_UPDATE_TRIGGER_SQL}
    ${GOAL_MESSAGE_DELETE_TRIGGER_SQL}
    ${GOAL_REFUSAL_UPDATE_TRIGGER_SQL}
    ${GOAL_REFUSAL_DELETE_TRIGGER_SQL}
  `);
}
