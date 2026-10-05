import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { createAgentGraph, TOOL_ROUND_LIMIT_MARKER } from "../agents/graph.ts";
import { createTrackedExecution, trackModelExecution } from "../agents/execution.ts";
import type { TrackedExecution } from "../agents/execution.ts";
import {
  bindMcpServers,
  getMcpToolListCache,
  isMcpToolSafeToRepeat,
  mcpToolListCacheKey,
  type McpBinding,
  type McpClientFactory,
} from "../agents/mcp.ts";
import { bindPluginTools } from "../agents/orchestrator.ts";
import {
  AccountDeletedError,
  assertNotDeleting,
  isDeleting,
} from "../account_deletion.ts";
import { PinStoreCredentialResolver } from "../credentials/pin_store.ts";
import type { CredentialPinHandle, CredentialPinStore } from "../credentials/pins.ts";
import { CredentialPinError } from "../credentials/pins.ts";
import { env } from "../env.ts";
import { JobError } from "../jobs/errors.ts";
import { ToolExecutor } from "../jobs/runner.ts";
import type { JobRunnerDeps, NotificationHook } from "../jobs/runner.ts";
import { BudgetExhaustedError, createBudgetManager } from "../middleware/budget.ts";
import { ContextBudgetError } from "../middleware/context.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type { ToolResultCache } from "../middleware/cache.ts";
import type { SentinelShadowSink } from "../sentinel/shadow.ts";
import { tryReportSentinelShadow } from "../sentinel/shadow.ts";
import { buildPipelineForChannel } from "../tools/channel.ts";
import type { ToolPipeline } from "../tools/pipeline.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type { AgentToolAllowlistEntry } from "../plugins/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { redactForOutbound } from "../redact.ts";

import {
  GOAL_MAX_CONCURRENT_PER_OWNER,
  GOAL_MAX_NO_PROGRESS_STEPS,
  GOAL_MAX_STEPS,
  GOAL_MAX_WALL_CLOCK_MS,
  GOAL_RECLAIM_BACKOFF_MAX_MS,
  GOAL_RECLAIM_BACKOFF_MS,
  GOAL_SETUP_DEADLINE_MS,
  GOAL_STEP_LEASE_MS,
} from "./constants.ts";
import {
  CONTROL_TOOL_NAMES,
  buildControlTools as defaultBuildControlTools,
} from "./control.ts";
import type { GoalControlToolContext } from "./control.ts";
import { parseAgentSnapshot } from "./agent_snapshot.ts";
import type { GoalAgentSnapshot } from "./agent_snapshot.ts";
import { GoalError, GoalSetupError, GoalTerminalSignal } from "./errors.ts";
import type { GoalLedger } from "./ledger.ts";
import {
  goalMessageToAppendInput,
  goalMessagesToBaseMessages,
} from "./messages.ts";
import { GOAL_PAUSE_REASONS } from "./types.ts";
import type { GoalPauseReason, GoalRow, GoalStepRow } from "./types.ts";

export { GoalTerminalSignal } from "./errors.ts";
export { GoalError } from "./errors.ts";
export type { GoalErrorCode } from "./errors.ts";
export type { GoalControlToolContext } from "./control.ts";

/**
 * `GoalRunner` (Phase 3.1, plan §Worker) — the durable goal loop. Mirrors
 * `JobRunner`'s shape but NOT its semantics: a goal step is ONE bounded
 * `createAgentGraph(...).invoke()` over an input vector REBUILT from the
 * durable `goal_message` log (no checkpointer, no in-memory conversation
 * across steps). Every step:
 *
 *   1. claims a queued goal (`queued -> running`, fresh lease token) in a
 *      periodic claim pass (single replica; tick latency ≤ `claimIntervalMs`),
 *   2. inserts its `goal_step` row (`running`) and enforces the M2 bounds —
 *      `GOAL_MAX_STEPS`, wall clock from ADMISSION, no-progress — failing the
 *      goal `failed(<reason>)` via `transitGoal` (lease-guarded),
 *   3. resolves the agent snapshot + model plugin + credential pins + tool
 *      bindings under the `GOAL_SETUP_DEADLINE_MS` wait-race (a lost race
 *      aborts the step controller, and the resolver signal seam (4.7)
 *      settles the abandoned setup with an `AbortError`),
 *   4. runs the graph (`maxIterations = 1`); `beforeModelCall` re-checks the
 *      goal's `running` + lease (throwing [GoalTerminalSignal] when a control
 *      tool already committed), renews the lease and re-checks the wall clock
 *      every round,
 *   5. post-checks the goal row — a round whose goal left `running` persists
 *      NOTHING (the control tool's own transaction already wrote its message)
 *      — otherwise appends the produced messages, updates `tokens_spent`, and
 *      closes the step,
 *   6. chains `running -> queued` (lease-releasing CAS) for the next step.
 *
 * Budget (D10): this runner ALWAYS works against its OWN [BudgetManager] —
 * `deps.budget ?? createBudgetManager()` — with its own per-owner pool and its
 * own model-call window. It is never the chat/jobs budget: a saturating goal
 * loop must not starve interactive chat (R10).
 *
 * Credentials (3.2): a DEDICATED [CredentialPinStore] (`deps.pins`) plus the
 * `goalPins` registry owned HERE — `Map<goalId, { owner, handles }>` where
 * `handles` is the plan's `Record<pluginId, handle>`. Admission pins + registers
 * ({@link GoalRunner.registerGoalPin}); the runner resolves its OWN registered
 * handles (handle-addressed, never `pins.find(owner, pluginId)` — the
 * latest-pin fallback could swap a goal's credential under a concurrent job,
 * the exact Phase 0.3 bug class). Entries are released at terminal, cancel,
 * delete and account deletion.
 *
 * Boot recovery ({@link GoalRunner.resumeStuckGoals}): at boot EVERY persisted
 * step lease is dead (single replica) — interrupted steps are marked terminal
 * and `running` goals are requeued so the next claim starts a FRESH step.
 * Restart-resume (D8/Phase 4): the re-claimed goal's setup finds the in-memory
 * registry empty and PAUSES it `paused(credentials_required)` — re-credential
 * via resume, not a failure, not a spin.
 */
export type GoalRunnerDeps = {
  goalLedger: GoalLedger;
  registry: PluginRegistry;
  /**
   * DEDICATED goal credential pin store (3.2) — never the job store: the
   * job path's latest-pin fallback + ref-count release could swap a goal's
   * credential under a concurrent job.
   */
  pins: CredentialPinStore;
  /** SSRF-validated pins per plugin (MCP `agentId:mcp:serverName` keys). */
  getPinnedIps?: JobRunnerDeps["getPinnedIps"];
  /** Model factory seam (same shape as `JobRunnerDeps.buildModel`). */
  buildModel?: JobRunnerDeps["buildModel"];
  /** Shared tool-result cache (fingerprint keys keep goals isolated). */
  toolCache?: ToolResultCache;
  /** Admin-trusted hosts for the default executor's PLUGIN egress. MCP
   * binding always uses `env.MCP_TRUSTED_HOSTS` (mirroring `JobRunner`): the
   * two trust lists are distinct, and conflating them either blocks admin-
   * trusted plugin backends or widens MCP egress. */
  trustedHosts?: readonly string[];
  mcpClientFactory?: McpClientFactory;
  /** Override the default `ToolExecutor` (tests inject a recording fake). */
  executor?: ToolExecutor;
  /**
   * Optional budget override. Absent (production default) → the runner builds
   * its OWN `createBudgetManager()` (D10: isolated pool + model-call window).
   */
  budget?: BudgetManager;
  shadowReporter?: SentinelShadowSink;
  /** Optional dedicated pin-sweep timer; the claim timer also sweeps. */
  sweepIntervalMs?: number;
  /** Claim-pass period (default 2s — M2 tick latency; no event/nudge yet). */
  claimIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Injectable clock (wall-clock bounds vs `goal.created_ts`). */
  now?: () => number;
  /**
   * Test-only override of the setup wait-race deadline
   * (`GOAL_SETUP_DEADLINE_MS`, 3.8). Production leaves it unset; tests shrink it
   * so the abandoned-resolve timeout is observable without a 120s wait.
   */
  setupDeadlineMs?: number;
  toolHandlerTimeoutMs?: number;
  maxToolResultChars?: number;
  /**
   * Phase 3.3 control-tool seam: `update_plan`/`goal_complete` are built from
   * the step's goal + lease and appended to the graph's `tools` array alongside
   * the plugin/MCP tools. Defaults to `goals/control.ts#buildControlTools`;
   * tests may override to script a control transition.
   */
  buildControlTools?: (context: GoalControlToolContext) => StructuredToolInterface[];
  /**
   * Phase 5.5 notification seam (plan L9). Fired when a goal leaves the running
   * loop WITHOUT completing — a pause (it needs the user) or a failure — and
   * only when that transition actually COMMITTED. Never for `complete` (the
   * result is already in the log) and never for a cancel (the user asked for
   * it).
   *
   * Fire-and-forget by design, and deliberately NOT the same as
   * `JobRunner.notify`, which its own task awaits inside a try/catch. Here the
   * push is also not tracked in `inFlight`: a push failure must not change the
   * goal's durable outcome, and third-party egress stays off the step's critical
   * path AND out of the shutdown budget. The consequence is explicit rather
   * than inherited: a push still in flight when `dispose()` runs is detached —
   * shutdown does not wait for it, so it is cut short when the process exits,
   * and the hook (which swallows its own errors) is what keeps that orphan
   * silent. Production wires the same ntfy hook as the job path.
   */
  notification?: NotificationHook;
}

