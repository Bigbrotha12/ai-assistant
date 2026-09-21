import { createHash } from "node:crypto";
import { coerceMessageLikeToMessage } from "@langchain/core/messages";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { BaseCheckpointSaver } from "@langchain/langgraph";
import Database from "better-sqlite3-multiple-ciphers";
import { CREDENTIAL_REDACTION } from "../plugins/credential.ts";

/**
 * Durable, encrypted-at-rest conversation checkpoints (Phase 2, Wave B1).
 *
 * The LangGraph agent stores its conversation state in a SQLite
 * `SqliteSaver`. This module wraps that checkpointer with:
 *
 *  - **Encryption at rest (chosen: Option A — SQLCipher-compatible driver).**
 *    Plain `better-sqlite3` has no encryption support (survey confirmed), so
 *    the checkpoint DB is opened with `better-sqlite3-multiple-ciphers`, a
 *    drop-in fork whose `Database` is API-identical to `better-sqlite3`
 *    (same constructor, `pragma`, `prepare`, `exec`, `transaction` — verified
 *    structural-typing compatible with `SqliteSaver`'s `Database` parameter).
 *    The DB is created in SQLCipher mode (`cipher='sqlcipher'` + `legacy=4`),
 *    keyed from `CHECKPOINT_DB_KEY` (required in production via `env.ts`).
 *    Opening with a wrong/missing key throws `file is not a database`, and the
 *    file on disk contains no plaintext rows (tested). The alternative —
 *    encrypt-on-close/decrypt-on-open file wrapping — was rejected because a
 *    crash between a write and the encrypt pass would silently lose
 *    conversation state; SQLCipher encrypts every page as it is written, so
 *    the checkpoint rows are durable AND at rest-encrypted.
 *
 *  - **`0600` permissions.** The DB file (and its `-wal`/`-shm` siblings after
 *    `close()`) is chmodded `0600`, mirroring the plugin store's atomic-save
 *    permissions (`plugins/store.ts`).
 *
 *  - **Owner scoping.** The transport maps a client thread id to
 *    `sha256(userId + clientThreadId)` (plan §thread ownership). This store
 *    ALSO records the owning API-key `referenceId` on every thread so
 *    `listThreads`/`deleteThread`/`deleteThreadsForOwner` are owner-scoped —
 *    a cross-owner read/delete is an IDOR-safe miss (`[]`/`false`/`0`), the
 *    same pattern the ledger uses for cross-owner misses.
 *
 *  - **Own schema, SqliteSaver's tables kept opaque.** SqliteSaver creates its
 *    own `checkpoints`/`writes` tables lazily. Rather than altering its
 *    schema (which would couple this store to LangGraph's internal DDL), this
 *    store keeps a parallel `thread_owner` table keyed by `thread_id` and
 *    treats the checkpointer tables as opaque storage it only ever hard-deletes
 *    from (on `deleteThread`) or counts (for the list's message-count proxy).
 *    Schema versioning mirrors the ledger (`PRAGMA user_version` +
 *    `CURRENT_CHECKPOINT_VERSION`).
 *
 *  - **Credential non-leak.** Tool results echo credentials into message
 *    content. `redactForCheckpoint` masks credential-shaped material
 *    (`Authorization` headers, `Bearer <token>`, `sk-...` keys) with `***`
 *    BEFORE content is written to checkpoint rows; the transport (Wave C1)
 *    calls it, reusing `CREDENTIAL_REDACTION` from `plugins/credential.ts`.
 *    The store never logs key material.
 */

/** Where the checkpoint DB lives when `CHECKPOINT_DB_PATH` is unset. */
export const DEFAULT_CHECKPOINT_DB_PATH = "./data/checkpoints.db";

export type CheckpointStoreErrorCode =
  | "KEY_REQUIRED"
  | "OPEN_FAILED"
  | "FILE_IO";

/** Raised by `createCheckpointStore` on configuration/open failures. */
export class CheckpointStoreError extends Error {
  readonly code: CheckpointStoreErrorCode;

  constructor(code: CheckpointStoreErrorCode, message: string) {
    super(message);
    this.name = "CheckpointStoreError";
    this.code = code;
  }
}

