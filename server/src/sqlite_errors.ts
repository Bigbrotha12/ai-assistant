/**
 * Shared SQLite error classification — the one place that decides whether a
 * thrown error is a UNIQUE-constraint race. Consumed by the get-or-create
 * idempotency paths (`credentials/idempotency.ts`, `goals/ledger.ts`), which
 * treat a lost INSERT race as "re-read the winner's row", never a 500.
 *
 * Deliberately NARROW: only the extended codes `SQLITE_CONSTRAINT_UNIQUE` /
 * `SQLITE_CONSTRAINT_PRIMARYKEY` count. Other `SQLITE_CONSTRAINT*` aborts
 * (CHECK, trigger RAISE(ABORT), NOT NULL, FOREIGN KEY) are real errors that
 * must surface — swallowing them would let a failed write masquerade as an
 * idempotent hit. Non-SqliteError throws (or anything without one of those
 * exact `code` values) are never treated as a violation.
 */

const UNIQUE_CONSTRAINT_CODES: ReadonlySet<string> = new Set([
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
]);

/** True only for a better-sqlite3 UNIQUE/PRIMARY KEY constraint violation. */
export function isUniqueConstraintViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && UNIQUE_CONSTRAINT_CODES.has(code);
}