/**
 * Parses the goal's admission-time `authorised_tools` JSON column into a set.
 * The column is written by `getOrCreateGoal` (an array of tool names) and is
 * `NULL` for an M2 goal that authorised nothing. A malformed value, a non-array,
 * or non-string members degrade to the EMPTY set: a parse failure must never
 * WIDEN the tool surface, so it falls back to the M2 read-only-only invariant.
 */
function parseAuthorisedTools(raw: string | null): ReadonlySet<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((name): name is string => typeof name === "string"),
    );
  } catch {
    return new Set();
  }
}

/**
 * The effective tool surface for goal binding: the agent's allowlist narrowed
 * to its read-only entries PLUS the goal's admission-time `authorised_tools`
 * (M4 §goalAuthorised: `allowlist ∩ (readOnly ∪ authorised_tools)`). An
 * authorised write entry is surfaced even though it is not read-only, because
 * the `authorize` interceptor is what refuses an unauthorised mutating call at
 * dispatch time; the surface here only decides what the model may SEE.
 *
 * Entries not read-only and not authorised REMAIN in the agent's allowlist but
 * are inert — the model never sees them. An agent with NO allowlist keeps the
 * binder's documented `allowTools: undefined` semantics (bind every MCP tool);
 * 3.5's per-goal start check is what must reject such a goal.
 */
export function agentAllowlistFilteredReadOnly(
  allowlist: readonly AgentToolAllowlistEntry[] | undefined,
  authorised?: ReadonlySet<string>,
): AgentToolAllowlistEntry[] | undefined {
  if (allowlist === undefined) return undefined;
  return allowlist.filter(
    (entry) => entry.readOnly === true || (authorised?.has(entry.name) ?? false),
  );
}

type GoalSetupValue = {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  mcpBinding?: McpBinding;
  agent: GoalAgentSnapshot;
};

/**
 * How a step ended (Phase 5.2/5.4): a terminal `failed(<reason>)` or a
 * resumable `paused(<reason>)`.
 *
 * The `paused` arm's `reason` is the TYPED [GoalPauseReason] union, which is
 * also what `pauseGoal` validates — so the classifier and the wire vocabulary
 * are one and the same (plan §Pause reasons). The `failed` arm carries the full
 * wire string (`"<reason>: <message>"`), which is how M2's `failure_reason`
 * detail reaches the client.
 */
type GoalStopOutcome =
  | { readonly kind: "paused"; readonly reason: GoalPauseReason }
  | { readonly kind: "failed"; readonly reason: string };

/** True when [value] is a member of the closed pause-reason union. */
function isGoalPauseReason(value: string): value is GoalPauseReason {
  return (GOAL_PAUSE_REASONS as readonly string[]).includes(value);
}

const SETUP_TIMED_OUT = Symbol("goal-setup-timeout");
/** Setup was abandoned because the runner's step controller aborted (dispose or
 * account deletion) — distinct from a real timeout so the runner does not write
 * a spurious `setup_timeout` failure during shutdown. */
const SETUP_ABORTED = Symbol("goal-setup-aborted");

type GoalPinEntry = { owner: string; handles: Record<string, CredentialPinHandle> };

export class GoalRunner {
  private readonly deps: GoalRunnerDeps;
  private readonly budget: BudgetManager;
  private readonly now: () => number;
  /**
   * The `goalPins` registry (3.2): `goalId -> { owner, Record<pluginId,
   * handle> }`. The runner owns the Map (the composition root owns the pin
   * STORE); admission registers through {@link registerGoalPin}.
   */
  private readonly goalPins = new Map<string, GoalPinEntry>();
  private readonly controllers = new Set<AbortController>();
  private readonly controllersByOwner = new Map<string, Set<AbortController>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly reclaimBackoffUntil = new Map<string, number>();
  private readonly reclaimBackoffMs = new Map<string, number>();
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(deps: GoalRunnerDeps) {
    // Boot-asserted invariant (plan §Step lease/bounds arithmetic): the step
    // lease must outlive the worst-case round — setup deadline (120s) +
    // conservative nominal round (840s) + margin. 1800 > 960 holds with 840s
    // of margin. A misconfigured lease that is too short would let a slow
    // round lose its lease mid-step; fail loudly at construction instead.
    if (GOAL_STEP_LEASE_MS <= GOAL_SETUP_DEADLINE_MS + 840_000) {
      throw new Error(
        `GOAL_STEP_LEASE_MS (${GOAL_STEP_LEASE_MS}ms) must exceed ` +
          `GOAL_SETUP_DEADLINE_MS + 840s (${GOAL_SETUP_DEADLINE_MS + 840_000}ms)`,
      );
    }
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    // D10: an isolated budget (own pool + own model-call window) unless the
    // composition root hands one in explicitly (tests).
    this.budget = deps.budget ?? createBudgetManager();
    const setIntervalFn =
      deps.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.claimTimer = setIntervalFn(() => {
      try {
        this.claimPass();
      } catch (err) {
        console.warn("[goals] claim pass failed:", err);
      }
    }, deps.claimIntervalMs ?? 2_000);
    if (typeof this.claimTimer.unref === "function") this.claimTimer.unref();
    if (deps.sweepIntervalMs !== undefined && deps.sweepIntervalMs > 0) {
      this.sweepTimer = setIntervalFn(() => {
        try {
          this.sweepPins();
        } catch (err) {
          console.warn("[goals] pin sweep failed:", err);
        }
      }, deps.sweepIntervalMs);
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }
  }

  // ------------------------------------------------------------ pin registry

  /**
   * Registers a credential pin handle for a goal (3.2). Called by the
   * admission route (3.6) right after `pins.pin(...)` — the handle is the
   * ONLY credential reference the loop will ever read for this goal.
   */
  registerGoalPin(
    goalId: string,
    pluginId: string,
    handle: CredentialPinHandle,
  ): void {
    const goal = this.deps.goalLedger.getGoal(goalId);
    if (!goal) {
      throw new GoalError("GOAL_NOT_FOUND", `goal ${goalId} not found`);
    }
    let entry = this.goalPins.get(goalId);
    if (!entry || entry.owner !== goal.owner) {
      entry = { owner: goal.owner, handles: {} };
      this.goalPins.set(goalId, entry);
    }
    const registered = entry.handles[pluginId];
    if (registered !== undefined && registered !== handle) {
      // Overwriting would strand the previous handle in the pin STORE for the
      // full pin TTL (a resume re-credentials a goal that may still carry a
      // stale admission handle): release it as it is replaced.
      this.deps.pins.release(entry.owner, pluginId, registered);
    }
    entry.handles[pluginId] = handle;
  }

  /** Releases every registered handle of one goal (terminal/cancel/delete). */
  releaseGoalPin(goalId: string): number {
    const entry = this.goalPins.get(goalId);
    if (!entry) return 0;
    this.goalPins.delete(goalId);
    for (const [pluginId, handle] of Object.entries(entry.handles)) {
      this.deps.pins.release(entry.owner, pluginId, handle);
    }
    return Object.keys(entry.handles).length;
  }

  /** Account deletion: drop every registered pin belonging to [owner]. */
  releaseGoalPinsForOwner(owner: string): number {
    let released = 0;
    for (const [goalId, entry] of [...this.goalPins]) {
      if (entry.owner !== owner) continue;
      this.goalPins.delete(goalId);
      for (const [pluginId, handle] of Object.entries(entry.handles)) {
        this.deps.pins.release(owner, pluginId, handle);
        released++;
      }
    }
    // Backstop: drop any store pin of this owner that never reached the
    // registry (admission crashed between pin and register).
    this.deps.pins.releaseOwner(owner);
    return released;
  }

  /** GC for expired credential pins. Also runs on the claim timer. */
  sweepPins(): number {
    return this.deps.pins.sweep();
  }

  // ------------------------------------------------------------- claim loop