/** The cipher fork's Database instance type (drop-in for better-sqlite3's). */
type CipherDatabase = InstanceType<typeof Database>;

/** Migration list index 0 == schema version 1 (mirrors `ledger.ts`). */
type Migration = (db: CipherDatabase) => void;

const CHECKPOINT_MIGRATIONS: readonly Migration[] = [
  // v1 — parallel owner/thread-metadata table, keyed by the hashed thread_id
  // that LangGraph's SqliteSaver uses. SqliteSaver's own `checkpoints`/`writes`
  // tables are NOT touched here (it creates them itself on first use).
  (db) => {
    db.exec(`
      CREATE TABLE thread_owner (
        thread_id  TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE INDEX thread_owner_owner_updated_idx
        ON thread_owner (owner, updated_ts);
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE thread_owner ADD COLUMN public_id TEXT;
      CREATE UNIQUE INDEX thread_owner_public_idx ON thread_owner(owner, public_id);
      CREATE TABLE deleted_thread (thread_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
    `);
  },
];

export const CURRENT_CHECKPOINT_VERSION = CHECKPOINT_MIGRATIONS.length;

/** Applies `migrations` to bring `db` up to `targetVersion` (idempotent). */
export function applyCheckpointMigrations(
  db: CipherDatabase,
  migrations: readonly Migration[],
  targetVersion: number,
): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current + 1; v <= targetVersion; v++) {
    const migration = migrations[v - 1];
    if (!migration) {
      throw new Error(
        `no migration registered for checkpoint schema version ${v}`,
      );
    }
    migration(db);
    db.pragma(`user_version = ${v}`);
  }
}

/**
 * Deterministic thread id for a conversation: `sha256(userId + "\n" +
 * clientThreadId)` per the plan's transport-layer mapping. `userId` is the
 * API-key referenceId (from `requireApiKey`); the hash binds the thread to its
 * owner, so an unguessable id alone prevents cross-user thread access even
 * before the owner column is checked. The `\n` delimiter between the two
 * fields makes the pair unambiguous — without it, `(owner="ab", thread="c")`
 * and `(owner="a", thread="bc")` would collide on the same concatenated
 * string.
 */
export function checkpointThreadId(
  userId: string,
  clientThreadId: string,
): string {
  return createHash("sha256").update(`${userId}\n${clientThreadId}`).digest("hex");
}

export type HistoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export async function readThreadMessages(store: CheckpointStore, threadId: string): Promise<HistoryMessage[] | undefined> {
  const checkpoint = await store.checkpointer.get({ configurable: { thread_id: threadId } });
  if (!checkpoint) return undefined;
  const messages = checkpoint.channel_values.messages;
  if (!Array.isArray(messages)) return [];
  return messages.map((raw) => {
    const message: BaseMessage = coerceMessageLikeToMessage(raw);
    const type = message.getType();
    const role = type === "human" ? "user" : type === "ai" ? "assistant" : type;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new Error("unsupported_checkpoint_message");
    }
    const result: HistoryMessage = { role: role as HistoryMessage["role"], content: message.content };
    if (role === "assistant" && "tool_calls" in message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    if (role === "tool" && "tool_call_id" in message) result.tool_call_id = String(message.tool_call_id);
    return result;
  });
}

export type ThreadRecord = {
  threadId: string;
  publicId?: string | null;
  owner: string;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
};

export type ThreadSummary = ThreadRecord & {
  /** Number of `checkpoints` rows for the thread — a stable proxy for message
   *  count (one row per graph super-step). Read-only view of SqliteSaver's
   *  table; 0 when the thread has no checkpoints yet. */
  messageCount: number;
};

