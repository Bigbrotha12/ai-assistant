import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only ledger DB isolation.
 *
 * `ledger.routes.ts` opens and migrates `LEDGER_DB_PATH` at import time. Every
 * test file that imports it would otherwise share the repo's default
 * `./data/ledger.db`, and `node --test` runs files in parallel — so a fresh DB
 * makes several processes race the same migration and one throws
 * `SqliteError: duplicate column name: payload` (the v5 payload migration
 * re-runs because `user_version` has not advanced yet in the loser).
 *
 * Import this module FIRST in any test that (transitively) imports
 * `ledger.routes.ts`, so each process migrates its own throwaway DB.
 */
const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
process.env.LEDGER_DB_PATH ??= join(dir, "ledger.db");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS temp dir is reclaimed regardless.
  }
});