  /**
   * One claim pass: sweep pins, then claim queued goals OLDEST-FIRST per
   * owner, up to `GOAL_MAX_CONCURRENT_PER_OWNER` concurrently claimed
   * (running) goals. Claimed goals run their step off the tick (tracked
   * promises), so a slow step never blocks the loop.
   *
   * Concurrency gate (deliberate deviation, see report): the cap gates on the
   * owner's `running` count, NOT `countActiveGoals` (queued+running). The
   * queued+running count is the ADMISSION cap the route enforces; using it as
   * the CLAIM gate would deadlock an owner holding exactly the cap in queued
   * goals (every goal counted "active", nothing claimable, nothing ever
   * runs). `countActiveGoals` therefore stays the route's accessor and this
   * gate bounds CONCURRENT EXECUTION — which is what "claim up to cap minus
   * active" needs.
   */
  private claimPass(): void {
    if (this.disposed) return;
    try {
      this.sweepPins();
    } catch (err) {
      console.warn("[goals] pin sweep failed:", err);
    }
    let queued: GoalRow[];
    try {
      queued = this.deps.goalLedger.listQueuedGoals();
    } catch (err) {
      console.warn("[goals] queued-goal scan failed:", err);
      return;
    }
    for (const goal of queued) {
      if (this.disposed) return;
      if (isDeleting(goal.owner)) continue;
      if (this.backoffPending(goal.id)) continue;
      if (this.runningCountFor(goal.owner) >= GOAL_MAX_CONCURRENT_PER_OWNER) {
        continue;
      }
      let claimed: GoalRow;
      try {
        claimed = this.deps.goalLedger.claimGoal(goal.id, goal.owner);
      } catch (err) {
        if (err instanceof GoalError && err.code === "GOAL_INVALID_TRANSITION") {
          // Already claimed/moved between scan and claim (or rejected before
          // any model call earlier): pace the next re-claim (plan §Re-claim
          // pacing, 1s -> 30s exponential).
          this.bumpBackoff(goal.id);
          continue;
        }
        console.warn(`[goals] claim failed for goal ${goal.id}:`, err);
        continue;
      }
      this.clearBackoff(goal.id);
      this.startStep(claimed);
    }
  }

  private runningCountFor(owner: string): number {
    return this.deps.goalLedger
      .listRunningGoals()
      .filter((goal) => goal.owner === owner).length;
  }

  private backoffPending(goalId: string): boolean {
    const until = this.reclaimBackoffUntil.get(goalId);
    return until !== undefined && this.now() < until;
  }

  private bumpBackoff(goalId: string): void {
    const previous = this.reclaimBackoffMs.get(goalId);
    const delay = Math.min(
      previous === undefined ? GOAL_RECLAIM_BACKOFF_MS : previous * 2,
      GOAL_RECLAIM_BACKOFF_MAX_MS,
    );
    this.reclaimBackoffMs.set(goalId, delay);
    this.reclaimBackoffUntil.set(goalId, this.now() + delay);
  }

  private clearBackoff(goalId: string): void {
    this.reclaimBackoffMs.delete(goalId);
    this.reclaimBackoffUntil.delete(goalId);
  }

  private registerController(owner: string, controller: AbortController): void {
    let byOwner = this.controllersByOwner.get(owner);
    if (!byOwner) {
      byOwner = new Set();
      this.controllersByOwner.set(owner, byOwner);
    }
    byOwner.add(controller);
  }

  private unregisterController(owner: string, controller: AbortController): void {
    const byOwner = this.controllersByOwner.get(owner);
    if (!byOwner) return;
    byOwner.delete(controller);
    if (byOwner.size === 0) this.controllersByOwner.delete(owner);
  }

