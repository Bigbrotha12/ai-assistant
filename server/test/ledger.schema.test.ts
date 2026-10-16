import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CURRENT_LEDGER_VERSION, migrateLedger } from "../src/ledger/index.ts";
import {
  configureLedgerConnection,
  hardenLedgerFiles,
  LEDGER_BUSY_TIMEOUT_MS,
} from "../src/ledger/schema.ts";

/** Runs `fn` against a throwaway directory; always cleans up. */
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ledger-schema-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("configureLedgerConnection", () => {
  test("enables WAL and the bounded busy timeout on a file database", () => {
    withTempDir((dir) => {
      const db = new Database(join(dir, "ledger.db"));
      // Seed a different timeout so the assertion proves the helper SETS it.
      db.pragma("busy_timeout = 100");
      configureLedgerConnection(db);

      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(
        db.pragma("busy_timeout", { simple: true }),
        LEDGER_BUSY_TIMEOUT_MS,
      );
      db.close();
    });
  });

  test("the busy timeout is a positive, bounded value and overridable", () => {
    assert.ok(LEDGER_BUSY_TIMEOUT_MS > 0, "must be > 0");
    assert.ok(
      LEDGER_BUSY_TIMEOUT_MS <= 30_000,
      "must stay bounded so a contended write cannot block a request for long",
    );

    withTempDir((dir) => {
      const db = new Database(join(dir, "ledger.db"));
      configureLedgerConnection(db, 1_234);
      assert.equal(db.pragma("busy_timeout", { simple: true }), 1_234);
      db.close();
    });
  });

  test("in-memory databases keep their journal mode but still get the timeout", () => {
    const db = new Database(":memory:");
    configureLedgerConnection(db);

    assert.equal(db.pragma("journal_mode", { simple: true }), "memory");
    assert.equal(
      db.pragma("busy_timeout", { simple: true }),
      LEDGER_BUSY_TIMEOUT_MS,
    );
    db.close();
  });

  test("does not alter user_version (migration semantics preserved)", () => {
    withTempDir((dir) => {
      const db = new Database(join(dir, "ledger.db"));
      configureLedgerConnection(db);
      assert.equal(db.pragma("user_version", { simple: true }), 0);

      migrateLedger(db);
      assert.equal(
        db.pragma("user_version", { simple: true }),
        CURRENT_LEDGER_VERSION,
      );
      db.close();
    });
  });
});

describe("hardenLedgerFiles", () => {
  test("makes the database and its WAL/SHM sidecars owner-only (0600)", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "ledger.db");
      const db = new Database(dbPath);
      configureLedgerConnection(db);
      migrateLedger(db);
      // Any access after switching to WAL materializes the sidecars, which
      // SQLite creates 0644 under the default umask.
      db.prepare("SELECT name FROM sqlite_master").all();

      assert.ok(existsSync(`${dbPath}-wal`), "WAL sidecar must exist");
      assert.ok(existsSync(`${dbPath}-shm`), "SHM sidecar must exist");

      hardenLedgerFiles(dbPath);

      assert.equal(modeOf(dbPath), 0o600, "main database");
      assert.equal(modeOf(`${dbPath}-wal`), 0o600, "WAL sidecar");
      assert.equal(modeOf(`${dbPath}-shm`), 0o600, "SHM sidecar");
      db.close();
    });
  });

  test("tolerates sidecars that do not exist yet", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "ledger.db");
      const db = new Database(dbPath); // rollback journal: no sidecars
      assert.equal(existsSync(`${dbPath}-wal`), false);

      hardenLedgerFiles(dbPath); // must not throw on the missing sidecars
      assert.equal(modeOf(dbPath), 0o600);
      db.close();
    });
  });

  test("re-hardens sidecars recreated on a later open", () => {
    withTempDir((dir) => {
      const dbPath = join(dir, "ledger.db");
      const first = new Database(dbPath);
      configureLedgerConnection(first);
      migrateLedger(first);
      first.prepare("SELECT name FROM sqlite_master").all();
      hardenLedgerFiles(dbPath);
      first.close(); // a clean close removes the sidecars

      assert.equal(existsSync(`${dbPath}-wal`), false, "sidecars removed on close");

      // A later boot recreates the sidecars 0644; hardening again restores 0600.
      const second = new Database(dbPath);
      configureLedgerConnection(second);
      second.prepare("SELECT name FROM sqlite_master").all();
      hardenLedgerFiles(dbPath);

      assert.equal(modeOf(`${dbPath}-wal`), 0o600, "recreated WAL sidecar");
      assert.equal(modeOf(`${dbPath}-shm`), 0o600, "recreated SHM sidecar");
      assert.equal(modeOf(dbPath), 0o600, "main database");
      second.close();
    });
  });
});
