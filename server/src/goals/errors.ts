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

/**
 * Typed unwind signal for a step whose goal is no longer `running` (Phase
 * 3.3's termination mechanism). Thrown ONLY from the runner's
 * `beforeModelCall` guard — never from a tool `func`:
 * `createAgentGraph`'s `ToolNode` is `{ handleToolErrors: false }`
 * (`agents/graph.ts`), so a throwing tool func rejects `graph.invoke` outright
 * instead of unwinding as "the control tool already committed".
 *
 * The runner catches it in step execution and treats the round as done: the
 * control tool's own transaction already wrote its message-log entry and CAS,
 * so the runner persists NOTHING from the round.
 */
export class GoalTerminalSignal extends Error {
  constructor(goalId: string, status: string) {
    super(`goal ${goalId} left 'running' (now ${status}); step unwound`);
    this.name = "GoalTerminalSignal";
  }
}

/**
 * A setup-phase failure carrying its wire `failureReason` (M2 TERMINATES a
 * goal on a bound/setup violation — never pauses). Raised by snapshot parsing
 * and the runner's step setup; mapped to the goal's `failure_reason`.
 */
export class GoalSetupError extends Error {
  readonly failureReason: string;

  constructor(failureReason: string) {
    super(failureReason);
    this.name = "GoalSetupError";
    this.failureReason = failureReason;
  }
}
