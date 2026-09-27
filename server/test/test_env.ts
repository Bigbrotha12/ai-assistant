import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only, per-process database isolation.
 *
 * Several modules open and migrate a SQLite file at import time:
 *  - `ledger.routes.ts` opens + migrates `LEDGER_DB_PATH` (`PRAGMA
 *    user_version`-gated schema migrations).
 *  - `auth.ts` opens `DB_PATH` (better-auth's schema).
 *
 * `node --test` runs every test file in its own parallel child process, so a
 * shared path makes those processes race the same migration — e.g. one throws
 * `SqliteError: duplicate column name: payload` when the v5 payload migration
 * re-runs before `user_version` has advanced in the loser.
 *
 * Point every process at its own throwaway directory. This module is loaded as
 * an `--import` preload by the `test` script (so it applies to *every* process,
 * including files that only import these modules transitively) and is also
 * imported directly by the files that need it, so a standalone
 * `tsx --test <file>` run stays isolated too.
 *
 * `DB_PATH`/`LEDGER_DB_PATH` are assigned unconditionally: a value inherited
 * from the shell, CI environment, or `server/.env` must not silently defeat the
 * isolation and re-introduce the race.
 */
const dir = mkdtempSync(join(tmpdir(), "ai-assistant-test-"));
process.env.DB_PATH = join(dir, "gateway.db");
process.env.LEDGER_DB_PATH = join(dir, "ledger.db");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS temp dir is reclaimed regardless.
  }
});
