/**
 * Goal-domain unions and row shapes. Mirrors the v9 DDL in `goals/migrate.ts`
 * one-to-one; the union convention follows `ledger.ts` / `sentinel/types.ts`
 * (`X_STATUSES as const` array + derived `XStatus` type).
 */

export const GOAL_STATUSES = [
  "queued",
  "running",
  "paused",
  "complete",
  "failed",
  "cancelled",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_TERMINAL_STATUSES = [
  "complete",
  "failed",
  "cancelled",
] as const;
export type GoalTerminalStatus = (typeof GOAL_TERMINAL_STATUSES)[number];

export const GOAL_LIVE_STATUSES = ["queued", "running", "paused"] as const;
export type GoalLiveStatus = (typeof GOAL_LIVE_STATUSES)[number];

export const GOAL_STEP_STATUSES = ["running", "terminal"] as const;
export type GoalStepStatus = (typeof GOAL_STEP_STATUSES)[number];

/**
 * Legal `next` targets for `GoalLedger.pauseGoal` — the CAS transitions away
 * from `running` that Phase 2 owns. `running -> queued` re-chaining and
 * cancel own their own CAS in Phase 3 and are deliberately NOT here; the
 * runtime guard in `pauseGoal` rejects anything outside this set.
 */
export const GOAL_TRANSITION_TARGETS = [
  "paused",
  "complete",
  "failed",
  "cancelled",
] as const;
export type GoalTransitionTarget = (typeof GOAL_TRANSITION_TARGETS)[number];

export const GOAL_STEP_KINDS = ["model", "tool", "plan"] as const;
export type GoalStepKind = (typeof GOAL_STEP_KINDS)[number];

export const GOAL_MUTATION_STATES = [
  "pending",
  "applied",
  "retryable",
  "unresolved",
] as const;
export type GoalMutationState = (typeof GOAL_MUTATION_STATES)[number];

/**
 * How a user resolves one previously-`unresolved` mutation (Phase 6, plan
 * F3(b) / §Recovery). Deliberately distinct from [GoalMutationState] — that is
 * the ledger's own lifecycle state, this is the user's assertion about the
 * interrupted step's egress:
 *
 * - `applied`     — the tool DID run before the crash; the tombstone stands.
 * - `retryable`   — the tool never started (no egress attempt); the next step
 *   may retry the identical call.
 * - `not_applied` — the user asserts no effect escaped (R18); the mutation row
 *   is deleted so `effectState` can clear.
 */
export type GoalMutationResolution = "applied" | "retryable" | "not_applied";

/** Derived from `goal_mutation` rows (`GoalLedger.effectState`). */
export const GOAL_EFFECT_STATES = [
  "unknown",
  "completed_steps_only",
  "none_known",
] as const;
export type GoalEffectState = (typeof GOAL_EFFECT_STATES)[number];

export const GOAL_REFUSAL_REASONS = [
  "unauthorized",
  "duplicate_mutation",
  "unresolved_mutation",
] as const;
export type GoalRefusalReason = (typeof GOAL_REFUSAL_REASONS)[number];

/**
 * Typed pause reasons (Phase 5.2, plan §Pause reasons). A `paused` goal
 * ALWAYS carries one of these in `pause_reason` — the union is closed and
 * validated by `pauseGoal`, so the client can branch on it instead of pattern-
 * matching a free string. Grouped by who pauses:
 *
 * - model-authored: `needs_user_input` (the `goal_blocked` control tool).
 * - runner bounds: `setup_timeout`, `budget_exhausted`, `context_overflow`,
 *   `wall_clock_exceeded`, `no_progress`, `needs_mutation_resolution`.
 * - setup/credential: `credentials_required`, `missing_capability`.
 *
 * `needs_authorization` is deliberately absent — L6 rules it out of v1 (the
 * Phase 6 `authorize` interceptor refuses instead of pausing).
 */
export const GOAL_PAUSE_REASONS = [
  "needs_user_input",
  "credentials_required",
  "missing_capability",
  "budget_exhausted",
  "setup_timeout",
  "context_overflow",
  "wall_clock_exceeded",
  "no_progress",
  "needs_mutation_resolution",
] as const;
export type GoalPauseReason = (typeof GOAL_PAUSE_REASONS)[number];

export interface GoalRow {
  id: string;
  owner: string;
  instruction: string;
  status: GoalStatus;
  pause_reason: string | null;
  pause_question: string | null;
  result_summary: string | null;
  failure_reason: string | null;
  /** JSON-encoded todo list. */
  todos: string | null;
  /** JSON-encoded list of authorised tool names. */
  authorised_tools: string | null;
  token_budget: number;
  tokens_spent: number;
  agent_snapshot: string | null;
  pinned_model: string | null;
  /** Per-run wall clock anchor (M3); NULL until then. */
  run_started_ts: number | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expiry: number | null;
  created_ts: number;
  updated_ts: number;
  idempotency_key: string;
}

export interface GoalStepRow {
  id: string;
  goal_id: string;
  seq: number;
  kind: GoalStepKind;
  status: GoalStepStatus;
  mutating: number;
  message_from_seq: number | null;
  message_to_seq: number | null;
  tokens: number;
  created_ts: number;
}

export interface GoalMessageRow {
  id: string;
  goal_id: string;
  seq: number;
  role: string;
  content_json: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  created_ts: number;
}

export interface GoalMutationRow {
  id: string;
  goal_id: string;
  plugin_id: string;
  tool: string;
  args_hash: string;
  state: GoalMutationState;
  step_seq: number | null;
  created_ts: number;
}

export interface GoalRefusalRow {
  id: string;
  goal_id: string;
  step_seq: number;
  tool_call_id: string | null;
  tool: string;
  /** Redacted args (plan §Storage). */
  args_json: string | null;
  reason: GoalRefusalReason;
  created_ts: number;
}
