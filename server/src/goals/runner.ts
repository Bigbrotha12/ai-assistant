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
import type { JobRunnerDeps } from "../jobs/runner.ts";
import { BudgetExhaustedError, createBudgetManager } from "../middleware/budget.ts";
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
} from "./constants.ts";
import { buildControlTools as defaultBuildControlTools } from "./control.ts";
import type { GoalControlToolContext } from "./control.ts";
import { parseAgentSnapshot } from "./agent_snapshot.ts";
import type { GoalAgentSnapshot } from "./agent_snapshot.ts";
import { GoalError, GoalSetupError, GoalTerminalSignal } from "./errors.ts";
import type { GoalLedger } from "./ledger.ts";
import {
  goalMessageToAppendInput,
  goalMessagesToBaseMessages,
} from "./messages.ts";
import type { GoalRow, GoalStepRow } from "./types.ts";

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
 *      bindings under the `GOAL_SETUP_DEADLINE_MS` wait-race (a lost race is
 *      an ACCEPTED M2 leak — `resolvePins` has no signal),
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
 * and `running` goals are requeued so the next claim starts a FRESH step. M2's
 * restart then fails the re-claimed goal `credentials_required` (the in-memory
 * registry is empty); real restart-resume is D8/Phase 4.
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
};

/**
 * The M2 effective tool surface for MCP binding: the agent's allowlist
 * narrowed to its read-only entries (waves 3.5: "allowlist ∩ readOnly + the
 * control tools"). Write entries REMAIN in the agent's allowlist but are inert
 * this phase — the model never sees them. An agent with NO allowlist keeps the
 * binder's documented `allowTools: undefined` semantics (bind every MCP tool);
 * 3.5's per-goal start check is what must reject such a goal.
 */
export function agentAllowlistFilteredReadOnly(
  allowlist: readonly AgentToolAllowlistEntry[] | undefined,
): AgentToolAllowlistEntry[] | undefined {
  if (allowlist === undefined) return undefined;
  return allowlist.filter((entry) => entry.readOnly === true);
}