  private startStep(goal: GoalRow): void {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.registerController(goal.owner, controller);
    const task = this.runStep(goal, controller)
      .catch((err) => {
        console.warn(`[goals] step for goal ${goal.id} crashed:`, err);
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.unregisterController(goal.owner, controller);
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  /** Resolves when every in-flight step has unwound (tests + `dispose`). */
  async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  // ------------------------------------------------------------- step runner

  private async runStep(goal: GoalRow, controller: AbortController): Promise<void> {
    const owner = goal.owner;
    const goalId = goal.id;
    const leaseOwner = goal.lease_owner ?? owner;
    const leaseToken = goal.lease_token ?? "";
    const signal = controller.signal;
    let step: GoalStepRow | undefined;
    let reachedModelCall = false;
    let mcpBinding: McpBinding | undefined;

    try {
      // ── 1. The running step row + M2 bounds. The row is born `running` so a
      //    crash mid-step leaves a findable step for boot recovery; its
      //    from/to record the message-log range this step READS (its input
      //    slice — the full log for M2, see the invoke below).
      const messages = this.deps.goalLedger.listGoalMessages(goalId);
      const firstSeq = messages[0]?.seq;
      const lastSeq = messages[messages.length - 1]?.seq;
      const priorSteps = this.deps.goalLedger.listGoalSteps(goalId);
      const logMaxSeq = lastSeq ?? 0;
      let noProgressSteps = 0;
      for (let i = priorSteps.length - 1; i >= 0; i--) {
        if ((priorSteps[i]!.message_to_seq ?? 0) === logMaxSeq) noProgressSteps++;
        else break;
      }
      step = this.deps.goalLedger.insertGoalStep(goalId, owner, {
        kind: "model",
        mutating: false,
        ...(firstSeq === undefined ? {} : { messageFromSeq: firstSeq }),
        ...(lastSeq === undefined ? {} : { messageToSeq: lastSeq }),
      });

      if (step.seq > GOAL_MAX_STEPS) {
        this.stopGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, {
          kind: "failed",
          reason: "step_cap_exceeded",
        });
        return;
      }
      // 5.2 per-RUN wall clock, anchored at `run_started_ts` (stamped on the first
      // claim of this run; the row just came back from `claimGoal`, so it is
      // always set here). A goal resumed after a long wait gets a fresh budget.
      if (this.now() - this.runStartedAt(goal) > GOAL_MAX_WALL_CLOCK_MS) {
        this.stopGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, {
          kind: "paused",
          reason: "wall_clock_exceeded",
        });
        return;
      }
      if (noProgressSteps >= GOAL_MAX_NO_PROGRESS_STEPS) {
        this.stopGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, {
          kind: "paused",
          reason: "no_progress",
        });
        return;
      }

      const execution = createTrackedExecution(signal);

      // ── 2. Setup under the wait-race (3.8): model + pins + bindings before
      //    any model call. A timeout PAUSES the goal `paused(setup_timeout)`
      //    (5.2: a bound violation is resumable, not terminal) and abandons the
      //    losing promise. The 4.7 resolver signal seam (aborted controller +
      //    `raceWithSignal`) settles that abandoned setup with an `AbortError`;
      //    the underlying DNS query is not cancelled, but nothing awaits it
      //    anymore.
      const setupPromise = this.setupGoalStep(goal, signal, execution, step.seq)
        .then((value) => ({ kind: "ready" as const, value }))
        .catch((error: unknown) => ({ kind: "error" as const, error }));
      const outcome = await waitRace(
        setupPromise,
        this.deps.setupDeadlineMs ?? GOAL_SETUP_DEADLINE_MS,
        signal,
      );
      if (outcome === SETUP_ABORTED) {
        // Dispose / account deletion aborted the step while setup was in
        // flight. Do NOT write a failure (this is not a timeout): leave the
        // step `running` so boot recovery repairs it (or the purge removes it).
        // Still adopt a late-binding MCP handle so it is disposed, not leaked.
        void setupPromise.then((late) => {
          if (late.kind === "ready") void late.value.mcpBinding?.dispose().catch(() => {});
        });
        return;
      }
      if (outcome === SETUP_TIMED_OUT) {
        // 4.7 (plan R8): abort the step controller so the setup the wait-race
        // just abandoned settles promptly — the resolver-level signal seam
        // (`ssrf.ts` `raceWithSignal` + egress `resolvePins`) turns a hung DNS
        // resolve into an `AbortError` instead of a pending promise the runner
        // abandoned. The underlying query is not cancelled (DNS is not
        // AbortSignal-cancellable); nothing awaits it anymore.
        controller.abort(new GoalSetupError("setup_timeout"));
        void setupPromise.then((late) => {
          if (late.kind === "ready") void late.value.mcpBinding?.dispose().catch(() => {});
        });
        this.stopGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, {
          kind: "paused",
          reason: "setup_timeout",
        });
        return;
      }
      if (outcome.kind === "error") {
        // M3 restart-pause mapping (D8): a setup error is classified by
        // `setupFailureOutcomeOf` — a credentials failure (the RAM-only lease
        // registry is empty after a restart, or a pin lapsed) and every other
        // reason on the plan's pause-reason list PAUSE the goal so the client
        // can re-credential or resume; everything else stays terminal
        // `failed(<reason>)`.
        this.stopGoalStep(
          goalId,
          owner,
          step.seq,
          leaseOwner,
          leaseToken,
          setupFailureOutcomeOf(outcome.error),
        );
        return;
      }
      const { model, tools, mcpBinding: binding, agent } = outcome.value;
      mcpBinding = binding;
      trackModelExecution(model, execution);

      // ── 3. Graph: ONE bounded invocation per step (3.8: `maxIterations = 1`).
      //    Control tools (3.3) ride the same `tools` array via the seam.
      const context: GoalControlToolContext = {
        goalId,
        owner,
        leaseOwner,
        leaseToken,
        stepSeq: step.seq,
        goalLedger: this.deps.goalLedger,
      };
      const controlTools = (
        this.deps.buildControlTools ?? defaultBuildControlTools
      )(context);
      const graph = createAgentGraph({
        model,
        tools: [
          // Phase 5.1: the control tools are authoritative on THIS channel.
          // `bindPluginTools` dedupes only *within* the plugin set and
          // `bindMcpServers` gets `excludeToolNames`, so a granted plugin
          // exposing a tool literally named `goal_complete` / `goal_blocked` /
          // `update_plan` is the one remaining way a duplicate name reaches
          // `ToolNode` — the model could then reach the plugin's `func`
          // instead of the control tool and the goal would never pause or
          // complete. Drop the plugin namesake; the control tool below wins.
          ...tools.filter(
            (tool) => !(CONTROL_TOOL_NAMES as readonly string[]).includes(tool.name),
          ),
          ...(mcpBinding?.tools ?? []),
          ...controlTools,
        ],
        ...(agent.systemPrompt === undefined
          ? {}
          : { systemPrompt: agent.systemPrompt }),
        maxIterations: 1,
        beforeModelCall: () =>
          this.beforeModelCall(
            goalId,
            owner,
            leaseOwner,
            leaseToken,
            step!.seq,
            () => {
              reachedModelCall = true;
            },
          ),
        onToolResult: (content, observation) => {
          tryReportSentinelShadow(this.deps.shadowReporter, {
            owner,
            text: content,
            direction: "tool_result",
            requestId: goalId,
            reportKey: `tool:${goalId}:${observation.toolCallId ?? observation.sequence}`,
          });
        },
      });

      // ── 4. Run on the rebuilt input vector. M2 rebuilds the FULL log
      //    (deliberate simplicity vs the message_from_seq..to_seq slice).
      const inputMessages = goalMessagesToBaseMessages(messages);
      const result = await graph.invoke({ messages: inputMessages }, { signal });
      await execution.settle();

      // ── 5. Terminal-flag post-check (3.3's seam): a control tool may have
      //    committed during the tool round — `beforeModelCall` is SKIPPED on
      //    the `toolRounds >= maxIterations` early return, so this re-read is
      //    the final-round guard. Persist NOTHING from such a round.
      const current = this.deps.goalLedger.getGoal(goalId);
      const goalLeftRunning = !current || current.status !== "running";

      // ── 6. Token-guarded bookkeeping: append produced messages (the 2.2
      //    truncation caps the log), update the goal's `tokens_spent`
      //    (per-goal enforcement is M5) and the step's `tokens` (3.6's GET
      //    shape), close the step. SKIPPED entirely when a control tool already
      //    moved the goal: the terminal CAS wrote its own message and this
      //    round's output must not reach the durable log.
      if (!goalLeftRunning) {
        const produced = Array.isArray(result?.messages)
          ? (result.messages as BaseMessage[])
              .slice(inputMessages.length)
              // The orchestrator's `toolRounds >= maxIterations` turn-closer is
              // scaffolding, not model output: persisting it would replay a
              // canned sentence to the model every subsequent step AND count as
              // "progress" for the no-progress bound. Drop it from the log.
              .filter((message) => !isSyntheticToolRoundMessage(message))
          : [];
        let tokens = 0;
        for (const message of produced) {
          const usage = (message as { usage_metadata?: { total_tokens?: number } })
            .usage_metadata;
          if (usage && typeof usage.total_tokens === "number") {
            tokens += usage.total_tokens;
          }
          const input = goalMessageToAppendInput(message);
          if (input === null) continue;
          this.deps.goalLedger.appendGoalMessage(goalId, owner, input);
          tryReportSentinelShadow(this.deps.shadowReporter, {
            owner,
            text: String(
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
            ),
            direction: input.role === "assistant" ? "output" : "tool_result",
            requestId: goalId,
            reportKey: `step:${goalId}:${step.seq}:${message.getType()}`,
          });
        }
        if (tokens > 0) {
          this.deps.goalLedger.addGoalTokens(goalId, owner, tokens);
          this.deps.goalLedger.updateStepTokens(
            goalId,
            owner,
            step.seq,
            tokens,
            leaseOwner,
            leaseToken,
          );
        }
        this.deps.goalLedger.markStepTerminal(goalId, owner, step.seq, leaseOwner, leaseToken);
      }

      // ── 7. Step-end transition (3.4). L12: an unknown mutation
      //    (`pending`/`unresolved`) means the goal must not chain — pause
      //    `needs_mutation_resolution` instead. Otherwise CAS `running ->
      //    queued` (lease-releasing, lease-guarded). A control tool that already
      //    moved the goal makes the chain a documented no-op (`false`), never an
      //    overwrite.
      if (!goalLeftRunning) {
        const paused = this.deps.goalLedger.effectState(goalId) === "unknown"
          ? this.pauseForMutationResolution(goalId, owner, leaseOwner, leaseToken)
          : false;
        if (!paused) {
          const chained = this.deps.goalLedger.chainGoal(
            goalId,
            owner,
            leaseOwner,
            leaseToken,
          );
          if (!chained) this.releaseGoalPin(goalId);
        }
      } else {
        const chained = this.deps.goalLedger.chainGoal(goalId, owner, leaseOwner, leaseToken);
        if (!chained) {
          this.releaseGoalPin(goalId);
          console.warn(
            `[goals] goal ${goalId} left 'running' during its step; output round not chained`,
          );
          // A control tool committed during the round. `goal_blocked` is a
          // pause that NEEDS THE USER and no other path announces it (the
          // step-end CAS is a documented no-op, not a transition of ours), so
          // push here — gated on `paused`, which keeps `goal_complete` and the
          // user's cancel silent exactly as the contract requires.
          const moved = this.deps.goalLedger.getGoal(goalId);
          if (moved?.status === "paused" && moved.pause_reason !== null) {
            this.notifyGoalStopped(goalId, owner, "paused", moved.pause_reason);
          }
        }
      }
    } catch (error) {
      await this.unwindStep(
        error,
        goalId,
        owner,
        leaseOwner,
        leaseToken,
        step,
        () => reachedModelCall,
      );
    } finally {
      // AWAIT the binding teardown: `dispose()` claims the step has reached
      // quiescence (DEFENSIVE_PATTERNS §4), and a fire-and-forget MCP close can
      // outlive `ledger.close()` and hold the process open. `McpBinding.dispose`
      // is internally bounded, so this cannot hang the step.
      await mcpBinding?.dispose().catch((err) => {
        console.warn(`[goals] MCP binding dispose failed for goal ${goalId}:`, err);
      });
    }
  }

  /**
   * `beforeModelCall` (runs before every model call except the
   * `toolRounds >= maxIterations` early return): the `assertDispatch` guard —
   * the goal must still be `running` with THIS step's lease — then the model
   * budget (D10's own window), the per-round lease renewal, and the per-round
   * wall-clock re-check (plan §Step lifecycle #4: a long step cannot overshoot
   * by more than one round).
   */
  private beforeModelCall(
    goalId: string,
    owner: string,
    leaseOwner: string,
    leaseToken: string,
    stepSeq: number,
    markModelCall: () => void,
  ): void {
    const current = this.deps.goalLedger.getGoal(goalId);
    if (!current || current.status !== "running") {
      // Control tool committed / cancel / account deletion: unwind quietly —
      // the runner persists nothing from this round.
      throw new GoalTerminalSignal(goalId, current?.status ?? "missing");
    }
    if (current.lease_owner !== leaseOwner || current.lease_token !== leaseToken) {
      throw new GoalError(
        "GOAL_LEASE_CONFLICT",
        `goal ${goalId} step ${stepSeq} lost its lease before the model call`,
      );
    }
    this.budget.beforeModelCall(owner, "async");
    this.deps.goalLedger.renewGoalLease(goalId, owner, leaseOwner, leaseToken);
    if (this.now() - this.runStartedAt(current) > GOAL_MAX_WALL_CLOCK_MS) {
      this.stopGoalStep(goalId, owner, stepSeq, leaseOwner, leaseToken, {
        kind: "paused",
        reason: "wall_clock_exceeded",
      });
      throw new GoalTerminalSignal(goalId, "paused");
    }
    markModelCall();
  }

  /**
   * Error unwind for a step: typed signals end the step quietly (the control
   * tool / the owner's deletion already committed), a lost lease discards the
   * output, and anything else CHAINS the goal back to `queued` (M2 self-heal,
   * bounded by the no-progress + step caps) — a step rejected before any
   * model call additionally backs off its re-claim.
   */
  private async unwindStep(
    error: unknown,
    goalId: string,
    owner: string,
    leaseOwner: string,
    leaseToken: string,
    step: GoalStepRow | undefined,
    didReachModelCall: () => boolean,
  ): Promise<void> {
    // Close the step row in EVERY unwind path, FIRST. A step left `running`
    // when its goal goes terminal — cancel (`GoalTerminalSignal`), account
    // deletion, or a lost lease — is unrecoverable: boot recovery only scans
    // RUNNING goals. `markStepTerminal` is idempotent, and the lease fence is
    // deliberately omitted: `step.seq` is unique to this run, so closing it
    // from a superseded runner is exactly right and can never close the new
    // owner's step.
    if (step !== undefined) {
      try {
        this.deps.goalLedger.markStepTerminal(goalId, owner, step.seq);
      } catch (err) {
        console.warn(`[goals] failed to close step ${step.seq} of ${goalId}:`, err);
      }
    }
    if (error instanceof GoalTerminalSignal) return;
    if (error instanceof GoalError && error.code === "GOAL_LEASE_CONFLICT") {
      console.warn(`[goals] goal ${goalId} step discarded: lease lost mid-step`);
      return;
    }
    if (error instanceof AccountDeletedError || isDeleting(owner)) {
      this.releaseGoalPin(goalId);
      return;
    }
    const reason = redactForOutbound(errorMessageOf(error));
    console.warn(`[goals] goal ${goalId} step failed (will chain): ${reason}`);
    if (!didReachModelCall()) this.bumpBackoff(goalId);
    try {
      // L12: a step that errored while an unknown mutation exists must pause,
      // not chain. Otherwise re-chain for the next step.
      const paused = this.deps.goalLedger.effectState(goalId) === "unknown"
        ? this.pauseForMutationResolution(goalId, owner, leaseOwner, leaseToken)
        : false;
      if (!paused) {
        const chained = this.deps.goalLedger.chainGoal(goalId, owner, leaseOwner, leaseToken);
        if (!chained) this.releaseGoalPin(goalId);
      }
    } catch (err) {
      console.warn(`[goals] failed to requeue goal ${goalId} after step error:`, err);
    }
  }

  /**
   * Phase 5.2 per-run wall-clock anchor: `goal.run_started_ts`, stamped by
   * `claimGoal` on the first claim of a run. Falls back to `created_ts` ONLY for
   * a row whose anchor is somehow NULL (a pre-5.2 row, or a direct read
   * outside the claim pass) — that keeps the bound finite rather than letting a
   * NULL anchor disable it silently.
   */
  private runStartedAt(goal: GoalRow): number {
    return goal.run_started_ts ?? goal.created_ts;
  }

  /**
   * L12 step-end guard: pauses the goal `needs_mutation_resolution` instead of
   * chaining when `effectState` is `unknown` (any `pending`/`unresolved`
   * mutation — Phase 6 rows; "do not chain", plan §Step lifecycle #6). Uses the
   * same lease-guarded CAS as every control transition, which also CLEARS the
   * lease, so a superseded runner cannot pause a goal it no longer owns.
   * Returns true when the pause committed; a CAS miss is a no-op (`false`),
   * never a throw.
   */
  private pauseForMutationResolution(
    goalId: string,
    owner: string,
    leaseOwner: string,
    leaseToken: string,
  ): boolean {
    try {
      this.deps.goalLedger.transitGoal(goalId, owner, {
        next: "paused",
        reason: "needs_mutation_resolution",
        leaseOwner,
        leaseToken,
      });
      // This pause never routes through `stopGoalStep`, so it announces itself:
      // a goal waiting on the user's resolution of an unknown mutation is
      // exactly the `paused` push plan L9 asks for.
      this.notifyGoalStopped(
        goalId,
        owner,
        "paused",
        "needs_mutation_resolution",
      );
      return true;
    } catch (err) {
      if (
        err instanceof GoalError &&
        (err.code === "GOAL_INVALID_TRANSITION" || err.code === "GOAL_LEASE_CONFLICT")
      ) {
        return false;
      }
      console.warn(
        `[goals] failed to pause goal ${goalId} for mutation resolution:`,
        err,
      );
      return false;
    }
  }

  /**
   * Close the step and move the goal to its typed outcome (Phase 5.2/5.4):
   * `paused(<reason>)` when the outcome is one of [GOAL_PAUSE_REASONS] — a
   * RESUMABLE pause the client re-credentials or answers and continues from —
   * `failed(<reason>)` otherwise.
   *
   * Every caller states the outcome explicitly (Phase 5.4); there is no second
   * string vocabulary to keep in sync. The plan's own split (§Global bounds +
   * §Pause reasons):
   *
   * - pause: `setup_timeout`, `budget_exhausted`, `wall_clock_exceeded`,
   *   `context_overflow`, `no_progress`, `credentials_required`,
   *   `missing_capability`.
   * - fail: `step_cap_exceeded` (the total-step budget is spent — a resume
   *   cannot buy more steps), and every setup/setup-failure reason that is not
   *   on the pause list (e.g. `read_only_invariant_violation`,
   *   `invalid_agent_snapshot`), which are terminal by construction.
   *
   * The push fires ONLY when the transition committed: a CAS miss means some
   * other actor already moved the goal — a cancel the user asked for, an
   * account deletion — and the notification contract forbids pushing for those.
   */
  private stopGoalStep(
    goalId: string,
    owner: string,
    stepSeq: number,
    leaseOwner: string,
    leaseToken: string,
    outcome: GoalStopOutcome,
  ): void {
    let committed = false;
    try {
      this.deps.goalLedger.markStepTerminal(goalId, owner, stepSeq, leaseOwner, leaseToken);
      if (outcome.kind === "paused") {
        this.deps.goalLedger.transitGoal(goalId, owner, {
          next: "paused",
          reason: outcome.reason,
          leaseOwner,
          leaseToken,
        });
      } else {
        this.deps.goalLedger.transitGoal(goalId, owner, {
          next: "failed",
          failureReason: outcome.reason,
          leaseOwner,
          leaseToken,
        });
      }
      committed = true;
    } catch (err) {
      if (!(err instanceof GoalError && err.code === "GOAL_INVALID_TRANSITION")) {
        console.warn(`[goals] failed to stop goal ${goalId} (${outcome.reason}):`, err);
      }
    }
    // Deliberately unconditional (unlike the push below): releasing is
    // idempotent, and on a lost CAS the actor that won the race has usually
    // released already — never releasing would strand a credential pin for the
    // full pin TTL.
    this.releaseGoalPin(goalId);
    if (committed) {
      this.notifyGoalStopped(goalId, owner, outcome.kind, outcome.reason);
    }
  }

  /**
   * Phase 5.5: announce a pause/failure to the owner's push channel. Swallows
   * its own errors (a failed push never rewrites the goal's durable outcome) and
   * never awaits — see [GoalRunnerDeps.notification].
   */
  private notifyGoalStopped(
    goalId: string,
    owner: string,
    status: "paused" | "failed",
    reason: string,
  ): void {
    const notify = this.deps.notification?.notifyGoalStopped;
    if (notify === undefined) return;
    void Promise.resolve()
      .then(() => notify.call(this.deps.notification, owner, goalId, status, reason))
      .catch((err) => {
        console.warn(`[goals] notification hook failed for goal ${goalId}:`, err);
      });
  }

  // ------------------------------------------------------------------ setup

  /**
   * Model + credential-pins + tool bindings for one step. Pins are resolved
   * through a [PinStoreCredentialResolver] over the goal's OWN registered
   * handles (3.2) — absent/expired handles raise `credentials_required`
   * (`CredentialPinError`/`JobError` map there), which the step loop pauses
   * the goal on (M3 restart-pause mapping), never hang.
   */
  private async setupGoalStep(
    goal: GoalRow,
    signal: AbortSignal,
    execution: TrackedExecution,
    stepSeq: number,
  ): Promise<GoalSetupValue> {
    const owner = goal.owner;
    const goalId = goal.id;
    const leaseToken = goal.lease_token ?? "";
    const agent = parseAgentSnapshot(goal.agent_snapshot);
    const authorisedTools = parseAuthorisedTools(goal.authorised_tools);
    // 3.5 fail-loud start check (declared surface, BEFORE any model build or
    // tool bind). The effective MCP surface is `allowlist ∩ (readOnly ∪
    // authorised_tools)`; the plugin grants never ride the allowlist, so a
    // granted non-read-only tool is a violation here UNLESS its name is in the
    // goal's admission-time `authorised_tools` (M4). The MCP declaration is
    // re-asserted defensively (the filter already dropped non-readOnly,
    // non-authorised entries) so a filter regression fails loudly instead of
    // silently binding a write. A violation TERMINATES the goal via
    // `GoalSetupError` — the step never binds, never runs.
    const effectiveAllowlist = agentAllowlistFilteredReadOnly(
      agent.toolAllowlist,
      authorisedTools,
    );
    const declaredViolation = this.findDeclaredReadOnlyViolation(
      agent,
      effectiveAllowlist,
      authorisedTools,
    );
    if (declaredViolation !== null) {
      console.warn(
        `[goals] goal ${goalId} failed read-only invariant (declared surface): ` +
          `${declaredViolation}`,
      );
      throw new GoalSetupError(
        `read_only_invariant_violation: ${declaredViolation}`,
      );
    }
    const modelPluginId = (goal.pinned_model ?? "").trim();
    if (modelPluginId === "") {
      throw new GoalSetupError("plugin_unavailable: goal has no pinned model plugin");
    }
    const entry = this.goalPins.get(goalId);
    if (!entry || entry.handles[modelPluginId] === undefined) {
      throw new GoalSetupError(
        "credentials_required: no registered credential pin for this goal " +
          "(pins die with the process; re-submit the goal with credentials)",
      );
    }
    const resolver = new PinStoreCredentialResolver({
      pins: this.deps.pins,
      owner,
      pinHandles: entry.handles,
      assertActive: () => assertNotDeleting(owner),
    });
    // Handle-addressed reads throw `credentials_expired`/`pin_not_found`
    // (absent) or `CredentialPinError` (expired) — both map to
    // `credentials_required` at the call site. `channel: "job"` because the
    // goal channel's credential resolution uses the pin store (the same
    // fingerprint derivation as the job channel); the `CredentialRequest`
    // union is not widened.
    const modelCredential = resolver.resolve({
      owner,
      pluginId: modelPluginId,
      kind: "model",
      channel: "job",
    });
    if (!this.deps.buildModel) {
      throw new GoalSetupError(
        "plugin_unavailable: no buildModel seam is wired (the transport supplies it)",
      );
    }
    const requestConfig: GoalModelRequestConfig = {
      owner,
      ...(agent.modelRef === undefined ? {} : { requestModel: agent.modelRef }),
      ...(agent.inference === undefined
        ? {}
        : { requestParameters: agent.inference }),
    };
    const model = await this.deps.buildModel(modelPluginId, requestConfig, {
      credentials: modelCredential?.credentials,
      signal,
      assertActive: () => assertNotDeleting(owner),
    });

    const executor = this.deps.executor ?? this.createDefaultExecutor();
    const assertActive = () => assertNotDeleting(owner);
    // ONE goal-channel engine per step (`fence → serialize → authorize → cache
    // → budget → reserve → execution`, plan M4), shared by the plugin and MCP
    // bindings below. The fence closes over THIS step's goal row + lease token;
    // `stepSeq`/`goalLeaseToken` ride every `ToolCall` (set by the binders
    // below).
    const pipeline: ToolPipeline = buildPipelineForChannel("goal", {
      goalLedger: this.deps.goalLedger,
      goalId,
      budget: this.budget,
      ...(this.deps.toolCache === undefined ? {} : { cache: this.deps.toolCache }),
      assertActive,
    });

    // Plugin tools (the agent's `tools` plugin ids), if any. Their credentials
    // resolve through the SAME goal-scoped resolver.
    const pluginIds = (agent.tools ?? []).map((tool) => tool.pluginId);
    const pluginTools =
      pluginIds.length > 0
        ? bindPluginTools(this.deps.registry, executor, pluginIds, {
            owner,
            requestId: goalId,
            channel: "goal",
            goalId,
            stepSeq,
            goalLeaseToken: leaseToken,
            authorisedTools,
            credentialsResolver: resolver,
            pipeline,
            budget: this.budget,
            ...(this.deps.toolCache === undefined
              ? {}
              : { cache: this.deps.toolCache }),
            signal,
            track: (run) => execution.track(run),
            assertActive,
            ...(this.deps.toolHandlerTimeoutMs === undefined
              ? {}
              : { timeoutMs: this.deps.toolHandlerTimeoutMs }),
            ...(this.deps.maxToolResultChars === undefined
              ? {}
              : { maxResultChars: this.deps.maxToolResultChars }),
          })
        : [];

    // MCP tools with the goal's effective surface (allowlist ∩ (readOnly ∪
    // authorised_tools)).
    let mcpBinding: McpBinding | undefined;
    if (agent.mcpServers.length > 0) {
      mcpBinding = await bindMcpServers(agent.mcpServers, {
        owner,
        requestId: goalId,
        signal,
        trustedHosts: env.MCP_TRUSTED_HOSTS,
        clientFactory: this.deps.mcpClientFactory,
        resolvePins: (server) => {
          const agentPluginId = server.id?.trim() || agent.id.trim();
          if (!agentPluginId) return undefined;
          const pinEntry = this.deps.getPinnedIps?.(
            `${agentPluginId}:mcp:${server.name}`,
          )?.[0];
          return pinEntry?.pinned === undefined ? undefined : [...pinEntry.pinned];
        },
        channel: "goal",
        goalId,
        stepSeq,
        goalLeaseToken: leaseToken,
        authorisedTools,
        pipeline,
        budget: this.budget,
        ...(this.deps.toolCache === undefined
          ? {}
          : { toolCache: this.deps.toolCache }),
        assertActive,
        track: (run) => execution.track(run),
        trackUntil: (run, maxDurationMs) => {
          void execution.trackUntil(run, maxDurationMs);
        },
        // Phase 5.1: the control-tool names join the plugin-tool names in the
        // MCP exclusion set. An MCP server exposing a tool literally named
        // `goal_blocked` / `goal_complete` / `update_plan` would otherwise
        // shadow the real control tool — the model would call the wrong `func`
        // and the goal would never pause or complete. The control tools are
        // authoritative, so the MCP namesake is dropped. (`excludeToolNames` is
        // `bindMcpServers`-only; the same drop for PLUGIN tools happens where
        // the graph's `tools` array is assembled — see runStep §3.)
        excludeToolNames: new Set([
          ...pluginTools.map((tool) => tool.name),
          ...CONTROL_TOOL_NAMES,
        ]),
        allowTools: effectiveAllowlist,
        duplicateLogPrefix: "[goals]",
      });
    }
    // 3.5 fail-loud start check (bound MCP surface, post-bind because the
    // server's annotations are only known after listing): replicate the
    // binder's D6 classification over the (process-wide, just-populated)
    // tool-list cache and reject any BOUND MCP tool that is not read-only,
    // UNLESS its name is in `authorised_tools` (M4 — an authorised mutating
    // tool is exactly what the `authorize` interceptor governs at dispatch).
    // This is what catches an allowlist-declared read-only entry the server
    // marks non-read-only/destructive (the "survives filtering as mutating"
    // case). The binding is disposed before the throw so nothing leaks and the
    // graph is never built.
    if (mcpBinding !== undefined) {
      const boundViolation = mcpReadOnlyViolation(
        agent,
        effectiveAllowlist,
        mcpBinding,
        authorisedTools,
      );
      if (boundViolation !== null) {
        await mcpBinding.dispose().catch(() => {});
        mcpBinding = undefined;
        console.warn(
          `[goals] goal ${goalId} failed read-only invariant (bound MCP surface): ` +
            `${boundViolation}`,
        );
        throw new GoalSetupError(
          `read_only_invariant_violation: ${boundViolation}`,
        );
      }
    }
    return { model, tools: pluginTools, mcpBinding, agent };
  }

  /**
   * 3.5 declared-surface check: the first non-read-only, non-authorised tool
   * the goal would bind, or `null` when the declared surface is within the
   * invariant. Plugin grants are checked against the installed registry (the
   * allowlist does not govern plugin tools); the filtered MCP allowlist is
   * re-asserted. A tool is exempt when its name is in the goal's
   * admission-time `authorised_tools` (M4) — the `authorize` interceptor, not
   * this start check, is what refuses an unauthorised mutating call. An absent
   * allowlist is deliberately NOT a pre-bind failure — the MCP surface is then
   * unbounded and is verified post-bind by {@link mcpReadOnlyViolation}.
   */
  private findDeclaredReadOnlyViolation(
    agent: GoalAgentSnapshot,
    effectiveAllowlist: AgentToolAllowlistEntry[] | undefined,
    authorisedTools: ReadonlySet<string>,
  ): string | null {
    const grantedPlugins = new Set((agent.tools ?? []).map((tool) => tool.pluginId));
    if (grantedPlugins.size > 0) {
      for (const plugin of this.deps.registry.listInstalledPlugins()) {
        if (!isToolPlugin(plugin) || !grantedPlugins.has(plugin.id)) continue;
        for (const toolDef of plugin.tools) {
          if (toolDef.readOnly !== true && !authorisedTools.has(toolDef.name)) {
            return toolDef.name;
          }
        }
      }
    }
    for (const entry of effectiveAllowlist ?? []) {
      if (entry.readOnly !== true && !authorisedTools.has(entry.name)) {
        return entry.name;
      }
    }
    return null;
  }

  /**
   * The real executor built from the runner deps (mirrors `JobRunner`'s).
   * `getPinnedIps` defaults to a no-pins resolver so construction never
   * throws; a call with no store pins fails `plugin_unavailable` at call time.
   */
  private createDefaultExecutor(): ToolExecutor {
    return new ToolExecutor({
      registry: this.deps.registry,
      getPinnedIps: this.deps.getPinnedIps ?? (() => undefined),
      trustedHosts: this.deps.trustedHosts,
      ...(this.deps.toolHandlerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.deps.toolHandlerTimeoutMs }),
    });
  }

  // -------------------------------------------------------- boot recovery

  /**
   * Boot recovery (plan §Recovery — one flow): at boot EVERY persisted step
   * lease is dead (single replica). Four phases, in this order:
   *
   *   - **B** — snapshot the set of goals carrying a `pending` mutation
   *     ({@link GoalLedger.listGoalsWithPendingMutations}), FIRST. This phase
   *     fails CLOSED: if the scan throws, recovery writes NOTHING and returns
   *     `{ processed: 0, requeued: 0 }` — the next boot re-scans. Marking a
   *     step terminal or requeueing a goal whose pending set is unknown could
   *     re-run a mutation that may have reached the provider.
   *   - **A** — for each `running` goal, mark its current (last non-terminal)
   *     step terminal.
   *   - **C** — for each running goal, in scan order: adopt its pending
   *     mutations `unresolved` ATOMICALLY with the resulting pause (F5) (a
   *     `pending` row means the reserve committed but the outcome was never
   *     recorded — the request MAY have reached the provider, so it must not be
   *     repeated and must not read as a known-clean state). When ANY row was
   *     adopted the goal MUST NOT be requeued straight into a fresh model round
   *     with full mutation capability; it is PAUSED
   *     `needs_mutation_resolution` instead (the pause clears the lease). A
   *     running goal with nothing to adopt requeues `running -> queued` exactly
   *     as before.
   *   - **D** — for each goal from phase B that is now `paused`, adopt any
   *     stragglers ATOMICALLY with re-tagging it `needs_mutation_resolution`
   *     (clearing any stale question). Running goals were handled in phase C
   *     and are skipped here.
   *
   * The re-claimed goal then pauses `credentials_required` (the `goalPins`
   * registry is in-memory and empty after a restart) — L1's restart-resume per
   * D8/Phase 4: pause, not fail, and no spin.
   *
   * Errors are contained PER GOAL: recovery must never abort boot (the sole
   * exception is the phase-B fail-closed early return above).
   */
  async resumeStuckGoals(): Promise<ResumeStuckGoalsResult> {
    let running: GoalRow[];
    try {
      running = this.deps.goalLedger.listRunningGoals();
    } catch (err) {
      console.warn("[goals] stuck-goal scan failed:", err);
      return { processed: 0, requeued: 0 };
    }
    // Phase B (F2): the pending-mutation scan runs FIRST, BEFORE any step is
    // marked terminal. Recovery fails CLOSED: if the scan throws we know nothing
    // about which goals carry an in-flight `pending` mutation, so we write
    // NOTHING and return 0/0 — the next boot re-scans. Marking steps terminal or
    // requeueing a goal whose pending set is unknown could re-run a step whose
    // mutation actually reached the provider (an at-most-once violation). The
    // early return is idempotent precisely because no state changed.
    let pendingIds = new Set<string>();
    let pendingGoals: GoalRow[] = [];
    try {
      pendingGoals = this.deps.goalLedger.listGoalsWithPendingMutations();
      pendingIds = new Set(pendingGoals.map((goal) => goal.id));
    } catch (err) {
      console.warn("[goals] pending-mutation scan failed:", err);
      return { processed: 0, requeued: 0 };
    }
    // Phase A — mark every interrupted running step terminal. Separate from the
    // adopt/requeue phase so the pending scan above has already decided the
    // fail-closed question before ANY write happens.
    for (const goal of running) {
      try {
        const steps = this.deps.goalLedger.listGoalSteps(goal.id);
        for (const step of steps) {
          if (step.status === "running") {
            this.deps.goalLedger.markStepTerminal(goal.id, goal.owner, step.seq);
          }
        }
      } catch (err) {
        console.warn(`[goals] recovery failed for goal ${goal.id}:`, err);
      }
    }
    // Phase C — adopt/pause/requeue each running goal.
    let requeued = 0;
    for (const goal of running) {
      try {
        if (pendingIds.has(goal.id)) {
          // F5: adopt + pause in ONE ledger transaction (better-sqlite3 nests
          // the ledger's own transactions as SAVEPOINTs). A crash between adopt
          // and pause would strand an `unresolved` row with no `pending` marker,
          // and the next boot would see a "clean" goal and requeue it into a
          // fresh model round — the exact at-most-once violation adoption exists
          // to prevent.
          const adopted = this.deps.goalLedger.transaction(() => {
            const changed = this.deps.goalLedger.adoptPendingMutations(goal.id);
            if (changed > 0) {
              // Plan §Recovery: an interrupted step's adopted mutations mean the
              // goal must NOT requeue into a fresh model round. The lease-omitted
              // CAS pauses it `needs_mutation_resolution` (paused CLEARS the
              // lease) and the adopted rows keep `effectState` `unknown`.
              this.deps.goalLedger.pauseGoal(goal.id, goal.owner, {
                next: "paused",
                reason: "needs_mutation_resolution",
              });
            }
            return changed;
          });
          if (
            adopted === 0 &&
            this.deps.goalLedger.requeueGoal(goal.id, goal.owner)
          ) {
            // Everything was `applied`/`unresolved`/`retryable` already (or
            // resolved concurrently): safe to requeue as before.
            requeued++;
          }
        } else if (this.deps.goalLedger.requeueGoal(goal.id, goal.owner)) {
          requeued++;
        }
      } catch (err) {
        console.warn(`[goals] recovery failed for goal ${goal.id}:`, err);
      }
    }
    // Phase D: paused goals carrying stragglers are re-tagged (and any
    // remaining pending rows adopted). Running goals were handled in phase C.
    for (const goal of pendingGoals) {
      if (goal.status !== "paused") continue;
      try {
        // F5: adopt + re-tag atomically, same rationale as phase C — a crash
        // between them would strand an `unresolved` row on an unre-tagged paused
        // goal the client would never be told to resolve.
        this.deps.goalLedger.transaction(() => {
          const adopted = this.deps.goalLedger.adoptPendingMutations(goal.id);
          if (adopted > 0) {
            this.deps.goalLedger.retagPausedGoal(
              goal.id,
              goal.owner,
              "needs_mutation_resolution",
            );
          }
        });
      } catch (err) {
        console.warn(
          `[goals] recovery re-tag failed for paused goal ${goal.id}:`,
          err,
        );
      }
    }
    return { processed: running.length, requeued };
  }

  // ------------------------------------------------------ account deletion

  /**
   * Account deletion: abort the owner's in-flight steps and CANCEL their
   * running goals (M2 simplest — no requeue-and-cancel dance). Queued/paused
   * goals are purged with the owner's rows by `purgeOwnerData`.
   */
  abortOwner(owner: string): number {
    const byOwner = this.controllersByOwner.get(owner);
    const aborted = byOwner?.size ?? 0;
    if (byOwner) {
      this.controllersByOwner.delete(owner);
      for (const controller of byOwner) {
        if (!controller.signal.aborted) {
          controller.abort(new AccountDeletedError(owner));
        }
      }
    }
    for (const goal of this.deps.goalLedger.listRunningGoals()) {
      if (goal.owner !== owner) continue;
      try {
        // No pause reason: `cancelled` is a terminal status, not a pause (Phase 5.2's
        // validation rejects a reason on any non-paused transition).
        this.deps.goalLedger.transitGoal(goal.id, owner, {
          next: "cancelled",
        });
      } catch (err) {
        console.warn(`[goals] failed to cancel goal ${goal.id} on deletion:`, err);
      }
      this.releaseGoalPin(goal.id);
    }
    return aborted;
  }

  // ---------------------------------------------------------------- dispose

  /**
   * Bounded dispose (DEFENSIVE_PATTERNS §4 — the FIRST promise-returning
   * disposer through `cleanupAsync`): abort every in-flight step controller,
   * clear both timers, then RESOLVE when the in-flight steps' unwind has
   * settled. Genuinely async but bounded: no new work can start (`disposed` +
   * timers gone) and the shared `ShutdownBudget` remainder caps the await.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const clearIntervalFn =
      this.deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    if (this.claimTimer !== null) {
      clearIntervalFn(this.claimTimer);
      this.claimTimer = null;
    }
    if (this.sweepTimer !== null) {
      clearIntervalFn(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const controller of this.controllers) {
      controller.abort(new GoalError("GOAL_INVALID_TRANSITION", "goal runner disposed"));
    }
    this.controllers.clear();
    this.controllersByOwner.clear();
    await this.drainInFlight();
  }
}

/**
 * 3.5 bound-surface check: the first BOUND MCP tool that is not read-only and
 * not in the goal's `authorised_tools` (M4), or `null`.
 *
 * The binder's per-tool D6 classification is not exposed on `McpBinding` (only
 * `tools`), so this re-derives it from the process-wide tool-list cache the
 * just-completed `bindMcpServers` populated. It mirrors the binder's AND-merge
 * EXACTLY (`mcp.ts`'s `toolSafety`, finding M5): for EVERY server exposing a
 * bound name, compute
 *
 *   safe = isMcpToolSafeToRepeat(tool)
 *   if (declaredReadOnly && !explicitlyNotReadOnly && !rawDestructive) safe = true
 *
 * and AND it across all servers — a name any server declares non-repeatable is
 * NEVER read-only, even when the first server to bind it hid the second's
 * `readOnlyHint` from the bound `readOnly` value's first-occurrence read.
 * Checking only the first server's occurrence would fail OPEN on the exact
 * cross-server divergence this guards (server A `readOnlyHint:true` binds
 * first; server B the same name `destructiveHint:true`).
 *
 * Only ACTUALLY-BOUND names are checked (`binding.tools`; control tools never
 * appear there and are therefore excluded). This catches an allowlist-declared
 * read-only entry the server marks non-read-only or destructive, AND an absent
 * allowlist whose full MCP surface binds mutating tools
 * (`isMcpToolSafeToRepeat` is false for every un-annotated MCP tool — Mealie's
 * whole surface). An authorised name is exempt: it is surfaced deliberately and
 * the `authorize` interceptor governs it at dispatch.
 */