export type CheckpointStore = {
  /** LangGraph checkpointer for `graph.compile({ checkpointer })`. */
  checkpointer: BaseCheckpointSaver;
  /** Closes the underlying DB (checkpointing WAL first) and re-enforces 0600. */
  close(): Promise<void>;
  /**
   * Records/refreshes the owner mapping for a thread. The transport calls this
   * around graph invocation so list/delete/GC endpoints can resolve ownership.
   * Upserts; `lastError` is the most recent per-thread error the transport
   * wants surfaced in the list view (nullable).
   */
  touchThread(owner: string, threadId: string, lastError?: string | null, publicId?: string): void;
  isDeleted?(threadId: string): boolean;
  /** Reads thread metadata by (hashed) thread id; `undefined` if unknown. */
  getThread(threadId: string): ThreadRecord | undefined;
  /** Owner-scoped thread list, newest-updated first. Cross-owner rows are
   *  never returned (IDOR-safe). */
  listThreads(owner: string): ThreadSummary[];
  /** Owner-scoped hard delete; cascades the thread's checkpoint rows. Returns
   *  `false` on a cross-owner or unknown thread (IDOR-safe miss). */
  deleteThread(owner: string, threadId: string): boolean;
  /** Per-user GC: deletes every thread (and checkpoints) owned by `owner`.
   *  Returns the number of threads deleted. */
  deleteThreadsForOwner(owner: string): number;
};

export type CheckpointStoreOptions = {
  /** Checkpoint DB file path. Default `./data/checkpoints.db`. */
  dbPath?: string;
  /**
   * SQLCipher key. Required — the store refuses to open an unencrypted DB
   * (`KEY_REQUIRED`). The environment supplies this from `CHECKPOINT_DB_KEY`;
   * tests inject a temp key. DI-friendly (no env import here).
   */
  dbKey?: string;
  /**
   * Checkpointer class constructor seam (defaults to the real `SqliteSaver`).
   * Kept so tests can substitute a stub checkpointer without an encrypted DB,
   * though the real one is used throughout this suite.
   */
  SqliteSaver?: new (db: CipherDatabase) => BaseCheckpointSaver;
};

/**
 * Opens (creating if needed) the encrypted checkpoint DB, applies migrations,
 * enforces `0600`, and builds the LangGraph `SqliteSaver` over it.
 *
 * The DB is configured for SQLCipher BEFORE any table I/O: `cipher`/`legacy`
 * pragmas select the format, then `key` unlocks it. A wrong/missing key makes
 * the first read throw (`file is not a database`), surfacing as `OPEN_FAILED`.
 */
export async function createCheckpointStore(
  opts: CheckpointStoreOptions = {},
): Promise<CheckpointStore> {
  const dbPath = opts.dbPath ?? DEFAULT_CHECKPOINT_DB_PATH;
  const dbKey = opts.dbKey ?? "";
  if (dbKey === "") {
    throw new CheckpointStoreError(
      "KEY_REQUIRED",
      "createCheckpointStore: CHECKPOINT_DB_KEY is required — the checkpoint " +
        "DB is encrypted at rest and refuses to open unencrypted. Supply a " +
        "dbKey (production requires it; development has a warned default).",
    );
  }
  const SqliteSaverCtor = opts.SqliteSaver ?? SqliteSaver;
  let db: CipherDatabase | undefined;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(keyPragma(dbKey));
    applyCheckpointMigrations(db, CHECKPOINT_MIGRATIONS, CURRENT_CHECKPOINT_VERSION);
    chmodSync(dbPath, 0o600);
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort handle cleanup on a failed open
      }
    }
    throw new CheckpointStoreError(
      "OPEN_FAILED",
      `could not open checkpoint store ${dbPath} (wrong/missing key or corrupt file): ${String(err)}`,
    );
  }

  const checkpointer = new SqliteSaverCtor(db);
  forceSqliteSaverSetup(checkpointer);
  return new CheckpointStoreImpl(db, checkpointer, dbPath);
}

/** SQLCipher key pragma with single-quote escaping for the string literal. */
function keyPragma(key: string): string {
  return `key='${key.replace(/'/g, "''")}'`;
}

/**
 * SqliteSaver creates its `checkpoints`/`writes` tables lazily in a `setup()`
 * that is `protected` in its typings. We force it at open so the tables exist
 * before the store's list queries count against `checkpoints` (and so a wrong
 * key fails here, at open, rather than on the first graph call).
 */
function forceSqliteSaverSetup(checkpointer: BaseCheckpointSaver): void {
  const withSetup = checkpointer as BaseCheckpointSaver & { setup?: () => void };
  withSetup.setup?.();
}

