import { createHash, randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";

export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stuck",
  "awaiting_review",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Threshold ordering is FIXED and stated here: stuck-timeout must be strictly
 * shorter than lease-expiry so the watchdog never marks a task `stuck` and
 * then deadlocks waiting for the lease to lapse before it can relaunch the
 * worker. Final tuning of these values is Phase 4 (M5); these are
 * conservative dev defaults.
 */
export const DEFAULT_STUCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LEASE_EXPIRY_MS = 60_000;

export const LEDGER_GENESIS_PREFIX = "ledger-genesis:";

export type LedgerConfig = {
  stuckTimeoutMs?: number;
  leaseExpiryMs?: number;
  /** Gateway clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** Timer factory for `startHeartbeat`. Injectable for tests; defaults to the
   *  real global timers. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type TaskRow = {
  id: string;
  owner: string;
  intent_key: string;
  spec: string;
  worker: string | null;
  status: TaskStatus;
  created_ts: number;
  updated_ts: number;
  /** Gateway-stamped time the worker last sent a heartbeat (or claimed/
   *  resumed the task). Stuck detection keys off this, NOT `updated_ts`. */
  last_heartbeat_ts: number;
  lease_expires_at: number | null;
  lease_owner: string | null;
  /** Monotonic fence token: rotated by every `claimTask`/`resumeTask` and
   *  required (when supplied) by `heartbeat`/`appendStep`, so a superseded
   *  worker's writes/heartbeats are rejected with `FENCE_CONFLICT`. The empty
   *  string means "no fence held" (pre-v3 rows, or a call with no token). */
  fence_token: string;
};

export type StepRow = {
  id: string;
  task_id: string;
  seq: number;
  stage: string;
  action: string;
  result: string | null;
  ts: number;
  /** Tool-call id (v4) for replay dedupe; null for non-tool steps. */
  tool_call_id: string | null;
};

export type ChainRow = {
  seq: number;
  task_id: string;
  step_id: string;
  digest: string;
  prev_digest: string | null;
  ts: number;
};

export type LedgerErrorCode =
  | "TASK_NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "LEASE_CONFLICT"
  | "FENCE_CONFLICT"
  | "INVALID_CONFIG"
  | "APPEND_ONLY_VIOLATION";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "stuck", "awaiting_review"],
  succeeded: [],
  failed: [],
  cancelled: [],
  stuck: ["running"],
  awaiting_review: ["running", "failed", "succeeded"],
};