function mcpReadOnlyViolation(
  agent: GoalAgentSnapshot,
  effectiveAllowlist: AgentToolAllowlistEntry[] | undefined,
  binding: McpBinding,
  authorisedTools: ReadonlySet<string>,
): string | null {
  if (binding.tools.length === 0) return null;
  const boundNames = new Set(binding.tools.map((tool) => tool.name));
  const allowByName = new Map<string, AgentToolAllowlistEntry>();
  for (const entry of effectiveAllowlist ?? []) allowByName.set(entry.name, entry);
  const cache = getMcpToolListCache();
  // The binder's AND-merge (finding M5): one entry per bounded name, seeded
  // `true` and AND-ed down by every server that exposes the name.
  const safety = new Map<string, boolean>();
  for (const server of agent.mcpServers) {
    const listed = cache.get(mcpToolListCacheKey(server));
    if (listed === undefined) continue;
    for (const tool of listed) {
      if (!tool.name || !boundNames.has(tool.name)) continue;
      const declaredReadOnly = allowByName.get(tool.name)?.readOnly === true;
      const explicitlyNotReadOnly =
        tool.readOnly === false || tool.annotations?.readOnlyHint === false;
      const rawDestructive = tool.annotations?.destructiveHint === true;
      let safe = isMcpToolSafeToRepeat(tool);
      if (declaredReadOnly && !explicitlyNotReadOnly && !rawDestructive) safe = true;
      safety.set(tool.name, (safety.get(tool.name) ?? true) && safe);
    }
  }
  for (const tool of binding.tools) {
    if (authorisedTools.has(tool.name)) continue;
    if (safety.get(tool.name) !== true) return tool.name;
  }
  return null;
}