class CheckpointStoreImpl implements CheckpointStore {
  readonly checkpointer: BaseCheckpointSaver;
  private readonly db: CipherDatabase;
  private readonly dbPath: string;
  private closed = false;

  constructor(db: CipherDatabase, checkpointer: BaseCheckpointSaver, dbPath: string) {
    this.db = db;
    this.checkpointer = checkpointer;
    this.dbPath = dbPath;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Fold any pending WAL frames into the main file so a subsequent
      // plaintext-scan / backup sees everything, then close.
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort: a read-only/broken handle must still attempt close
    }
    this.db.close();
    // Re-enforce 0600 on the db and any -wal/-shm siblings (WAL mode creates
    // them after open; they too hold (encrypted) conversation data).
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${this.dbPath}${suffix}`;
      if (existsSync(p)) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // best-effort permission hardening; never mask the close
        }
      }
    }
  }

  isDeleted(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM deleted_thread WHERE thread_id = ?").get(threadId);
  }

  touchThread(owner: string, threadId: string, lastError: string | null = null, publicId?: string): void {
    if (this.isDeleted(threadId)) throw new Error("thread_deleted");
    const existing = this.getThread(threadId);
    if (existing && existing.owner !== owner) {
      throw new Error("thread_mapping_conflict");
    }
    // An existing NON-NULL public_id that differs from the caller's is a
    // cross-id hijack attempt. A NULL public_id is a legacy internal-only
    // thread: the first managed writer ADOPTS it (the public id is claimed
    // and the thread becomes recoverable).
    if (
      publicId !== undefined &&
      existing &&
      existing.publicId !== null &&
      existing.publicId !== publicId
    ) {
      throw new Error("thread_mapping_conflict");
    }
    if (publicId !== undefined && checkpointThreadId(owner, publicId) !== threadId) {
      throw new Error("thread_mapping_conflict");
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO thread_owner (thread_id, owner, created_ts, updated_ts, last_error, public_id)
         VALUES (@threadId, @owner, @now, @now, @lastError, @publicId)
         ON CONFLICT(thread_id) DO UPDATE SET
           owner      = excluded.owner,
           updated_ts = excluded.updated_ts,
           last_error = excluded.last_error,
           public_id  = COALESCE(thread_owner.public_id, excluded.public_id)`,
      )
      .run({ threadId, owner, now, lastError, publicId: publicId ?? null });
  }

  getThread(threadId: string): ThreadRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT thread_id, owner, created_ts, updated_ts, last_error, public_id
         FROM thread_owner WHERE thread_id = ?`,
      )
      .get(threadId) as ThreadRow | undefined;
    return row ? toThreadRecord(row) : undefined;
  }

  listThreads(owner: string): ThreadSummary[] {
    // message_count is a correlated subquery over SqliteSaver's opaque
    // `checkpoints` table (forced to exist at open via setup()); cross-owner
    // rows are filtered by the WHERE clause.
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, t.owner, t.created_ts, t.updated_ts, t.last_error, t.public_id,
                (SELECT COUNT(*) FROM checkpoints c
                  WHERE c.thread_id = t.thread_id) AS message_count
         FROM thread_owner t
         WHERE t.owner = ?
         ORDER BY t.updated_ts DESC`,
      )
      .all(owner) as Array<ThreadRow & { message_count: number }>;
    return rows.map((row) => ({ ...toThreadRecord(row), messageCount: row.message_count }));
  }

  deleteThread(owner: string, threadId: string): boolean {
    return this.db.transaction(() => {
      // Owner-scoped delete of the metadata row; a cross-owner or unknown
      // thread changes 0 rows → false (IDOR-safe miss, no error).
      const res = this.db
        .prepare("DELETE FROM thread_owner WHERE thread_id = ? AND owner = ?")
        .run(threadId, owner);
      if (res.changes === 0) return false;
      this.db.prepare("INSERT OR IGNORE INTO deleted_thread (thread_id, owner) VALUES (?, ?)").run(threadId, owner);
      // Cascade: remove the thread's checkpoint/writes rows. Mirrors
      // SqliteSaver.deleteThread (checkpoints + writes in one transaction).
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      return true;
    })();
  }

  deleteThreadsForOwner(owner: string): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT thread_id FROM thread_owner WHERE owner = ?")
        .all(owner) as Array<{ thread_id: string }>;
      const delCheckpoints = this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?");
      const delWrites = this.db.prepare("DELETE FROM writes WHERE thread_id = ?");
      for (const { thread_id } of rows) {
        this.db.prepare("INSERT OR IGNORE INTO deleted_thread (thread_id, owner) VALUES (?, ?)").run(thread_id, owner);
        delCheckpoints.run(thread_id);
        delWrites.run(thread_id);
      }
      return this.db
        .prepare("DELETE FROM thread_owner WHERE owner = ?")
        .run(owner).changes;
    })();
  }
}