export function assertTransition(
  from: TaskStatus,
  to: TaskStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new LedgerError(
      "INVALID_TRANSITION",
      `invalid status transition ${from} -> ${to}`,
    );
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function genesisDigest(taskId: string): string {
  return sha256Hex(`${LEDGER_GENESIS_PREFIX}${taskId}`);
}

function canonicalStepContent(step: {
  seq: number;
  stage: string;
  action: string;
  result: string | null;
}): string {
  return `${step.seq}|${step.stage}|${step.action}|${String(step.result ?? "")}`;
}

/**
 * Detects a repeated action *sequence* in the given action list. A "loop" is a
 * block of length >= 2 appearing as two identical adjacent blocks. Single
 * adjacent repeats (A,A; A,B,B) are NOT detected because they need at least
 * two full repeats of a length-2-or-more pattern. Returns the repeating block,
 * or null if no loop is present.
 */
export function findLoop(actions: readonly string[]): readonly string[] | null {
  const n = actions.length;
  for (let start = 0; start < n; start++) {
    const maxLen = Math.floor((n - start) / 2);
    for (let p = 2; p <= maxLen; p++) {
      let matches = true;
      for (let i = 0; i < p; i++) {
        if (actions[start + i] !== actions[start + p + i]) {
          matches = false;
          break;
        }
      }
      if (matches) return actions.slice(start, start + p);
    }
  }
  return null;
}

/** Migration list index 0 == schema version 1. */
type Migration = (db: DatabaseType) => void;

const LEDGER_MIGRATIONS: readonly Migration[] = [
  // v1 — initial ledger schema.
  // intentKey is stored raw. Canonical form semantics + unique constraint are
  // finalized in Phase 6 (M12); do NOT add a unique constraint here yet.
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
  },
  // v2 — heartbeat-based stuck detection.
  // Adds `last_heartbeat_ts`, which `claimTask`/`resumeTask`/`heartbeat` stamp
  // (the gateway clock) and `markStuckIfHeartbeatStale` keys off of. This
  // decouples stuck detection from `updated_ts` (which `appendStep` also bumps,
  // so step-append-only workers were never marked stuck). Data-preserving.
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
  // fence) is rejected with `FENCE_CONFLICT`, so it can no longer extend a
  // lease or append steps — killing duplicate-execution races between
  // overlapping workers. Data-preserving (existing rows default to `''` = no
  // fence held; calls that pass no token skip the check, so old callers keep
  // working).
  (db) => {
    db.exec(`
      ALTER TABLE ledger_task
        ADD COLUMN fence_token TEXT NOT NULL DEFAULT '';
    `);
  },
  // v4 — idempotency (Phase 2 Wave B).
  //
  // (a) Unique (owner, intent_key): a client's idempotency key (messageId)
  // maps to EXACTLY ONE task, forever, under one owner. This is the
  // owner-scoped uniqueness that makes get-or-create-by-key race-safe. The v1
  // comment deferred this constraint to Phase 6 (M12); Wave B's idempotency
  // needs it now, so it lands here — and the get-or-create catches the
  // SQLITE_CONSTRAINT violation and re-reads the existing row instead of
  // erroring (no raw-INSERT 500 on a repeat). An UNCONDITIONAL index (no
  // partial WHERE) is deliberate: a terminal task's intentKey is never
  // re-sent as a new message (the client generates messageId once per send),
  // so a partial index would only introduce "which row wins" ambiguity when a
  // terminal and a fresh task share a key.
  //
  // M4: a pre-v4 DB written through the raw-insert path can already hold
  // duplicate (owner, intent_key) rows; creating the UNIQUE index over them
  // would abort the whole migration at import. So BEFORE the index, delete the
  // older duplicates, keeping the NEWEST row per group (newest by updated_ts,
  // id as the deterministic tie-breaker) — the same "newest wins" rule the
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
  // hash-chain content (`canonicalStepContent`): adding it would change digest
  // computation for pre-existing chains and break `verifyChain` backward
  // compatibility. Data-preserving (existing steps get NULL tool_call_id).
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

/**
 * Default cadence for the timer-driven heartbeat: floor(stuckTimeout / 3).
 *
 * The invariant is `interval <= stuckTimeout / 3`: even with one full interval
 * of timer slack, the worst-case gap between two heartbeats (2 * interval <=
 * 2/3 * stuckTimeout) stays strictly under the stuck timeout, so the watchdog
 * can never fire between two heartbeats of a live worker. `startHeartbeat`
 * rejects intervals larger than this (`INVALID_CONFIG`).
 */
export function heartbeatIntervalMs(stuckTimeoutMs: number): number {
  return Math.floor(stuckTimeoutMs / 3);
}

export interface CreateTaskInput {
  owner: string;
  intentKey: string;
  spec: string;
  worker?: string;
}

export interface AppendStepInput {
  stage: string;
  action: string;
  result: string | null;
  /** Tool-call id (v4) recorded with the step for replay dedupe; undefined for
   *  non-tool steps. */
  toolCallId?: string;
}

export class Ledger {
  private readonly db: DatabaseType;
  private readonly stuckTimeoutMs: number;
  private readonly leaseExpiryMs: number;
  private readonly now: () => number;
  private readonly appendTx: (fn: () => void) => void;
  private readonly setInterval: typeof setInterval;
  private readonly clearInterval: typeof clearInterval;

  constructor(db: DatabaseType, config: LedgerConfig = {}) {
    const stuckTimeoutMs = config.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
    const leaseExpiryMs = config.leaseExpiryMs ?? DEFAULT_LEASE_EXPIRY_MS;
    if (!(stuckTimeoutMs < leaseExpiryMs)) {
      throw new LedgerError(
        "INVALID_CONFIG",
        `threshold ordering violated: stuckTimeoutMs (${stuckTimeoutMs}) ` +
          `must be < leaseExpiryMs (${leaseExpiryMs})`,
      );
    }
    this.db = db;
    this.stuckTimeoutMs = stuckTimeoutMs;
    this.leaseExpiryMs = leaseExpiryMs;
    this.now = config.now ?? Date.now;
    this.appendTx = db.transaction((fn: () => void) => fn());
    this.setInterval = config.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearInterval =
      config.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  }

  createTask(input: CreateTaskInput): TaskRow {
    const id = randomUUID();
    const ts = this.now();
    const worker = input.worker ?? null;
    this.db
      .prepare(
        `INSERT INTO ledger_task
          (id, owner, intent_key, spec, worker, status, created_ts, updated_ts,
           last_heartbeat_ts)
         VALUES (@id, @owner, @intentKey, @spec, @worker, 'queued', @ts, @ts,
                 @ts)`,
      )
      .run({
        id,
        owner: input.owner,
        intentKey: input.intentKey,
        spec: input.spec,
        worker,
        ts,
      });
    const row = this.getTask(id);
    if (!row) throw new LedgerError("TASK_NOT_FOUND", `task ${id} not found`);
    return row;
  }

  /**
   * Fetches a task by id. When [owner] is provided, cross-owner reads are
   * treated as a miss (`null`), so the routes surface a 404 rather than
   * leaking another tenant's task (IDOR).
   */
  getTask(id: string, owner?: string): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT id, owner, intent_key, spec, worker, status, created_ts,
                updated_ts, last_heartbeat_ts, lease_expires_at, lease_owner,
                fence_token
         FROM ledger_task WHERE id = ?`,
      )
      .get(id) as TaskRow | undefined;
    if (!row) return null;
    if (owner !== undefined && row.owner !== owner) return null;
    return row;
  }

  /**
   * Owner-scoped lookup by idempotency key (v4 unique index). The get-or-create
   * path and the status-by-key endpoint both use this instead of a raw INSERT,
   * so a repeat (owner, intent_key) re-reads the existing row and never 500s.
   * Cross-owner reads are a miss (`null`).
   */
  getTaskByIntentKey(owner: string, intentKey: string): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT id, owner, intent_key, spec, worker, status, created_ts,
                updated_ts, last_heartbeat_ts, lease_expires_at, lease_owner,
                fence_token
         FROM ledger_task WHERE owner = ? AND intent_key = ?`,
      )
      .get(owner, intentKey) as TaskRow | undefined;
    return row ?? null;
  }

  /**
   * Replay-dedupe lookup (v4): the step (if any) that already recorded this
   * tool-call-id's result for a task. Backed by the partial unique index on
   * (task_id, tool_call_id), so it is an indexed point lookup, not a scan.
   * When [owner] is provided, cross-owner reads are a miss (`null`).
   */
  getStepByToolCallId(
    taskId: string,
    toolCallId: string,
    owner?: string,
  ): StepRow | null {
    if (owner !== undefined && this.getTask(taskId, owner) === null) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, task_id, seq, stage, action, result, ts, tool_call_id
         FROM ledger_step WHERE task_id = ? AND tool_call_id = ?`,
      )
      .get(taskId, toolCallId) as StepRow | undefined;
    return row ?? null;
  }

  /**
   * Lists tasks. When [owner] is provided, only that owner's tasks are
   * returned (the routes always pass the caller's reference id, so a tenant
   * never sees another tenant's tasks).
   */
  listTasks(owner?: string): TaskRow[] {
    if (owner !== undefined) {
      return this.db
        .prepare(
          `SELECT id, owner, intent_key, spec, worker, status, created_ts,
                  updated_ts, last_heartbeat_ts, lease_expires_at, lease_owner,
                  fence_token
           FROM ledger_task WHERE owner = ? ORDER BY created_ts`,
        )
        .all(owner) as TaskRow[];
    }
    return this.db
      .prepare(
        `SELECT id, owner, intent_key, spec, worker, status, created_ts,
                updated_ts, last_heartbeat_ts, lease_expires_at, lease_owner,
                fence_token
         FROM ledger_task ORDER BY created_ts`,
      )
      .all() as TaskRow[];
  }

  /**
   * Lists a task's steps. When [owner] is provided, cross-owner reads are
   * treated as a miss (`[]`).
   */
  listSteps(taskId: string, owner?: string): StepRow[] {
    if (owner !== undefined && this.getTask(taskId, owner) === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT id, task_id, seq, stage, action, result, ts, tool_call_id
         FROM ledger_step WHERE task_id = ? ORDER BY seq`,
      )
      .all(taskId) as StepRow[];
  }

  /**
   * Reads a task's hash chain. When [owner] is provided, cross-owner reads are
   * treated as a miss (`[]`).
   */
  readChain(taskId: string, owner?: string): ChainRow[] {
    if (owner !== undefined && this.getTask(taskId, owner) === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT seq, task_id, step_id, digest, prev_digest, ts
         FROM ledger_chain WHERE task_id = ? ORDER BY seq`,
      )
      .all(taskId) as ChainRow[];
  }

  private requireOwnership(task: TaskRow, owner: string): void {
    if (task.owner !== owner) {
      throw new LedgerError(
        "FORBIDDEN",
        `caller ${owner} does not own task ${task.id}`,
      );
    }
  }

  private requireStatus(task: TaskRow, statuses: readonly TaskStatus[]): TaskRow {
    if (!statuses.includes(task.status)) {
      throw new LedgerError(
        "INVALID_TRANSITION",
        `task ${task.id} is ${task.status}, expected ${statuses.join(" or ")}`,
      );
    }
    return task;
  }

  /**
   * Rejects a caller whose fence token (when supplied) does not match the
   * task's current token. A superseded worker holds a stale token — granted by
   * an earlier `claimTask`/`resumeTask` that has since rotated it — so its
   * heartbeats and step appends are refused. When [fenceToken] is undefined the
   * check is skipped (backwards compatibility for pre-v3 callers/tests); the
   * routes always pass it through from claim/resume.
   */
  private requireFence(task: TaskRow, fenceToken: string | undefined): void {
    if (fenceToken !== undefined && task.fence_token !== fenceToken) {
      throw new LedgerError(
        "FENCE_CONFLICT",
        `caller's fence token does not match task ${task.id} (superseded worker)`,
      );
    }
  }

  /** Transitions a task's status, enforcing the state machine. */
  private setStatus(taskId: string, from: TaskStatus, to: TaskStatus): void {
    assertTransition(from, to);
    const result = this.db
      .prepare(
        `UPDATE ledger_task SET status = ?, updated_ts = ?
         WHERE id = ? AND status = ?`,
      )
      .run(to, this.now(), taskId, from);
    if (result.changes === 0) {
      const current = this.getTask(taskId);
      const actual = current ? ` (currently ${current.status})` : " (missing)";
      throw new LedgerError(
        "INVALID_TRANSITION",
        `task ${taskId} could not transition ${from} -> ${to}${actual}`,
      );
    }
  }

  /**
   * Claims a queued task: takes the lease, mints a fresh fence token and moves
   * the task to `running`. The returned row (with `fence_token`) is what a
   * worker holds and must present on `heartbeat`/`appendStep`.
   */
  claimTask(taskId: string, owner: string): TaskRow {
    const task = this.getTask(taskId);
    if (!task) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    this.requireOwnership(task, owner);
    this.requireStatus(task, ["queued"]);
    const now = this.now();
    const fence = randomUUID();
    this.db
      .prepare(
        `UPDATE ledger_task
         SET status = 'running', worker = COALESCE(worker, @owner),
             lease_owner = @owner, lease_expires_at = @expires,
             fence_token = @fence,
             updated_ts = @now, last_heartbeat_ts = @now
         WHERE id = @id`,
      )
      .run({ id: taskId, owner, expires: now + this.leaseExpiryMs, fence, now });
    const row = this.getTask(taskId);
    if (!row) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    return row;
  }

  /**
   * Appends a Step and its hash-chain record atomically. The task must be
   * `running`. Ownership is re-validated. When [fenceToken] is supplied it must
   * match the task's current token (a superseded worker appending steps is
   * rejected with `FENCE_CONFLICT`). Gateway clock stamps `ts`.
   * Returns the new step and its chain digest.
   */
  appendStep(
    taskId: string,
    owner: string,
    input: AppendStepInput,
    fenceToken?: string,
  ): { step: StepRow; digest: string } {
    const task = this.getTask(taskId);
    if (!task) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    this.requireOwnership(task, owner);
    this.requireStatus(task, ["running"]);
    this.requireFence(task, fenceToken);

    let step: StepRow | null = null;
    let digest = "";
    this.appendTx(() => {
      const steps = this.listSteps(taskId);
      const seq = steps.length ? steps[steps.length - 1]!.seq + 1 : 1;
      const ts = this.now();
      const stepId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ledger_step
             (id, task_id, seq, stage, action, result, ts, tool_call_id)
           VALUES (@id, @taskId, @seq, @stage, @action, @result, @ts, @toolCallId)`,
        )
        .run({
          id: stepId,
          taskId,
          seq,
          stage: input.stage,
          action: input.action,
          result: input.result,
          ts,
          toolCallId: input.toolCallId ?? null,
        });

      const prevDigest = this.readChain(taskId).at(-1)?.digest ?? genesisDigest(taskId);
      const content = canonicalStepContent({
        seq,
        stage: input.stage,
        action: input.action,
        result: input.result,
      });
      digest = sha256Hex(`${prevDigest}\n${content}\n${ts}`);
      this.db
        .prepare(
          `INSERT INTO ledger_chain (seq, task_id, step_id, digest, prev_digest, ts)
           VALUES (@seq, @taskId, @stepId, @digest, @prevDigest, @ts)`,
        )
        .run({ seq, taskId, stepId, digest, prevDigest, ts });
      this.db
        .prepare(
          `UPDATE ledger_task SET status = 'running', updated_ts = @ts WHERE id = @id`,
        )
        .run({ id: taskId, ts });
      step = {
        id: stepId,
        task_id: taskId,
        seq,
        stage: input.stage,
        action: input.action,
        result: input.result,
        ts,
        tool_call_id: input.toolCallId ?? null,
      };
    });
    if (!step) throw new LedgerError("APPEND_ONLY_VIOLATION", "step append failed");
    return { step, digest };
  }

  /**
   * Heartbeat: gateway-stamped lease renewal + liveness update. When
   * [fenceToken] is supplied it must match the task's current token; a
   * superseded worker's heartbeat is rejected with `FENCE_CONFLICT`.
   */
  heartbeat(taskId: string, owner: string, fenceToken?: string): TaskRow {
    const task = this.getTask(taskId);
    if (!task) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    this.requireOwnership(task, owner);
    this.requireStatus(task, ["running"]);
    if (task.lease_owner !== owner) {
      throw new LedgerError(
        "LEASE_CONFLICT",
        `caller ${owner} does not hold the lease on task ${taskId}`,
      );
    }
    this.requireFence(task, fenceToken);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE ledger_task
         SET lease_expires_at = @expires, updated_ts = @now,
             last_heartbeat_ts = @now
         WHERE id = @id`,
      )
      .run({ id: taskId, expires: now + this.leaseExpiryMs, now });
    const row = this.getTask(taskId);
    if (!row) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    return row;
  }

  /**
   * Marks a `running` task `stuck` when heartbeats have been silent for longer
   * than the stuck-timeout. Because stuckTimeoutMs < leaseExpiryMs, this fires
   * while the (dead) worker's lease is still nominally valid — proving the
   * watchdog acts before the lease would deadlock a relaunch.
   *
   * This keys off `last_heartbeat_ts` (NOT `updated_ts`): `appendStep` also
   * bumps `updated_ts`, so a worker that appends steps but never heartbeats
   * must still be marked stuck per the heartbeat-based spec (§3.3).
   */
  markStuckIfHeartbeatStale(taskId: string): TaskRow | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (task.status !== "running") return null;
    const now = this.now();
    if (now - task.last_heartbeat_ts < this.stuckTimeoutMs) return null;
    this.setStatus(taskId, "running", "stuck");
    return this.getTask(taskId);
  }

  /**
   * Starts a timer-driven heartbeat for a running task: every [intervalMs] the
   * loop calls `heartbeat(taskId, owner, fenceToken)`. This is what the SSE
   * transport and background workers run during streaming/tool execution so a
   * long-running-but-alive turn is never marked stuck. Appending steps does NOT
   * count as a heartbeat — stuck detection keys off `last_heartbeat_ts`, and
   * this loop is what keeps it fresh.
   *
   * The default cadence is `heartbeatIntervalMs(stuckTimeoutMs)` =
   * floor(stuckTimeout / 3); intervals larger than that are rejected
   * (`INVALID_CONFIG`) because the stuck watchdog must never be able to fire
   * between two heartbeats of a live worker (see `heartbeatIntervalMs`). Per
   * tick, errors are forwarded to [onError] and never escape the timer.
   *
   * Returns a handle whose `stop()` clears the timer.
   */
  startHeartbeat(
    taskId: string,
    owner: string,
    fenceToken: string | undefined,
    options: { intervalMs?: number; onError?: (err: unknown) => void } = {},
  ): { stop(): void } {
    const maxInterval = heartbeatIntervalMs(this.stuckTimeoutMs);
    const intervalMs = options.intervalMs ?? maxInterval;
    if (!(intervalMs > 0 && intervalMs <= maxInterval)) {
      throw new LedgerError(
        "INVALID_CONFIG",
        `heartbeat interval ${intervalMs}ms must be in (0, ${maxInterval}] ` +
          `(<= stuckTimeoutMs/3) so the stuck watchdog cannot fire between heartbeats`,
      );
    }
    const handle = this.setInterval(() => {
      try {
        this.heartbeat(taskId, owner, fenceToken);
      } catch (err) {
        options.onError?.(err);
      }
    }, intervalMs);
    return { stop: () => this.clearInterval(handle) };
  }

  /**
   * Startup orphan reconciliation: marks every `running` task that has gone
   * quiet (heartbeat stale past the stuck-timeout) OR whose lease has lapsed as
   * `stuck`. This recovers tasks orphaned by a gateway restart or a crashed
   * worker, so they can be re-queued/resumed instead of lying false-stuck as
   * `running`. It is idempotent (a second pass finds nothing left stale), never
   * touches `queued`/terminal tasks, and mirrors `markStuckIfHeartbeatStale`
   * exactly (stuck fires when `last_heartbeat_ts <= now - stuckTimeoutMs`).
   */
  reconcileOrphans(): { marked: string[] } {
    const now = this.now();
    const staleCutoff = now - this.stuckTimeoutMs;
    const rows = this.db
      .prepare(
        `SELECT id FROM ledger_task
         WHERE status = 'running'
           AND (last_heartbeat_ts <= ?
                OR (lease_expires_at IS NOT NULL AND lease_expires_at < ?))`,
      )
      .all(staleCutoff, now) as { id: string }[];
    const marked: string[] = [];
    for (const { id } of rows) {
      this.setStatus(id, "running", "stuck");
      marked.push(id);
    }
    return { marked };
  }

  /**
   * Resumes a task on behalf of the task owner. Non-owners are rejected.
   * Clears the broken lease, grants it to the resumer and ROTATES the fence
   * token (a resumed task gets a NEW token), so any superseded worker holding
   * the old token is rejected on its next heartbeat/append.
   */
  resumeTask(taskId: string, owner: string): TaskRow {
    const task = this.getTask(taskId);
    if (!task) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    this.requireOwnership(task, owner);
    if (task.status !== "stuck" && task.status !== "awaiting_review") {
      throw new LedgerError(
        "INVALID_TRANSITION",
        `task ${taskId} in ${task.status} cannot be resumed`,
      );
    }
    const now = this.now();
    const fence = randomUUID();
    this.setStatus(taskId, task.status, "running");
    this.db
      .prepare(
        `UPDATE ledger_task
         SET lease_owner = @owner, lease_expires_at = @expires,
             fence_token = @fence,
             updated_ts = @now, last_heartbeat_ts = @now
         WHERE id = @id`,
      )
      .run({ id: taskId, owner, expires: now + this.leaseExpiryMs, fence, now });
    const row = this.getTask(taskId);
    if (!row) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    return row;
  }

  /** Moves a `running` (or otherwise claimable) task to a terminal state. */
  completeTask(
    taskId: string,
    owner: string,
    to: Exclude<TaskStatus, "queued" | "running" | "stuck">,
    fenceToken?: string,
  ): TaskRow {
    if (
      to !== "succeeded" &&
      to !== "failed" &&
      to !== "cancelled" &&
      to !== "awaiting_review"
    ) {
      throw new LedgerError("INVALID_TRANSITION", `cannot complete to ${to}`);
    }
    const task = this.getTask(taskId);
    if (!task) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    this.requireOwnership(task, owner);
    this.requireFence(task, fenceToken);
    this.setStatus(taskId, task.status, to);
    const row = this.getTask(taskId);
    if (!row) throw new LedgerError("TASK_NOT_FOUND", `task ${taskId} not found`);
    return row;
  }

  /**
   * Recomputes every digest in the task's hash chain from the previous
   * record and confirms the stored chain matches. Returns false on any
   * tampering/missing record.
   */
  verifyChain(taskId: string): boolean {
    const steps = this.listSteps(taskId);
    const chain = this.readChain(taskId);
    if (steps.length !== chain.length) return false;
    if (steps.length === 0) return true;
    let expectedPrev = genesisDigest(taskId);
    for (let i = 0; i < chain.length; i++) {
      const record = chain[i]!;
      const step = steps[i]!;
      if (record.seq !== step.seq) return false;
      if (record.prev_digest !== expectedPrev) return false;
      if (record.step_id !== step.id) return false;
      const content = canonicalStepContent({
        seq: step.seq,
        stage: step.stage,
        action: step.action,
        result: step.result,
      });
      const expectedDigest = sha256Hex(`${expectedPrev}\n${content}\n${step.ts}`);
      if (record.digest !== expectedDigest) return false;
      expectedPrev = record.digest;
    }
    return true;
  }
}