/** Factory parity with `createJobRunner`; same as `new GoalRunner(deps)`. */
export function createGoalRunner(deps: GoalRunnerDeps): GoalRunner {
  return new GoalRunner(deps);
}

export type ResumeStuckGoalsResult = {
  processed: number;
  requeued: number;
};

/** Same shape as `JobModelRequestConfig` (`transport/chat.ts`) minus the name. */
type GoalModelRequestConfig = {
  owner: string;
  requestModel?: string;
  requestParameters?: Record<string, unknown>;
};

/**
 * A setup deadline is a WAIT-race, not a cancellation (plan §bounds): the
 * loser keeps running (accepted M2 leak). The deadline timer is cleared on
 * settlement and deliberately NOT unref'd (same rationale as `shutdown.ts`'s
 * deadline timer): the losing promise may be handle-less, and an unref'd timer
 * would let Node drain the loop before the deadline fires — skipping exactly
 * the `setup_timeout` failure this race exists to guarantee ("never hangs"
 * means the goal FAILS, not that the process silently exits with the step left
 * `running`). Holding the loop keeps the race alive at most `ms`. The timer is
 * cleared on settlement AND on abort (`signal`): a dispose / account-deletion
 * abort resolves `SETUP_ABORTED` immediately, so shutdown is not delayed up to
 * the full deadline.
 */
