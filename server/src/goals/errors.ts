/**
 * Goal error primitives — a feature-local leaf module mirroring
 * `jobs/errors.ts` so goal consumers (Phase 3 control tools, the goal runner)
 * can raise and catch goal failures without importing `goals/ledger.ts`
 * (avoids closing a future `runner -> control -> ledger` import cycle).
 *
 * These errors are NOT routed to HTTP yet: Phase 3.6 owns the route mapping.
 */

/** Goal error codes surfaced to callers of `GoalLedger`. */
export type GoalErrorCode =
  | "GOAL_NOT_FOUND"
  | "GOAL_FORBIDDEN"
  | "GOAL_INVALID_TRANSITION"
  | "GOAL_LEASE_CONFLICT";

/** Raised by `GoalLedger`. Never carries credential values. */
export class GoalError extends Error {
  readonly code: GoalErrorCode;

  constructor(code: GoalErrorCode, message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}