type ThreadRow = {
  thread_id: string;
  public_id: string | null;
  owner: string;
  created_ts: number;
  updated_ts: number;
  last_error: string | null;
};

function toThreadRecord(row: ThreadRow): ThreadRecord {
  return {
    threadId: row.thread_id,
    publicId: row.public_id,
    owner: row.owner,
    createdAt: row.created_ts,
    updatedAt: row.updated_ts,
    lastError: row.last_error,
  };
}

const AUTHORIZATION_BEARER = /Authorization\s*:\s*Bearer\s+\S+/gi;
// Generic `Authorization: <value>` — but never the Bearer form, which the
// previous pattern already handles (a bare `\S+` would swallow the word
// "Bearer" and double-mask it). Masks the WHOLE value to end-of-line: a Basic
// or generic token ("Basic dXNlcjpwYXNz") carries its credential in the first
// token AND potentially more on the same line, so a single `\S+` left the tail
// unmasked. `[^\n\r]*` (no `m` flag needed) never crosses into the next line.
const AUTHORIZATION_GENERIC = /Authorization\s*:\s*(?!Bearer\b)\S+[^\n\r]*/gi;
const BARE_BEARER = /Bearer\s+\S+/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]+/g;
// Non-Bearer credential header fields: `Api-Key: ...`, `X-Api-Key: ...`
// (any case). Masks the value to end-of-line, keeping the field name.
const API_KEY_HEADER = /(\b(?:x-)?api[-_]?key\s*:\s*)[^\n\r]*/gi;
// JSON-style credential fields: `"api_key": "abc123"`, `"apiKey": "..."`,
// `"x-api-key": "..."`, `"token": "..."`, `"secret": "..."`,
// `"authorization": "..."`. Only quoted values are masked (a numeric/bool
// literal is not key material); the closing quote keeps the mask from
// swallowing a following key/value on the same line.
const JSON_CREDENTIAL_FIELD =
  /("|')((?:x-)?api[-_]?key|token|secret|authorization)(?:"|')\s*:\s*("|')([^"'\n]*)\3/gi;

/**
 * Masks credential-shaped material in a string before it is persisted into
 * checkpoint rows (tool results routinely echo API keys/bearer tokens back
 * into message content). Masks `Authorization: <value>` headers (Bearer AND
 * Basic/generic, value to end-of-line), bare `Bearer <token>` occurrences,
 * `sk-...` API keys, `Api-Key`/`X-Api-Key` headers, and quoted JSON
 * `api_key`/`token`/`secret`/`authorization` fields with `CREDENTIAL_REDACTION`
 * (`***`), reusing the marker from `plugins/credential.ts`. The transport
 * (Wave C1 / Phase 3) applies this to message/tool-result content before the
 * graph writes it; the store keeps it here so the redaction discipline lives
 * next to the data it protects. Never logs anything itself.
 */
export function redactForCheckpoint(content: string): string {
  return content
    .replace(AUTHORIZATION_BEARER, `Authorization: Bearer ${CREDENTIAL_REDACTION}`)
    .replace(AUTHORIZATION_GENERIC, `Authorization: ${CREDENTIAL_REDACTION}`)
    .replace(BARE_BEARER, `Bearer ${CREDENTIAL_REDACTION}`)
    .replace(API_KEY_HEADER, `$1${CREDENTIAL_REDACTION}`)
    .replace(JSON_CREDENTIAL_FIELD, `$1$2$1: $3${CREDENTIAL_REDACTION}$3`)
    .replace(SK_KEY, `sk-${CREDENTIAL_REDACTION}`);
}