async function waitRace<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | typeof SETUP_TIMED_OUT | typeof SETUP_ABORTED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<typeof SETUP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(SETUP_TIMED_OUT), ms);
  });
  const aborted = new Promise<typeof SETUP_ABORTED>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve(SETUP_ABORTED);
      return;
    }
    onAbort = () => resolve(SETUP_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, deadline, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Phase 5.4 (plan M3): map a setup error to the outcome its reason implies.
 * The reason strings are the plan's own vocabulary, and the classifier is the
 * CLOSED [GOAL_PAUSE_REASONS] union itself (via [stopOutcomeOf]): a bare reason
 * on that list becomes a typed PAUSE, anything else stays a terminal
 * `failed(<reason>: <message>)` with the message preserved for the client.
 * There is no second set to keep in sync — that drift is what silently
 * degraded pauses to `failed(...)` before this became structured.
 *
 * This also folds the M3 restart-pause mapping (D8) in: a credentials failure —
 * `CredentialPinError`, a `GoalSetupError` already spelling
 * `credentials_required`, or the `JobError("credentials_expired")` a resumed
 * goal reaches after a restart wipes the RAM-only pin registry — maps to
 * `paused(credentials_required)`, so the goal re-credentials via resume rather
 * than dying or spinning.
 */
function setupFailureOutcomeOf(error: unknown): GoalStopOutcome {
  const message = redactForOutbound(errorMessageOf(error));
  if (error instanceof CredentialPinError) return stopOutcomeOf(`credentials_required: ${message}`);
  if (error instanceof GoalSetupError) return stopOutcomeOf(error.failureReason);
  // A missing model build / plugin is a CAPABILITY gap, not a transient fault:
  // the goal pauses `missing_capability` and resumes once the plugin is set up,
  // instead of dying on a configuration the user can fix.
  if (error instanceof JobError) {
    if (error.code === "credentials_expired") {
      return stopOutcomeOf(`credentials_required: ${message}`);
    }
    if (error.code === "plugin_unavailable") return stopOutcomeOf(`missing_capability: ${message}`);
    if (error.code === "budget_exhausted") return stopOutcomeOf(`budget_exhausted: ${message}`);
    if (error.code === "context_length_exceeded") {
      return stopOutcomeOf(`context_overflow: ${message}`);
    }
    return stopOutcomeOf(`${error.code}: ${message}`);
  }
  if (error instanceof AccountDeletedError) return stopOutcomeOf(`cancelled: ${message}`);
  if (error instanceof BudgetExhaustedError) return stopOutcomeOf(`budget_exhausted: ${message}`);
  if (error instanceof ContextBudgetError) return stopOutcomeOf(`context_overflow: ${message}`);
  return stopOutcomeOf(`setup_failed: ${message}`);
}

/**
 * Split a `"<reason>: <message>"` wire string (or a bare reason) into its
 * outcome: `paused(<reason>)` when the bare reason is a [GoalPauseReason],
 * `failed(<whole string>)` otherwise — so the message survives exactly on the
 * terminal path, where WIRE_SPEC §12's `failureReason` carries it.
 */
function stopOutcomeOf(wire: string): GoalStopOutcome {
  const colon = wire.indexOf(":");
  const reason = colon === -1 ? wire : wire.slice(0, colon);
  return isGoalPauseReason(reason)
    ? { kind: "paused", reason }
    : { kind: "failed", reason: wire };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the orchestrator's synthetic `maxIterations` turn-closer. */
function isSyntheticToolRoundMessage(message: BaseMessage): boolean {
  const kwargs = (message as { additional_kwargs?: Record<string, unknown> })
    .additional_kwargs;
  return kwargs?.["synthetic"] === TOOL_ROUND_LIMIT_MARKER;
}

