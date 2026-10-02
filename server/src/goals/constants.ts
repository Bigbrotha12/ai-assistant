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

// ── Phase 3.1 / 3.8: M2 global bounds (plan §Global bounds + §Step lease) ──

/**
 * Total steps per goal, across runs. The runner inserts the step row first
 * (its `seq` is the steps-run count) and refuses the step when
 * `seq > GOAL_MAX_STEPS`, failing the goal `failed(step_cap_exceeded)`.
 */
export const GOAL_MAX_STEPS = 10;
/**
 * Consecutive steps with no new `goal_message` append before the goal fails
 * `failed(no_progress)`. Measured as trailing steps whose input range still
 * equals the log's max seq — i.e. steps started since the last append.
 */
export const GOAL_MAX_NO_PROGRESS_STEPS = 3;
/**
 * M2 wall clock, anchored at ADMISSION (`goal.created_ts`), NOT
 * `run_started_ts` (M3's per-run anchor). Sharing the pin's admission
 * instant keeps `setup-wait + round ≤ 540s < 10 min < 15 min pin` regardless
 * of queue latency (waves 3.8).
 */
export const GOAL_MAX_WALL_CLOCK_MS = 10 * 60_000;
/**
 * Setup wait-race deadline: model resolution + pin resolution + MCP binding
 * BEFORE `graph.invoke`. A wait-race, NOT a full cancellation: on timeout the
 * runner aborts the step controller and the resolver signal seam (4.7,
 * plan R8) settles the abandoned setup with an `AbortError`. The underlying
 * DNS query is not AbortSignal-cancellable and may complete in the
 * background; nothing awaits it anymore. A violation fails the goal
 * `failed(setup_timeout)` — it never hangs.
 */
export const GOAL_SETUP_DEADLINE_MS = 120_000;
/**
 * D8 credential lease (plan F1): the goal pin store's flat TTL. A goal holds
 * its credentials for the whole run — the run itself is bounded by the wall
 * clock (10 min M2 / 1h M3), so 3h is generous headroom. Instance-scoped,
 * constructor TTL, no `pins.ts` change, no renewal.
 */
export const GOAL_PIN_TTL_MS = 3 * 60 * 60 * 1000;
/**
 * Re-claim pacing (plan §Step lifecycle): a step attempt rejected before any
 * model call backs off the goal's next re-claim by this base delay,
 * exponential up to [GOAL_RECLAIM_BACKOFF_MAX_MS]. Reset after a step that
 * reached a model call.
 */
export const GOAL_RECLAIM_BACKOFF_MS = 1_000;
export const GOAL_RECLAIM_BACKOFF_MAX_MS = 30_000;
