/**
 * Phase 2.3: max simultaneously ACTIVE goals per owner (decision: 5) —
 * `countActiveGoals` counts `queued` or `running` only (the admission cap;
 * NOT paused — a paused goal does not hold a slot).
 */
export const GOAL_MAX_CONCURRENT_PER_OWNER = 5;
/** Step lease TTL (plan §Step lease: bounds ONE round since beforeModelCall renews). */
export const GOAL_STEP_LEASE_MS = 1_800_000;
/** Message-log compaction bounds (plan §Storage). */
export const GOAL_MESSAGE_MAX = 200;
export const GOAL_MESSAGE_KEEP_RECENT = 20;