type GoalSetupValue = {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  mcpBinding?: McpBinding;
  agent: GoalAgentSnapshot;
};

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
        this.failGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, "step_cap_exceeded");
        return;
      }
      if (this.now() - goal.created_ts > GOAL_MAX_WALL_CLOCK_MS) {
        this.failGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, "wall_clock_exceeded");
        return;
      }
      if (noProgressSteps >= GOAL_MAX_NO_PROGRESS_STEPS) {
        this.failGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, "no_progress");
        return;
      }

      const execution = createTrackedExecution(signal);

      // ── 2. Setup under the wait-race (3.8): model + pins + bindings before
      //    any model call. A timeout FAILS the goal `failed(setup_timeout)` —
      //    M2 has no pause machinery — and abandons the losing promise (an
      //    ACCEPTED M2 leak; `resolvePins` has no signal).
      const setupPromise = this.setupGoalStep(goal, signal, execution)
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
        void setupPromise.then((late) => {
          if (late.kind === "ready") void late.value.mcpBinding?.dispose().catch(() => {});
        });
        this.failGoalStep(goalId, owner, step.seq, leaseOwner, leaseToken, "setup_timeout");
        return;
      }
      if (outcome.kind === "error") {
        this.failGoalStep(
          goalId,
          owner,
          step.seq,
          leaseOwner,
          leaseToken,
          setupFailureReasonOf(outcome.error),
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
          ...tools,
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
    if (this.now() - current.created_ts > GOAL_MAX_WALL_CLOCK_MS) {
      this.failGoalStep(goalId, owner, stepSeq, leaseOwner, leaseToken, "wall_clock_exceeded");
      throw new GoalTerminalSignal(goalId, "failed");
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

  /** Step failure: close the step and fail the goal `failed(<reason>)`. */
  private failGoalStep(
    goalId: string,
    owner: string,
    stepSeq: number,
    leaseOwner: string,
    leaseToken: string,
    failureReason: string,
  ): void {
    try {
      this.deps.goalLedger.markStepTerminal(goalId, owner, stepSeq, leaseOwner, leaseToken);
      this.deps.goalLedger.transitGoal(goalId, owner, {
        next: "failed",
        failureReason,
        leaseOwner,
        leaseToken,
      });
    } catch (err) {
      if (!(err instanceof GoalError && err.code === "GOAL_INVALID_TRANSITION")) {
        console.warn(`[goals] failed to fail goal ${goalId}:`, err);
      }
    }
    this.releaseGoalPin(goalId);
  }

  // ------------------------------------------------------------------ setup

  /**
   * Model + credential-pins + tool bindings for one step. Pins are resolved
   * through a [PinStoreCredentialResolver] over the goal's OWN registered
   * handles (3.2) — absent/expired handles fail `credentials_required`
   * (`CredentialPinError`/`JobError` map there), never hang.
   */
  private async setupGoalStep(
    goal: GoalRow,
    signal: AbortSignal,
    execution: TrackedExecution,
  ): Promise<GoalSetupValue> {
    const owner = goal.owner;
    const goalId = goal.id;
    const agent = parseAgentSnapshot(goal.agent_snapshot);
    // 3.5 fail-loud start check (declared surface, BEFORE any model build or
    // tool bind). The effective MCP surface is `allowlist ∩ readOnly`; the
    // plugin grants never ride the allowlist, so a granted non-read-only tool
    // is a violation here. The MCP declaration is re-asserted defensively (the
    // filter already dropped non-readOnly entries) so a filter regression fails
    // loudly instead of silently binding a write. A violation TERMINATES the
    // goal via `GoalSetupError` — the step never binds, never runs.
    const effectiveAllowlist = agentAllowlistFilteredReadOnly(agent.toolAllowlist);
    const declaredViolation = this.findDeclaredReadOnlyViolation(
      agent,
      effectiveAllowlist,
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
    // shared selector's channel union is widened in Phase 4.1.
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
    // ONE sync-shaped engine per step (`serialize → cache → budget →
    // execution`, channel "sync-managed" — the correct pre-goal-channel shape
    // for owner-scoped stateful work; there is no fence yet), shared by the
    // plugin and MCP bindings below.
    const pipeline: ToolPipeline = buildPipelineForChannel("sync-managed", {
      budget: this.budget,
      ...(this.deps.toolCache === undefined ? {} : { cache: this.deps.toolCache }),
    });

    // Plugin tools (the agent's `tools` plugin ids), if any. Their credentials
    // resolve through the SAME goal-scoped resolver.
    const pluginIds = (agent.tools ?? []).map((tool) => tool.pluginId);
    const pluginTools =
      pluginIds.length > 0
        ? bindPluginTools(this.deps.registry, executor, pluginIds, {
            owner,
            requestId: goalId,
            channel: "sync-managed",
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

    // MCP tools with the M2 read-only effective surface (allowlist ∩ readOnly).
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
        channel: "sync-managed",
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
        excludeToolNames: new Set(pluginTools.map((tool) => tool.name)),
        allowTools: effectiveAllowlist,
        duplicateLogPrefix: "[goals]",
      });
    }
    // 3.5 fail-loud start check (bound MCP surface, post-bind because the
    // server's annotations are only known after listing): replicate the
    // binder's D6 classification over the (process-wide, just-populated)
    // tool-list cache and reject any BOUND MCP tool that is not read-only.
    // This is what catches an allowlist-declared read-only entry the server
    // marks non-read-only/destructive (the "survives filtering as mutating"
    // case). The binding is disposed before the throw so nothing leaks and the
    // graph is never built.
    if (mcpBinding !== undefined) {
      const boundViolation = mcpReadOnlyViolation(
        agent,
        effectiveAllowlist,
        mcpBinding,
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
   * 3.5 declared-surface check: the first non-read-only tool the goal would
   * bind, or `null` when the declared surface is read-only. Plugin grants are
   * checked against the installed registry (the allowlist does not govern
   * plugin tools); the filtered MCP allowlist is re-asserted. An absent
   * allowlist is deliberately NOT a pre-bind failure — the MCP surface is then
   * unbounded and is verified post-bind by {@link mcpReadOnlyViolation}.
   */
  private findDeclaredReadOnlyViolation(
    agent: GoalAgentSnapshot,
    effectiveAllowlist: AgentToolAllowlistEntry[] | undefined,
  ): string | null {
    const grantedPlugins = new Set((agent.tools ?? []).map((tool) => tool.pluginId));
    if (grantedPlugins.size > 0) {
      for (const plugin of this.deps.registry.listInstalledPlugins()) {
        if (!isToolPlugin(plugin) || !grantedPlugins.has(plugin.id)) continue;
        for (const toolDef of plugin.tools) {
          if (toolDef.readOnly !== true) return toolDef.name;
        }
      }
    }
    for (const entry of effectiveAllowlist ?? []) {
      if (entry.readOnly !== true) return entry.name;
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
   * Boot recovery (plan §Recovery — one flow, M2 shape): at boot EVERY
   * persisted step lease is dead. For each `running` goal: mark its current
   * (last non-terminal) step terminal, then CAS `running -> queued`
   * (lease-agnostic — M2 has no adopted mutations) so the next claim starts a
   * FRESH step. The re-claimed goal then fails `credentials_required` (the
   * `goalPins` registry is in-memory and empty after a restart) — M2 does not
   * satisfy L1's restart-resume (that is D8/Phase 4).
   *
   * Errors are contained PER GOAL: recovery must never abort boot.
   */
  async resumeStuckGoals(): Promise<ResumeStuckGoalsResult> {
    let running: GoalRow[];
    try {
      running = this.deps.goalLedger.listRunningGoals();
    } catch (err) {
      console.warn("[goals] stuck-goal scan failed:", err);
      return { processed: 0, requeued: 0 };
    }
    let requeued = 0;
    for (const goal of running) {
      try {
        const steps = this.deps.goalLedger.listGoalSteps(goal.id);
        for (const step of steps) {
          if (step.status === "running") {
            this.deps.goalLedger.markStepTerminal(goal.id, goal.owner, step.seq);
          }
        }
        if (this.deps.goalLedger.requeueGoal(goal.id, goal.owner)) requeued++;
      } catch (err) {
        console.warn(`[goals] recovery failed for goal ${goal.id}:`, err);
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
        this.deps.goalLedger.transitGoal(goal.id, owner, {
          next: "cancelled",
          reason: "account_deleted",
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
 * 3.5 bound-surface check: the first BOUND MCP tool that is not read-only, or
 * `null`. The binder's per-tool D6 classification is not exposed on
 * `McpBinding` (only `tools`), so this re-derives it from the process-wide
 * tool-list cache the just-completed `bindMcpServers` populated — mirroring
 * `mcp.ts`'s `toolSafety` write exactly:
 *
 *   safe = isMcpToolSafeToRepeat(tool)
 *   if (declaredReadOnly && !explicitlyNotReadOnly && !rawDestructive) safe = true
 *
 * Only ACTUALLY-BOUND names are checked (`binding.tools`; control tools never
 * appear there and are therefore excluded), and the first server to expose a
 * name wins — the binder's plugin-wins/first-MCP tie-break. This is what
 * catches an allowlist-declared read-only entry the server marks non-read-only
 * or destructive, AND an absent allowlist whose full MCP surface binds
 * mutating tools (`isMcpToolSafeToRepeat` is false for every un-annotated MCP
 * tool — Mealie's whole surface).
 */
function mcpReadOnlyViolation(
  agent: GoalAgentSnapshot,
  effectiveAllowlist: AgentToolAllowlistEntry[] | undefined,
  binding: McpBinding,
): string | null {
  if (binding.tools.length === 0) return null;
  const boundNames = new Set(binding.tools.map((tool) => tool.name));
  const allowByName = new Map<string, AgentToolAllowlistEntry>();
  for (const entry of effectiveAllowlist ?? []) allowByName.set(entry.name, entry);
  const cache = getMcpToolListCache();
  const checked = new Set<string>();
  for (const server of agent.mcpServers) {
    const listed = cache.get(mcpToolListCacheKey(server));
    if (listed === undefined) continue;
    for (const tool of listed) {
      if (!tool.name || !boundNames.has(tool.name) || checked.has(tool.name)) {
        continue;
      }
      checked.add(tool.name);
      const declaredReadOnly = allowByName.get(tool.name)?.readOnly === true;
      const explicitlyNotReadOnly =
        tool.readOnly === false || tool.annotations?.readOnlyHint === false;
      const rawDestructive = tool.annotations?.destructiveHint === true;
      let safe = isMcpToolSafeToRepeat(tool);
      if (declaredReadOnly && !explicitlyNotReadOnly && !rawDestructive) safe = true;
      if (!safe) return tool.name;
    }
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
 * Wire `failureReason` for a setup error (M2: bound/setup violations TERMINATE
 * the goal — the pause taxonomy is M3). Credentials failures must "mention
 * credentials" (WIRE_SPEC: `failureReason` is how the client sees them).
 */
function setupFailureReasonOf(error: unknown): string {
  const message = redactForOutbound(errorMessageOf(error));
  if (error instanceof CredentialPinError) return `credentials_required: ${message}`;
  if (error instanceof GoalSetupError) return error.failureReason;
  if (error instanceof JobError) return `${error.code}: ${message}`;
  if (error instanceof AccountDeletedError) return `cancelled: ${message}`;
  if (error instanceof BudgetExhaustedError) return `budget_exhausted: ${message}`;
  return `setup_failed: ${message}`;
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

