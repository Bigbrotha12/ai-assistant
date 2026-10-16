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
 * Phase 5.2 wall clock, measured PER RUN from `goal.run_started_ts` (the first
 * claim of the current run), replacing M2's admission-anchored 10 min. A run is
 * the span between claiming a `paused` goal again and the goal leaving the
 * loop, so time spent WAITING for the user — possibly across a restart — no
 * longer burns a goal's budget; only unattended execution does. 1h is
 * comfortably above `setup-wait (120s) + step lease` and under the D8 pin TTL
 * (`GOAL_PIN_TTL_MS`, 3h), so credentials cannot lapse mid-run.
 */
export const GOAL_MAX_WALL_CLOCK_MS = 60 * 60_000;
/**
 * Setup wait-race deadline: model resolution + pin resolution + MCP binding
 * BEFORE `graph.invoke`. A wait-race, NOT a full cancellation: on timeout the
 * runner aborts the step controller and the resolver signal seam (4.7,
 * plan R8) settles the abandoned setup with an `AbortError`. The underlying
 * DNS query is not AbortSignal-cancellable and may complete in the
 * background; nothing awaits it anymore. A violation PAUSES the goal
 * `paused(setup_timeout)` (5.2: a bound violation is resumable) — it never
 * hangs.
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

// ── Phase 7.1: token accounting enforcement + context guard ──

/**
 * Floor charged to a goal when a CHAINED step attempt produced no durable
 * state and reached no accounting — i.e. the model invoke threw before the
 * success-path charged any actual tokens. Without this, a goal that fails
 * every round before the model call (or before usage is reported) would loop
 * against its budget for free and never trip `budget_exhausted`. It is a
 * FLOOR, never a double charge: a round that charged actual tokens (or a
 * terminal/pause round) records only what it actually spent.
 *
 * Tunable via `GOAL_FAILED_ATTEMPT_TOKEN_ESTIMATE`; this is the default.
 */
export const GOAL_FAILED_ATTEMPT_TOKEN_ESTIMATE = 1_000;

/**
 * Input-vector gate for one goal round (Phase 7.1). After the step input is
 * rebuilt from the durable message log and BEFORE setup/`graph.invoke`, a
 * vector estimated over this many tokens pauses the goal `context_overflow`
 * instead of spending a model call that the provider would reject. Estimated
 * with the shared chars/4 heuristic (`token_estimate.ts`) — approximate by
 * design; the client owns exact accounting.
 *
 * This is a GOAL-LOG PRE-FLIGHT bound, NOT a mirror of the model's context
 * window. Chat's `CONTEXT_TOKEN_LIMIT` (default 32_768) caps a chat request's
 * history; the two are deliberately independent and MUST NOT be tied together:
 * a goal step is one bounded turn over a durable log that may legitimately be
 * compacted differently from a chat session. The provider-side
 * `ContextBudgetError` remains the real backstop at the model's actual context
 * boundary and is classified `context_overflow` by
 * `setupFailureOutcomeOf`/the unwind path.
 *
 * Tunable via `GOAL_CONTEXT_TOKEN_LIMIT` (env); this is the default.
 */
export const GOAL_CONTEXT_TOKEN_LIMIT = 60_000;
