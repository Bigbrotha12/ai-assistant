import { chmodSync } from "node:fs";
import type { Database as DatabaseType } from "better-sqlite3";

/** A single schema step. Migration list index 0 == schema version 1. */
export type Migration = (db: DatabaseType) => void;

/**
 * Bounded wait (ms) a ledger connection tolerates on a locked database before
 * SQLite raises `SQLITE_BUSY`. WAL lets readers proceed while the one writer
 * holds its transaction, so this only covers the brief hand-off window; the
 * bound keeps a contended write (e.g. the server racing the migration CLI)
 * from blocking a request indefinitely.
 */
export const LEDGER_BUSY_TIMEOUT_MS = 5_000;

/**
 * Applies the shared concurrency posture to a ledger connection: WAL journal
 * mode and a bounded `busy_timeout`. WAL is unavailable for in-memory
 * databases (SQLite keeps `memory`), but the busy timeout still applies.
 * Deliberately does NOT touch `user_version`; migrate separately with
 * {@link migrateLedger}.
 */
export function configureLedgerConnection(
  db: DatabaseType,
  busyTimeoutMs: number = LEDGER_BUSY_TIMEOUT_MS,
): void {
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
}

/**
 * Hardens a ledger SQLite file and its WAL/SHM sidecars to owner-only
 * (`0600`). SQLite creates all three under the process umask (typically
 * `0644`), and the sidecars are (re)created on open and first access, so this
 * must run after every open/migrate — including over a pre-existing `./data`
 * whose mode `mkdir` never set. Sidecars absent for a cleanly closed or
 * never-accessed database are ignored.
 */
export function hardenLedgerFiles(dbPath: string): void {
  chmodSync(dbPath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${dbPath}${suffix}`, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Append-only enforcement on `ledger_step`/`ledger_chain`: both tables are
 * write-once, so UPDATE and DELETE abort. The two DELETE guards are dropped and
 * recreated around the retention/owner purges (which must delete child rows),
 * so their DDL lives here as the single source of truth shared by the v1
 * migration and the purge helpers below.
 */
export const LEDGER_STEP_APPEND_ONLY_UPDATE_SQL = `
  CREATE TRIGGER ledger_step_append_only_update
  BEFORE UPDATE ON ledger_step
  BEGIN SELECT RAISE(ABORT, 'ledger_step is append-only'); END;
`;

export const LEDGER_STEP_APPEND_ONLY_DELETE_SQL = `
  CREATE TRIGGER ledger_step_append_only_delete
  BEFORE DELETE ON ledger_step
  BEGIN SELECT RAISE(ABORT, 'ledger_step is append-only'); END;
`;

export const LEDGER_CHAIN_APPEND_ONLY_UPDATE_SQL = `
  CREATE TRIGGER ledger_chain_append_only_update
  BEFORE UPDATE ON ledger_chain
  BEGIN SELECT RAISE(ABORT, 'ledger_chain is append-only'); END;
`;

export const LEDGER_CHAIN_APPEND_ONLY_DELETE_SQL = `
  CREATE TRIGGER ledger_chain_append_only_delete
  BEFORE DELETE ON ledger_chain
  BEGIN SELECT RAISE(ABORT, 'ledger_chain is append-only'); END;
`;

/**
 * Drops the two DELETE guards so a purge can delete `ledger_step`/
 * `ledger_chain` child rows, then {@link createAppendOnlyDeleteTriggers}
 * restores them (call inside the same transaction).
 */
export function dropAppendOnlyDeleteTriggers(db: DatabaseType): void {
  db.exec("DROP TRIGGER IF EXISTS ledger_step_append_only_delete");
  db.exec("DROP TRIGGER IF EXISTS ledger_chain_append_only_delete");
}

/** (Re)creates the two DELETE guards. See {@link dropAppendOnlyDeleteTriggers}. */
export function createAppendOnlyDeleteTriggers(db: DatabaseType): void {
  db.exec(LEDGER_STEP_APPEND_ONLY_DELETE_SQL);
  db.exec(LEDGER_CHAIN_APPEND_ONLY_DELETE_SQL);
}

export const LEDGER_MIGRATIONS: readonly Migration[] = [
  // v1 — initial ledger schema.
  // intentKey is stored raw; the unique (owner, intent_key) constraint is added
  // by a later migration, so do NOT add one here.
  (db) => {
    db.exec(`
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

      -- Append-only enforcement: steps and chain records are write-once.
      ${LEDGER_STEP_APPEND_ONLY_UPDATE_SQL}
      ${LEDGER_STEP_APPEND_ONLY_DELETE_SQL}
      ${LEDGER_CHAIN_APPEND_ONLY_UPDATE_SQL}
      ${LEDGER_CHAIN_APPEND_ONLY_DELETE_SQL}
    `);
  },
  // v2 — heartbeat-based stuck detection.
  // Adds `last_heartbeat_ts`, which `claimTask`/`resumeTask`/`heartbeat` stamp
  // (the gateway clock) and `markStuckIfHeartbeatStale` keys off of. Stuck
  // detection keys off this rather than `updated_ts`, which `appendStep` also
  // bumps and would therefore mask a dead worker that only appends steps.
  // Data-preserving.
  (db) => {
    db.exec(`
      ALTER TABLE ledger_task
        ADD COLUMN last_heartbeat_ts INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // v3 — monotonic fence token.
  // Adds `fence_token`, rotated by every `claimTask`/`resumeTask`. Workers hold
  // the token granted at claim/resume and present it on `heartbeat`/
  // `appendStep`; a superseded worker (whose task was resumed under a new
  // fence) is rejected with `FENCE_CONFLICT`, killing duplicate-execution races
  // between overlapping workers. Data-preserving (existing rows default to `''`
  // = no fence held; calls that pass no token skip the check).
  (db) => {
    db.exec(`
      ALTER TABLE ledger_task
        ADD COLUMN fence_token TEXT NOT NULL DEFAULT '';
    `);
  },
  // v4 — idempotency.
  //
  // (a) Unique (owner, intent_key): a client's idempotency key (messageId)
  // maps to EXACTLY ONE task, forever, under one owner. This is the
  // owner-scoped uniqueness that makes get-or-create-by-key race-safe; the
  // get-or-create catches the SQLITE_CONSTRAINT violation and re-reads the
  // existing row instead of erroring (no raw-INSERT 500 on a repeat). An
  // UNCONDITIONAL index (no partial WHERE) is deliberate: a terminal task's
  // intentKey is never re-sent as a new message (the client generates messageId
  // once per send), so a partial index would only introduce "which row wins"
  // ambiguity when a terminal and a fresh task share a key.
  //
  // A database written through the raw-insert path can already hold duplicate
  // (owner, intent_key) rows; creating the UNIQUE index over them would abort
  // the whole migration at import. So BEFORE the index, delete the older
  // duplicates, keeping the NEWEST row per group (newest by updated_ts, id as
  // the deterministic tie-breaker) — the same "newest wins" rule the
  // get-or-create re-read applies. (Orphaned steps/chain rows of the deleted
  // duplicates remain — they are never surfaced because reads are keyed by
  // task_id, and ledger_step's append-only trigger forbids cleanup.)
  //
  // (b) Replay dedupe: `ledger_step` gains a nullable `tool_call_id` (an
  // OpenAI-style tool call id) recorded atomically with the tool's result, so
  // a resumed checkpoint can look it up and NEVER re-execute a tool whose
  // result was already stored. Partial unique index (only tool steps carry a
  // tool_call_id) makes `hasToolResult` an indexed point lookup, not a scan,
  // and makes a duplicate record a SQLITE_CONSTRAINT that `recordToolResult`
  // catches (idempotent record). The column is intentionally NOT part of the
  // hash-chain content (`canonicalStepContent`): adding it would change the
  // digest computation and invalidate existing chains. Data-preserving
  // (existing steps get NULL tool_call_id).
  (db) => {
    db.exec(`
      DELETE FROM ledger_task AS older
      WHERE EXISTS (
        SELECT 1 FROM ledger_task AS newer
        WHERE newer.owner = older.owner
          AND newer.intent_key = older.intent_key
          AND (newer.updated_ts > older.updated_ts
               OR (newer.updated_ts = older.updated_ts AND newer.id > older.id))
      );

      CREATE UNIQUE INDEX idx_ledger_task_owner_intent
        ON ledger_task(owner, intent_key);

      ALTER TABLE ledger_step ADD COLUMN tool_call_id TEXT;
      CREATE UNIQUE INDEX idx_ledger_step_tool_call
        ON ledger_step(task_id, tool_call_id)
        WHERE tool_call_id IS NOT NULL;
    `);
  },
  // v5 — job snapshot payload.
  // `ledger_task.payload` stores the JSON-encoded snapshot messages a job runs
  // on. The JobRunner writes it at admission and `resumeStuckJobs` reads it to
  // re-run a stuck task from the stored snapshot. It is transient user content:
  // purged WITH the task by the retention sweep (no separate purge), and never
  // exposed on the ledger routes. Data-preserving (existing rows get NULL
  // payload).
  (db) => {
    db.exec(`
      ALTER TABLE ledger_task ADD COLUMN payload TEXT;
    `);
  },
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
        ON ledger_task(status, updated_ts);
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE ledger_task ADD COLUMN job_spec TEXT;
    `);
  },
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ledger_task_metadata_window
        ON ledger_task(worker, owner, status, spec, created_ts DESC, id DESC);
    `);
  },
];

export const CURRENT_LEDGER_VERSION = LEDGER_MIGRATIONS.length;

/** Applies `migrations` to bring `db` up to `targetVersion` (idempotent). */
export function applyMigrations(
  db: DatabaseType,
  migrations: readonly Migration[],
  targetVersion: number,
): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current + 1; v <= targetVersion; v++) {
    const migration = migrations[v - 1];
    if (!migration) {
      throw new Error(
        `no migration registered for ledger schema version ${v}`,
      );
    }
    migration(db);
    db.pragma(`user_version = ${v}`);
  }
}

/** Migrates the ledger database to the current schema version (idempotent). */
export function migrateLedger(db: DatabaseType): void {
  applyMigrations(db, LEDGER_MIGRATIONS, CURRENT_LEDGER_VERSION);
}
