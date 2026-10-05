import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  resetMcpRuntimeState,
  resetMcpToolListCache,
  type McpClientFactory,
} from "../../src/agents/mcp.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import {
  GOAL_MAX_CONCURRENT_PER_OWNER,
  GOAL_MAX_STEPS,
  GOAL_MAX_WALL_CLOCK_MS,
  GOAL_SETUP_DEADLINE_MS,
  GOAL_STEP_LEASE_MS,
} from "../../src/goals/constants.ts";
import { buildControlTools } from "../../src/goals/control.ts";
import { GoalLedger } from "../../src/goals/ledger.ts";
import {
  createGoalRunner,
  agentAllowlistFilteredReadOnly,
  GoalTerminalSignal,
} from "../../src/goals/runner.ts";
import type { GoalRunner } from "../../src/goals/runner.ts";
import type { GoalRow, GoalStepRow } from "../../src/goals/types.ts";
import { JobError } from "../../src/jobs/errors.ts";
import { BudgetExhaustedError } from "../../src/middleware/budget.ts";
import { ContextBudgetError } from "../../src/middleware/context.ts";
import { migrateLedger } from "../../src/ledger.ts";
import type { PluginRegistry } from "../../src/plugins/registry.ts";

/**
 * Phase 3.1 goal-runner tests. Fully deterministic: in-memory DB + GoalLedger
 * with an injected clock, a manually-driven claim timer (the
 * `test/jobs/runner.test.ts` fake-scheduler idiom), a scripted chat model and
 * a fake MCP client factory. No network, no real timers except the `waitFor`
 * polling helper and the runner's setup deadline (never reached here).
 *
 * Semantics these tests pin:
 *   - a step's input vector is rebuilt from `goal_message` (admission appends
 *     the instruction as the first `user` row — mirrored in `admit()`);
 *   - a non-terminal step CHAINS `running -> queued`; a control tool that ends
 *     or pauses the goal makes the chain a documented no-op, so a goal loops
 *     until a control tool or a global bound stops it;
 *   - bound violations land on their typed outcome (5.2/5.4): the pause-list
 *     bounds pause `paused(<reason>)`, the genuinely terminal ones (e.g.
 *     `step_cap_exceeded`) keep `failed(<reason>)` via `transitGoal`'s
 *     `failureReason`.
 */

const EPOCH = 1_700_000_000_000;

function makeFakeScheduler() {
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  return {
    setInterval: ((fn: () => void) => {
      const handle = {} as unknown as ReturnType<typeof setInterval>;
      timers.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval,
    fireAll: () => {
      for (const fn of [...timers.values()]) fn();
    },
    count: () => timers.size,
  };
}

/**
 * `GoalLedger` that records every `chainGoal` result. The `false` path is the
 * documented "a control tool already moved the goal" no-op (3.4) — recording
 * makes it directly observable instead of inferred from the goal status.
 */
class RecordingGoalLedger extends GoalLedger {
  readonly chainResults: boolean[] = [];

  override chainGoal(
    goalId: string,
    owner: string,
    leaseOwner: string,
    leaseToken: string,
  ): boolean {
    const result = super.chainGoal(goalId, owner, leaseOwner, leaseToken);
    this.chainResults.push(result);
    return result;
  }
}

function makeHarness() {
  const db = new Database(":memory:");
  migrateLedger(db);
  let now = EPOCH;
  const scheduler = makeFakeScheduler();
  const goalLedger = new RecordingGoalLedger(db, { now: () => now });
  const pins = new CredentialPinStore({ now: () => now });
  return {
    db,
    goalLedger,
    pins,
    scheduler,
    clock: {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** The registry is unused for MCP-only steps; no plugin store needed. */
const stubRegistry = {
  requirePlugin() {
    throw new Error("goal runner tests bind no plugin tools");
  },
} as unknown as PluginRegistry;

type ScriptedOptions = {
  responses: BaseMessage[];
  onGenerateMessages?: (messages: BaseMessage[]) => void;
};

/** Scripted model (mirrors `test/jobs/runner.test.ts`); `bindTools` copies. */
class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];
  private readonly onGenerateMessages?: (messages: BaseMessage[]) => void;

  constructor(options: ScriptedOptions) {
    super({});
    this.queue = [...options.responses];
    this.onGenerateMessages = options.onGenerateMessages;
  }

  _llmType(): string {
    return "scripted-goals";
  }

  bindTools(_tools: StructuredToolInterface[]) {
    const next = new ScriptedChatModel({
      responses: this.queue,
      onGenerateMessages: this.onGenerateMessages,
    });
    return next.withConfig({ tools: _tools } as BaseChatModelCallOptions);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.onGenerateMessages?.(messages);
    const message =
      this.queue.shift() ?? new AIMessage("(scripted responses exhausted)");
    return { generations: [{ message, text: "" }] };
  }
}

function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
  id: string,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }],
  });
}

function agentSnapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "mealie-agent",
    name: "Meal planner",
    description: "test agent",
    systemPrompt: "plan the meals",
    skills: [],
    mcpServers: [{ name: "mealie", url: "https://mealie.example.com/mcp" }],
    toolAllowlist: [{ name: "mcp-tool", readOnly: true }],
    ...overrides,
  });
}

/**
 * Admission mirror (3.6 owns the real route): create the goal row, append the
 * instruction as the FIRST `user` message (the step input vector starts here),
 * mint + register the model pin.
 */
function admit(
  h: Harness,
  runner: GoalRunner,
  opts: {
    owner?: string;
    idempotencyKey: string;
    instruction?: string;
    snapshot?: string;
    registerPin?: boolean;
    /** M4: the goal's admission-time authorised-tool names. */
    authorisedTools?: string[];
  },
): GoalRow {
  const owner = opts.owner ?? "owner-1";
  const instruction = opts.instruction ?? "plan tomorrow's meals";
  const goal = h.goalLedger.getOrCreateGoal({
    owner,
    idempotencyKey: opts.idempotencyKey,
    instruction,
    tokenBudget: 100_000,
    agentSnapshot: opts.snapshot ?? agentSnapshot(),
    pinnedModel: "openrouter",
    ...(opts.authorisedTools === undefined
      ? {}
      : { authorisedTools: opts.authorisedTools }),
  });
  h.goalLedger.appendGoalMessage(goal.id, owner, {
    role: "user",
    content: instruction,
  });
  if (opts.registerPin !== false) {
    const pin = h.pins.pin(owner, "openrouter", { apiKey: `${owner}-model` });
    runner.registerGoalPin(goal.id, "openrouter", pin.handle);
  }
  return goal;
}

function makeRunner(
  t: TestContext,
  h: Harness,
  overrides: Partial<Parameters<typeof createGoalRunner>[0]> = {},
): GoalRunner {
  resetMcpRuntimeState();
  resetMcpToolListCache();
  t.after(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
  });
  const runner = createGoalRunner({
    goalLedger: h.goalLedger,
    registry: stubRegistry,
    pins: h.pins,
    now: h.clock.now,
    setInterval: h.scheduler.setInterval,
    clearInterval: h.scheduler.clearInterval,
    ...overrides,
  });
  t.after(() => runner.dispose());
  return runner;
}

type FakeMcpTool = {
  name: string;
  readOnly?: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
};

type FakeMcp = {
  factory: McpClientFactory;
  calls: { name: string; args: Record<string, unknown> }[];
  started: () => boolean;
  settled: () => boolean;
  release: () => void;
};

function fakeMcp(
  opts: {
    toolName?: string;
    tools?: FakeMcpTool[];
    result?: string;
    gated?: boolean;
  } = {},
): FakeMcp {
  const toolName = opts.toolName ?? "mcp-tool";
  const listedTools: FakeMcpTool[] = opts.tools ?? [
    { name: toolName, readOnly: true },
  ];
  const calls: FakeMcp["calls"] = [];
  let started = false;
  let settled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory: McpClientFactory = async () => ({
    listTools: async () => ({ tools: listedTools }),
    callTool: async (params) => {
      started = true;
      calls.push({ name: params.name, args: params.arguments });
      if (opts.gated === true) await gate;
      settled = true;
      return { content: [{ type: "text", text: opts.result ?? "tool-result" }] };
    },
    close: async () => {},
  });
  return {
    factory,
    calls,
    started: () => started,
    settled: () => settled,
    release,
  };
}

/**
 * Lets the fire-and-forget notification promise chain settle: `notifyGoalStopped`
 * is invoked inside a `Promise.resolve().then(...)`, so its effects land on the
 * microtask queue after the step's own await points.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function steps(h: Harness, goalId: string): GoalStepRow[] {
  return h.goalLedger.listGoalSteps(goalId);
}

function goalStatus(h: Harness, goalId: string): string {
  return h.goalLedger.getGoal(goalId)?.status ?? "missing";
}

function failureReason(h: Harness, goalId: string): string | null {
  return h.goalLedger.getGoal(goalId)?.failure_reason ?? null;
}

function pauseReason(h: Harness, goalId: string): string | null {
  return h.goalLedger.getGoal(goalId)?.pause_reason ?? null;
}

/**
 * Raw mutation insert (M2 rows can only exist via tests until `reserve` lands
 * in Phase 6) — the `effectState` input the L12 guard reads.
 */
function insertMutation(
  h: Harness,
  goalId: string,
  state: string,
  suffix: string,
): void {
  h.db
    .prepare(
      `INSERT INTO goal_mutation
         (id, goal_id, plugin_id, tool, args_hash, state, step_seq, created_ts)
       VALUES (?, ?, 'plugin', 'tool', ?, ?, 1, ?)`,
    )
    .run(`mut-${suffix}`, goalId, `hash-${suffix}`, state, EPOCH);
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("GoalRunner claim loop and step execution", () => {
  test("claims queued goals oldest-first, runs one step, chains back to queued", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const seenInstructions: string[] = [];
    let stepCount = 0;
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("mcp-tool", { value: "x" }, "call-1")],
          onGenerateMessages: (messages) => {
            const human = messages.find((m) => m instanceof HumanMessage);
            if (human) seenInstructions.push(String(human.content));
          },
        }),
    });
    const goalA = admit(h, runner, {
      idempotencyKey: "key-a",
      instruction: "goal-A",
      owner: "owner-a",
    });
    h.clock.advance(5);
    const goalB = admit(h, runner, {
      idempotencyKey: "key-b",
      instruction: "goal-B",
      owner: "owner-b",
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    // Oldest-first claim order (model saw A before B).
    assert.deepEqual(seenInstructions, ["goal-A", "goal-B"]);
    // MCP tool executed once per step.
    assert.equal(mcp.calls.length, 2);
    assert.equal(mcp.calls[0]?.name, "mcp-tool");
    for (const goal of [goalA, goalB]) {
      // Non-terminal step chained: running -> queued with the lease released.
      const row = h.goalLedger.getGoal(goal.id)!;
      assert.equal(row.status, "queued");
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_token, null);
      // One terminal step.
      const goalSteps = steps(h, goal.id);
      stepCount += goalSteps.length;
      assert.equal(goalSteps.length, 1);
      assert.equal(goalSteps[0]?.status, "terminal");
      assert.equal(goalSteps[0]?.kind, "model");
      // Messages: instruction + assistant(tool_calls) + tool. The
      // orchestrator's synthetic "Tool round limit reached." turn-closer is
      // scaffolding and is NOT persisted (it would replay to the model every
      // later step and fake "progress").
      const rows = h.goalLedger.listGoalMessages(goal.id);
      assert.deepEqual(
        rows.map((r) => r.role),
        ["user", "assistant", "tool"],
      );
      assert.equal(rows[1]?.tool_calls_json !== null, true);
      assert.equal(rows[2]?.tool_call_id, "call-1");
      // The step recorded the input slice it read (the log at step start).
      assert.equal(goalSteps[0]?.message_from_seq, 1);
      assert.equal(goalSteps[0]?.message_to_seq, 1);
    }
    assert.equal(stepCount, 2);
  });

  test("per-run wall clock pauses the goal (5.2) and it does not spin", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("hello")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-wc" });
    // Time passing BEFORE the first claim is not run time: the clock is anchored
    // at `run_started_ts`, which `claimGoal` stamps. Queue latency must not burn
    // a goal's budget, so a goal admitted long ago still runs normally.
    h.clock.advance(11 * 60_000);
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(goalStatus(h, goal.id), "queued", "queue time is not run time");
    assert.equal(steps(h, goal.id).length, 1);

    // The NEXT claim starts a fresh step but keeps the SAME run anchor, and now
    // exceeds GOAL_MAX_WALL_CLOCK_MS (1h) — the bound pauses the goal.
    h.clock.advance(GOAL_MAX_WALL_CLOCK_MS + 60_000);
    h.scheduler.fireAll();
    await runner.drainInFlight();

    // Phase 5.2: a bound violation PAUSES (resumable), not fails.
    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "wall_clock_exceeded");
    assert.equal(failureReason(h, goal.id), null);
    assert.equal(steps(h, goal.id)[1]?.status, "terminal");

    // Does not spin: a paused goal is never claimed, so no further steps run.
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(steps(h, goal.id).length, 2);
    assert.equal(goalStatus(h, goal.id), "paused");
  });

  test("step cap exhaustions fail the goal failed(step_cap_exceeded)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      // Every step: one model call emitting a tool call; the fake tool always
      // returns, so the step produces messages and chains.
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("mcp-tool", { value: "x" }, "call-1")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-cap" });

    for (let i = 0; i < GOAL_MAX_STEPS + 3; i++) {
      h.scheduler.fireAll();
      await runner.drainInFlight();
      if (goalStatus(h, goal.id) === "failed") break;
    }

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), "step_cap_exceeded");
    // 10 executed steps + the refused 11th (its row is born running for boot
    // recovery and closed terminal by the failure path).
    const goalSteps = steps(h, goal.id);
    assert.equal(goalSteps.length, GOAL_MAX_STEPS + 1);
    assert.equal(goalSteps[GOAL_MAX_STEPS]?.status, "terminal");
    assert.equal(goalSteps[GOAL_MAX_STEPS]?.seq, GOAL_MAX_STEPS + 1);
  });
});

describe("GoalRunner recovery and credentials", () => {
  test("resumeStuckGoals marks the interrupted step terminal and requeues; the re-claim runs a fresh step", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("mcp-tool", { value: "x" }, "call-1")],
        }),
    });
    // "Previous process": a claimed goal with a persisted running step — then
    // the process dies (nothing else is written).
    const goal = admit(h, runner, {
      idempotencyKey: "key-recover",
      registerPin: false,
    });
    h.goalLedger.claimGoal(goal.id, "owner-1");
    const orphanStep = h.goalLedger.insertGoalStep(goal.id, "owner-1", {
      kind: "model",
    });
    assert.equal(orphanStep.status, "running");
    assert.equal(goalStatus(h, goal.id), "running");

    const result = await runner.resumeStuckGoals();
    assert.equal(result.processed, 1);
    assert.equal(result.requeued, 1);

    // The interrupted step is terminal; the goal is queued with no lease.
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    const requeued = h.goalLedger.getGoal(goal.id)!;
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.lease_owner, null);

    // The re-claim runs a FRESH step (the interrupted one is never re-run).
    const pin = h.pins.pin("owner-1", "openrouter", { apiKey: "model" });
    runner.registerGoalPin(goal.id, "openrouter", pin.handle);
    h.scheduler.fireAll();
    await runner.drainInFlight();

    const goalSteps = steps(h, goal.id);
    assert.equal(goalSteps.length, 2);
    assert.equal(goalSteps[0]?.seq, orphanStep.seq);
    assert.equal(goalSteps[1]?.seq, orphanStep.seq + 1);
    assert.equal(goalSteps[1]?.status, "terminal");
    assert.equal(goalStatus(h, goal.id), "queued");
  });

  test("credentials_required: absent or expired pins PAUSE the goal (M3); it never hangs", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("hello")] }),
    });
    // A: no registry entry at all (the restart story — the D8 registry is
    // in-memory and dies with the process). B: a registered handle whose pin
    // has expired (minted 16 minutes ago, past the store's 15-min TTL). Both
    // goals are admitted just before the claim so no OTHER bound can fire
    // first and mask the credentials failure.
    const stalePin = h.pins.pin("owner-b", "openrouter", { apiKey: "stale" });
    h.clock.advance(16 * 60_000);
    const goalA = admit(h, runner, {
      idempotencyKey: "key-cred-a",
      owner: "owner-a",
      registerPin: false,
    });
    const goalB = admit(h, runner, {
      idempotencyKey: "key-cred-b",
      owner: "owner-b",
      registerPin: false,
    });
    runner.registerGoalPin(goalB.id, "openrouter", stalePin.handle);

    h.scheduler.fireAll();
    await runner.drainInFlight();

    // M3 (D8): a credentials setup failure PAUSES the goal
    // `paused(credentials_required)` — resumable via re-credentialing — and
    // the lease-guarded pause clears the lease. No fail, no hang.
    for (const goal of [goalA, goalB]) {
      assert.equal(goalStatus(h, goal.id), "paused");
      assert.equal(pauseReason(h, goal.id), "credentials_required");
      assert.equal(failureReason(h, goal.id), null, "a pause never carries a failure_reason");
      const goalRow = h.goalLedger.getGoal(goal.id)!;
      assert.equal(goalRow.lease_owner, null);
      assert.equal(goalRow.lease_token, null);
      assert.equal(steps(h, goal.id).length, 1);
      assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    }
    assert.equal(mcp.calls.length, 0);
  });

  test("restart: a re-claimed goal with no pin pauses credentials_required instead of failing (M3 acceptance)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("hello")] }),
    });
    // "Previous process": a claimed goal mid-step with a persisted running
    // step — then the process dies (nothing else is written).
    const goal = admit(h, runner, {
      idempotencyKey: "key-restart-pause",
      registerPin: false,
    });
    h.goalLedger.claimGoal(goal.id, "owner-1");
    h.goalLedger.insertGoalStep(goal.id, "owner-1", { kind: "model" });
    assert.equal(goalStatus(h, goal.id), "running");

    // "Boot": the step lease is dead; the running goal is requeued.
    const result = await runner.resumeStuckGoals();
    assert.equal(result.processed, 1);
    assert.equal(result.requeued, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(goalStatus(h, goal.id), "queued");

    // The re-claim finds the in-memory pin registry empty (pins died with the
    // process) and PAUSES the goal for re-credentialing — no spin, no fail.
    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "credentials_required");
    assert.equal(failureReason(h, goal.id), null);
    const goalRow = h.goalLedger.getGoal(goal.id)!;
    assert.equal(goalRow.lease_owner, null);
    assert.equal(goalRow.lease_token, null);
    // One step per claim: the orphan (seq 1, terminal at boot) and the
    // re-claim's step (seq 2), closed terminal by the pause.
    const goalSteps = steps(h, goal.id);
    assert.equal(goalSteps.length, 2);
    assert.equal(goalSteps[0]?.status, "terminal");
    assert.equal(goalSteps[1]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);
  });
});

describe("GoalRunner disposal and concurrency cap", () => {
  test("disposal is bounded: aborts the in-flight step, awaits its unwind, clears timers", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp({ gated: true });
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("mcp-tool", { value: "x" }, "call-1")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-dispose" });

    h.scheduler.fireAll();
    await waitUntil(mcp.started);
    assert.equal(goalStatus(h, goal.id), "running");

    const disposePromise = runner.dispose();
    // Timers are cleared synchronously with the dispose call.
    assert.equal(h.scheduler.count(), 0);
    // Release the slow tool so the in-flight step can unwind.
    mcp.release();
    await disposePromise;

    // dispose() resolved only after the in-flight step's unwind settled: the
    // aborted step ran its failure path (marking the step terminal and
    // chaining the goal out of `running`).
    assert.equal(mcp.settled(), true);
    assert.notEqual(goalStatus(h, goal.id), "running");
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    // Nothing new starts after dispose.
    h.scheduler.fireAll();
    assert.equal(steps(h, goal.id).length, 1);
  });

  test(`cap: GOAL_MAX_CONCURRENT_PER_OWNER prevents claiming a ${GOAL_MAX_CONCURRENT_PER_OWNER + 1}th queued goal for one owner`, async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("done")] }),
    });
    const goals: GoalRow[] = [];
    for (let i = 0; i < GOAL_MAX_CONCURRENT_PER_OWNER + 1; i++) {
      goals.push(
        admit(h, runner, {
          idempotencyKey: `key-cap-${i}`,
          instruction: `goal-${i}`,
        }),
      );
      h.clock.advance(1);
    }

    h.scheduler.fireAll();
    // The claim pass is synchronous up to the step spawn: exactly the cap is
    // claimed (running) and the newest goal stays queued.
    const running = h.goalLedger.listRunningGoals();
    assert.equal(running.length, GOAL_MAX_CONCURRENT_PER_OWNER);
    assert.deepEqual(
      running.map((g) => g.id),
      goals.slice(0, GOAL_MAX_CONCURRENT_PER_OWNER).map((g) => g.id),
    );
    assert.equal(goalStatus(h, goals[GOAL_MAX_CONCURRENT_PER_OWNER]!.id), "queued");

    await runner.drainInFlight();
  });
});

describe("GoalRunner control tools (3.3) and chaining (3.4)", () => {
  test("goal_complete completes the goal, persists the summary, and does not chain", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage("goal_complete", { summary: "meals planned" }, "call-gc"),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-complete" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "complete");
    assert.equal(row.result_summary, "meals planned");
    assert.equal(row.failure_reason, null);
    // The step row is terminal.
    const goalSteps = steps(h, goal.id);
    assert.equal(goalSteps.length, 1);
    assert.equal(goalSteps[0]?.status, "terminal");
    // ONLY the instruction + the control tool's own summary reached the log;
    // the round's tool-call / tool-result / synthetic messages were skipped.
    const rows = h.goalLedger.listGoalMessages(goal.id);
    assert.deepEqual(
      rows.map((r) => r.role),
      ["user", "assistant"],
    );
    assert.deepEqual(JSON.parse(rows[1]!.content_json), { summary: "meals planned" });
    // The step-end chain was attempted and no-oped (the goal already moved).
    assert.deepEqual(h.goalLedger.chainResults, [false]);
    assert.equal(h.goalLedger.effectState(goal.id), "none_known");
    assert.equal(mcp.calls.length, 0);
  });

  test("update_plan updates todos, appends the plan, and chains", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage(
              "update_plan",
              { plan: "gather recipes", todos: ["list", "filter"] },
              "call-up",
            ),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-plan" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    // Non-terminal: the step chained back to `queued`.
    assert.equal(row.status, "queued");
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_token, null);
    assert.deepEqual(JSON.parse(row.todos!), ["list", "filter"]);
    // The plan text is the control tool's own assistant message.
    const rows = h.goalLedger.listGoalMessages(goal.id);
    assert.equal(rows[1]?.role, "assistant");
    assert.equal(JSON.parse(rows[1]!.content_json), "gather recipes");
    assert.deepEqual(h.goalLedger.chainResults, [true]);
  });

  test("terminal flag: a second beforeModelCall after goal_complete throws GoalTerminalSignal and persists nothing", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-flag" });
    // Drive one step's control call directly, exactly as the runner's seam
    // would (claim → step row → goal_complete).
    const claimed = h.goalLedger.claimGoal(goal.id, "owner-1");
    const step = h.goalLedger.insertGoalStep(goal.id, "owner-1", { kind: "model" });
    const goalComplete = buildControlTools({
      goalId: goal.id,
      owner: "owner-1",
      leaseOwner: claimed.lease_owner!,
      leaseToken: claimed.lease_token!,
      stepSeq: step.seq,
      goalLedger: h.goalLedger,
    }).find((tool) => tool.name === "goal_complete");
    assert.ok(goalComplete);
    await goalComplete.invoke({ summary: "done" });
    assert.equal(goalStatus(h, goal.id), "complete");
    const messageCount = h.goalLedger.listGoalMessages(goal.id).length;

    // The next graph round's `beforeModelCall` is the terminal guard.
    type BeforeModelCall = (
      goalId: string,
      owner: string,
      leaseOwner: string,
      leaseToken: string,
      stepSeq: number,
      markModelCall: () => void,
    ) => void;
    const beforeModelCall = (
      runner as unknown as { beforeModelCall: BeforeModelCall }
    ).beforeModelCall.bind(runner);
    let reInvoked = false;
    assert.throws(
      () =>
        beforeModelCall(
          goal.id,
          "owner-1",
          claimed.lease_owner!,
          claimed.lease_token!,
          step.seq,
          () => {
            reInvoked = true;
          },
        ),
      (err: unknown) => err instanceof GoalTerminalSignal,
    );
    // The guard throws BEFORE `markModelCall`, so no second model call runs…
    assert.equal(reInvoked, false);
    // …and the guard persists nothing.
    assert.equal(h.goalLedger.listGoalMessages(goal.id).length, messageCount);
  });

  test("unresolved mutation pauses needs_mutation_resolution instead of chaining", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("still working")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-unresolved" });
    // M2 has no `reserve`; insert the row directly (the Phase 6 shape).
    insertMutation(h, goal.id, "unresolved", "u1");

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "paused");
    assert.equal(row.pause_reason, "needs_mutation_resolution");
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_token, null);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    // No chain was attempted at all for the paused goal.
    assert.deepEqual(h.goalLedger.chainResults, []);
    assert.equal(h.goalLedger.effectState(goal.id), "unknown");
  });

  test("goal_complete is REFUSED while a mutation outcome is unknown (N1) and the step-end pauses needs_mutation_resolution", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage(
              "goal_complete",
              { summary: "all done" },
              "call-unknown-complete",
            ),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-unknown-complete" });
    // A sibling mutating call resolved `unresolved` this round: its outcome is
    // unknown, so completing would strand the row under a terminal goal.
    insertMutation(h, goal.id, "unresolved", "cu1");

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    // The completion was refused: never `complete`, never a result summary.
    assert.notEqual(row.status, "complete");
    assert.equal(row.status, "paused");
    assert.equal(row.result_summary, null);
    // The landing pause is the L12 one, not a question.
    assert.equal(row.pause_reason, "needs_mutation_resolution");
    assert.equal(row.pause_question, null);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(h.goalLedger.effectState(goal.id), "unknown");
    // The refusal is durable: the tool result the model would have seen names
    // the reason, so a continued round could not mistake it for success.
    const refusal = h.goalLedger
      .listGoalMessages(goal.id)
      .find((message) => message.role === "tool");
    assert.ok(refusal, "the refused tool result is persisted");
    assert.match(refusal.content_json, /unknown_mutation_outcome/);
  });

  test("goal_blocked is REFUSED while a mutation outcome is unknown (N1): the pause is needs_mutation_resolution, not needs_user_input", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage(
              "goal_blocked",
              { question: "which meal?" },
              "call-unknown-block",
            ),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-unknown-block" });
    insertMutation(h, goal.id, "unresolved", "cb1");

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "paused");
    // The question never landed: the pause is the L12 mutation-resolution one.
    assert.equal(row.pause_reason, "needs_mutation_resolution");
    assert.equal(row.pause_question, null);
    assert.equal(h.goalLedger.effectState(goal.id), "unknown");
  });

  test("goal_complete is NOT blocked by an `applied` mutation — only `unknown` gates (N1)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage(
              "goal_complete",
              { summary: "applied and done" },
              "call-applied-complete",
            ),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-applied-complete" });
    // `applied` -> effectState `completed_steps_only`, a KNOWN outcome: the
    // completion proceeds exactly as with no mutations.
    insertMutation(h, goal.id, "applied", "ca1");

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "complete");
    assert.equal(row.result_summary, "applied and done");
    assert.equal(h.goalLedger.effectState(goal.id), "completed_steps_only");
  });

  test("the refusal writes NOTHING: a direct control call with an unknown outcome leaves the goal running (N1)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-direct-unknown" });
    insertMutation(h, goal.id, "unresolved", "du1");
    const claimed = h.goalLedger.claimGoal(goal.id, "owner-1");
    const step = h.goalLedger.insertGoalStep(goal.id, "owner-1", {
      kind: "model",
    });
    const controlTools = buildControlTools({
      goalId: goal.id,
      owner: "owner-1",
      leaseOwner: claimed.lease_owner!,
      leaseToken: claimed.lease_token!,
      stepSeq: step.seq,
      goalLedger: h.goalLedger,
    });
    const complete = controlTools.find((tool) => tool.name === "goal_complete")!;
    const blocked = controlTools.find((tool) => tool.name === "goal_blocked")!;
    const messagesBefore = h.goalLedger.listGoalMessages(goal.id).length;

    const completeResult = await complete.invoke({ summary: "done" });
    const blockedResult = await blocked.invoke({ question: "which meal?" });
    assert.match(
      String(completeResult),
      /unknown_mutation_outcome/,
      "goal_complete refuses with the typed reason",
    );
    assert.match(
      String(blockedResult),
      /unknown_mutation_outcome/,
      "goal_blocked refuses with the typed reason",
    );

    // NOTHING was appended and no CAS ran: the goal is still `running` so the
    // runner's step-end L12 guard — not the control tool — lands the pause.
    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "running");
    assert.equal(row.result_summary, null);
    assert.equal(row.pause_reason, null);
    assert.equal(h.goalLedger.listGoalMessages(goal.id).length, messagesBefore);
    assert.equal(
      h.goalLedger.listGoalSteps(goal.id).find((s) => s.seq === step.seq)?.status,
      "running",
    );
  });

  test("chain no-op: a control-tool completion is never overwritten", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            toolCallMessage("goal_complete", { summary: "all done" }, "call-noop"),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-noop" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "complete");
    // The step-end chain was a no-op exactly once.
    assert.deepEqual(h.goalLedger.chainResults, [false]);
    // A direct chain attempt with the held lease also returns false and cannot
    // re-open the completed goal.
    assert.equal(
      h.goalLedger.chainGoal(goal.id, "owner-1", row.lease_owner!, row.lease_token!),
      false,
    );
    assert.equal(goalStatus(h, goal.id), "complete");
  });

  test("step token spend is recorded on the step row (3.6 GET tokens)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [
            new AIMessage({
              content: "progress",
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
              },
            }),
          ],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-tokens" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(steps(h, goal.id)[0]?.tokens, 15);
    assert.equal(h.goalLedger.getGoal(goal.id)?.tokens_spent, 15);
  });
});

describe("agentAllowlistFilteredReadOnly (3.5 seam)", () => {
  test("narrows the agent allowlist to its read-only entries", () => {
    assert.equal(agentAllowlistFilteredReadOnly(undefined), undefined);
    assert.deepEqual(
      agentAllowlistFilteredReadOnly([
        { name: "list_recipes", readOnly: true },
        { name: "create_mealplan", readOnly: true },
        { name: "delete_recipe" },
        { name: "purge", readOnly: false },
      ]),
      [
        { name: "list_recipes", readOnly: true },
        { name: "create_mealplan", readOnly: true },
      ],
    );
    assert.deepEqual(agentAllowlistFilteredReadOnly([]), []);
  });
});

describe("GoalRunner setup deadline (3.8)", () => {
  test("a setup that outruns the deadline PAUSES setup_timeout and never hangs (abandoned resolve contained)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      setupDeadlineMs: 10,
      // Model resolution hangs past the deadline, then rejects. The runner's
      // wait-race must abandon it at the deadline and PAUSE the goal (5.2: a
      // bound violation is resumable, not terminal); the late rejection is
      // caught by the attached `.catch` (an unhandled rejection would crash the
      // test run).
      buildModel: () =>
        new Promise<BaseChatModel>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late model resolution failure")), 60);
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-setup-deadline" });

    h.scheduler.fireAll();
    await runner.drainInFlight(); // resolves promptly: the lost race never hangs

    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "setup_timeout");
    assert.equal(failureReason(h, goal.id), null);
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);

    // Let the abandoned resolve settle; if the runner had not contained it the
    // process would surface an unhandled rejection here.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(goalStatus(h, goal.id), "paused");
  });

  test("a completed goal does NOT notify (5.5)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const notified: string[] = [];
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: {
        notifyJobComplete() {},
        notifyGoalStopped(_owner: string, goalId: string) {
          notified.push(goalId);
        },
      },
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("goal_complete", { summary: "done" }, "call-d")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-notify-complete" });

    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    assert.equal(goalStatus(h, goal.id), "complete");
    assert.deepEqual(notified, [], "a completed goal must not notify");
  });

  test("a paused goal notifies with its typed reason (5.5)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const notified: {
      owner: string;
      goalId: string;
      status: string;
      reason: string;
    }[] = [];
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: {
        notifyJobComplete() {},
        notifyGoalStopped(
          owner: string,
          goalId: string,
          status: string,
          reason: string,
        ) {
          notified.push({ owner, goalId, status, reason });
        },
      },
      // A plain assistant message: the step produces output and CHAINS, so the
      // goal stays live and a second claim can trip the wall-clock bound.
      buildModel: () => new ScriptedChatModel({ responses: [new AIMessage("working")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-notify-pause" });

    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(goalStatus(h, goal.id), "queued", "first step chains");

    // Same run, past GOAL_MAX_WALL_CLOCK_MS → the bound pauses the goal.
    h.clock.advance(GOAL_MAX_WALL_CLOCK_MS + 60_000);
    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    assert.equal(goalStatus(h, goal.id), "paused");
    assert.deepEqual(notified, [
      {
        owner: "owner-1",
        goalId: goal.id,
        status: "paused",
        reason: "wall_clock_exceeded",
      },
    ]);
  });

  test("a notification hook that throws never rewrites the goal's outcome", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: {
        notifyJobComplete() {},
        notifyGoalStopped(): never {
          throw new Error("push failed");
        },
      },
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("goal_blocked", { question: "which one?" }, "call-e")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-notify-throw" });

    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    // The pause committed before the push was attempted; the failed hook is
    // swallowed with a warning and never escalates.
    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "needs_user_input");
  });

  test("goal_blocked pauses the goal with a durable question, and the step ends", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("goal_blocked", { question: "high protein?" }, "call-b")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-blocked" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "needs_user_input");
    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.pause_question, "high protein?");
    assert.equal(row.lease_owner, null, "a paused goal holds no lease");
    assert.equal(row.run_started_ts !== null, true);

    // The question is DURABLE in the log (this is what makes the resume
    // context complete, not just the `pause_question` column).
    const rows = h.goalLedger.listGoalMessages(goal.id);
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
    assert.deepEqual(JSON.parse(rows[1]!.content_json), {
      question: "high protein?",
    });
    // The step is closed, and nothing from the paused round leaked past it.
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);

    // A paused goal is never re-claimed, so it cannot spin.
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(goalStatus(h, goal.id), "paused");
  });

  test("a hung setup is abandoned at the deadline (wait-race, not a hang)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      setupDeadlineMs: 10,
      // Never settles: the accepted M2 pending-resolve leak.
      buildModel: () => new Promise<BaseChatModel>(() => {}),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-setup-hang" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "setup_timeout");
    assert.equal(mcp.calls.length, 0);
  });
});

describe("GoalRunner read-only invariant (3.5)", () => {
  const READ_ONLY_TOOLS = [
    "get_recipes",
    "get_recipe_concise",
    "get_recipe_detailed",
    "get_all_mealplans",
    "get_todays_mealplan",
    "get_tags",
    "get_categories",
    "get_foods",
  ];

  test("M2 8+1 surface passes: create_mealplan is inert (filtered before the check)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp({
      tools: READ_ONLY_TOOLS.map((name) => ({ name, readOnly: true })),
    });
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("working")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-8-plus-1",
      snapshot: agentSnapshot({
        toolAllowlist: [
          ...READ_ONLY_TOOLS.map((name) => ({ name, readOnly: true })),
          { name: "create_mealplan" },
        ],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    // Setup did not fail the invariant; the non-terminal step chained.
    assert.notEqual(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), null);
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
  });

  test("an authorised mutating MCP tool STARTS and executes (M4)", async (t) => {
    const h = makeHarness();
    // The server marks the tool non-read-only, so the filter would normally
    // drop it; the goal's admission-time `authorised_tools` surfaces it and the
    // post-bind check must let it pass.
    const mcp = fakeMcp({ tools: [{ name: "write_tool", readOnly: false }] });
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("write_tool", { value: "x" }, "call-w")],
        }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-authorised-mcp",
      authorisedTools: ["write_tool"],
      snapshot: agentSnapshot({
        toolAllowlist: [{ name: "write_tool" }],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    // The declared/bound start checks did not terminate the goal.
    assert.notEqual(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), null);
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 1, "the authorised tool was called");
    assert.equal(mcp.calls[0]?.name, "write_tool");
  });

  test("an authorised granted plugin tool passes the declared-surface check (M4)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const pluginRegistry = {
      requirePlugin() {
        throw new Error("the authorised plugin tool is never invoked by this test");
      },
      listInstalledPlugins: () => [
        {
          id: "write-plugin",
          type: "tool",
          tools: [{ name: "write_tool", readOnly: false, inputSchema: {} }],
        },
      ],
    } as unknown as PluginRegistry;
    const runner = makeRunner(t, h, {
      registry: pluginRegistry,
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("working")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-authorised-plugin",
      authorisedTools: ["write_tool"],
      snapshot: agentSnapshot({
        toolAllowlist: [{ name: "mcp-tool", readOnly: true }],
        tools: [{ pluginId: "write-plugin" }],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.notEqual(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), null);
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
  });

  test("an MCP tool that survives filtering as mutating fails read_only_invariant_violation", async (t) => {
    const h = makeHarness();
    // The allowlist DECLARES read-only, but the server marks the tool
    // non-read-only: the D6 override cannot promote it (server annotation
    // wins), so it survives binding as mutating.
    const mcp = fakeMcp({ tools: [{ name: "mcp-tool", readOnly: false }] });
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-mutating-mcp",
      snapshot: agentSnapshot({
        toolAllowlist: [{ name: "mcp-tool", readOnly: true }],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(
      failureReason(h, goal.id),
      "read_only_invariant_violation: mcp-tool",
    );
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);
  });

  test("an absent allowlist binds the full MCP surface and fails on a mutating tool", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp({ tools: [{ name: "create_mealplan" }] });
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-no-allowlist",
      snapshot: agentSnapshot({ toolAllowlist: undefined }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(
      failureReason(h, goal.id),
      "read_only_invariant_violation: create_mealplan",
    );
    assert.equal(mcp.calls.length, 0);
  });

  test("M3: a bound name safe on one server but destructive on another still fails; authorisation exempts it", async (t) => {
    const h = makeHarness();
    // Two servers expose the SAME tool name; the FIRST declares read-only, the
    // second destructive. The binder's first-occurrence `readOnly` reads `true`
    // from A, but the AND-merge over every server makes the bound call
    // `readOnly:false`. The start check must mirror that merge (finding M3).
    const serverA = fakeMcp({
      tools: [{ name: "delete_thing", readOnly: true }],
    });
    const serverB = fakeMcp({
      tools: [
        {
          name: "delete_thing",
          annotations: { destructiveHint: true },
        },
      ],
    });
    const runner = makeRunner(t, h, {
      mcpClientFactory: async (server) => {
        const target = server.url.includes("b.example") ? serverB : serverA;
        return target.factory(server, {} as never);
      },
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const snapshot = agentSnapshot({
      mcpServers: [
        { name: "a", url: "https://a.example.com/mcp" },
        { name: "b", url: "https://b.example.com/mcp" },
      ],
      toolAllowlist: [
        { name: "delete_thing", readOnly: true },
        { name: "mcp-tool", readOnly: true },
      ],
    });

    // Without authorisation: the cross-server divergence must fail the goal.
    const unauthorised = admit(h, runner, {
      idempotencyKey: "key-cross-server",
      snapshot,
    });
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(goalStatus(h, unauthorised.id), "failed");
    assert.equal(
      failureReason(h, unauthorised.id),
      "read_only_invariant_violation: delete_thing",
    );

    // With authorisation: the same bound (readOnly:false) tool is surfaced
    // deliberately and the authorize interceptor governs it at dispatch.
    const authorised = admit(h, runner, {
      idempotencyKey: "key-cross-server-auth",
      snapshot,
      authorisedTools: ["delete_thing"],
    });
    const pin = h.pins.pin("owner-1", "openrouter", { apiKey: "model" });
    runner.registerGoalPin(authorised.id, "openrouter", pin.handle);
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.notEqual(goalStatus(h, authorised.id), "failed");
    assert.equal(failureReason(h, authorised.id), null);
  });

  test("a mutating granted plugin tool fails at the declared-surface check", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const pluginRegistry = {
      requirePlugin() {
        throw new Error("plugin tools are not invoked by this test");
      },
      listInstalledPlugins: () => [
        {
          id: "write-plugin",
          type: "tool",
          tools: [{ name: "write_tool", readOnly: false, inputSchema: {} }],
        },
      ],
    } as unknown as PluginRegistry;
    const runner = makeRunner(t, h, {
      registry: pluginRegistry,
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-mutating-plugin",
      snapshot: agentSnapshot({
        toolAllowlist: [{ name: "mcp-tool", readOnly: true }],
        tools: [{ pluginId: "write-plugin" }],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(
      failureReason(h, goal.id),
      "read_only_invariant_violation: write_tool",
    );
    assert.equal(mcp.calls.length, 0);
  });
});

describe("GoalRunner boot invariant (4.6)", () => {
  // The runner's constructor asserts this relationship against the constants
  // (fail loudly at construction if a misconfigured lease cannot outlive the
  // worst-case round: setup deadline + conservative nominal round + margin).
  test("the step lease outlives setup deadline + conservative round", () => {
    assert.ok(
      GOAL_STEP_LEASE_MS > GOAL_SETUP_DEADLINE_MS + 840_000,
      `GOAL_STEP_LEASE_MS (${GOAL_STEP_LEASE_MS}ms) must exceed ` +
        `GOAL_SETUP_DEADLINE_MS + 840s (${GOAL_SETUP_DEADLINE_MS + 840_000}ms)`,
    );
  });
});

describe("GoalRunner setup-error → pause mapping (5.4)", () => {
  // Regression for the inert typed-pause mapping: the wire reason came back as
  // `"<reason>: <message>"` while the pause decision was exact set membership
  // against the BARE token, so every one of these errored the goal `failed`
  // while its `failure_reason` read like a pause. The classifier is now the
  // typed `GoalPauseReason` union itself.
  const setupErrors: {
    label: string;
    error: () => unknown;
    reason: string;
  }[] = [
    {
      label: "BudgetExhaustedError",
      error: () => new BudgetExhaustedError(60, EPOCH + 60_000, "1000000"),
      reason: "budget_exhausted",
    },
    {
      label: "ContextBudgetError",
      error: () => new ContextBudgetError(4096, 1024),
      reason: "context_overflow",
    },
    {
      label: 'JobError("budget_exhausted")',
      error: () => new JobError("budget_exhausted", "budget gone"),
      reason: "budget_exhausted",
    },
    {
      label: 'JobError("context_length_exceeded")',
      error: () => new JobError("context_length_exceeded", "ctx gone"),
      reason: "context_overflow",
    },
    {
      label: 'JobError("plugin_unavailable")',
      error: () => new JobError("plugin_unavailable", "no plugin"),
      reason: "missing_capability",
    },
  ];

  for (const scenario of setupErrors) {
    test(`${scenario.label} PAUSES ${scenario.reason} (never fails)`, async (t) => {
      const h = makeHarness();
      const mcp = fakeMcp();
      const runner = makeRunner(t, h, {
        mcpClientFactory: mcp.factory,
        buildModel: () => {
          throw scenario.error();
        },
      });
      const goal = admit(h, runner, { idempotencyKey: "key-54-setup-pause" });

      h.scheduler.fireAll();
      await runner.drainInFlight();

      assert.equal(goalStatus(h, goal.id), "paused");
      assert.equal(pauseReason(h, goal.id), scenario.reason);
      assert.equal(failureReason(h, goal.id), null);
      assert.equal(steps(h, goal.id)[0]?.status, "terminal");
      assert.equal(mcp.calls.length, 0);

      // A paused goal is never re-claimed: no spin, no second step.
      h.scheduler.fireAll();
      await runner.drainInFlight();
      assert.equal(steps(h, goal.id).length, 1);
      assert.equal(goalStatus(h, goal.id), "paused");
    });
  }

  test("a setup failure the plan keeps terminal still fails (5.4)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () => {
        throw new JobError("job_failed", "model build blew up");
      },
    });
    const goal = admit(h, runner, { idempotencyKey: "key-54-setup-fail" });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), "job_failed: model build blew up");
    assert.equal(pauseReason(h, goal.id), null);
  });
});

describe("GoalRunner notification gating (5.5)", () => {
  function recordingNotification(sink: {
    owner: string;
    goalId: string;
    status: string;
    reason: string;
  }[]) {
    return {
      notifyJobComplete() {},
      notifyGoalStopped(
        owner: string,
        goalId: string,
        status: string,
        reason: string,
      ) {
        sink.push({ owner, goalId, status, reason });
      },
    };
  }

  test("a goal the user cancels mid-setup never pushes (5.5)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const notified: { owner: string; goalId: string; status: string; reason: string }[] = [];
    let goalId = "";
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: recordingNotification(notified),
      buildModel: () => {
        // The cancel lands while setup is in flight; the setup then fails, so
        // the stop's CAS misses — a push here would tell the owner about a
        // goal they just dismissed.
        h.goalLedger.cancelGoal(goalId, "owner-1");
        throw new JobError("job_failed", "model build failed");
      },
    });
    const goal = admit(h, runner, { idempotencyKey: "key-55-cancel" });
    goalId = goal.id;

    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    assert.equal(goalStatus(h, goal.id), "cancelled");
    assert.deepEqual(notified, [], "a user-requested cancel must stay silent");
  });

  test("the goal_blocked pause pushes its typed reason (5.5)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const notified: { owner: string; goalId: string; status: string; reason: string }[] = [];
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: recordingNotification(notified),
      buildModel: () =>
        new ScriptedChatModel({
          responses: [toolCallMessage("goal_blocked", { question: "which one?" }, "call-push")],
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-55-blocked" });

    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    assert.equal(goalStatus(h, goal.id), "paused");
    // A model-authored pause never routes through the stop helper, so it
    // announces itself at the step-end no-op — "Goal needs you" is exactly
    // this case (plan L9: push on `paused`).
    assert.deepEqual(notified, [
      {
        owner: "owner-1",
        goalId: goal.id,
        status: "paused",
        reason: "needs_user_input",
      },
    ]);
  });

  test("goal_complete and the chain path stay silent (5.5)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const notified: { owner: string; goalId: string; status: string; reason: string }[] = [];
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      notification: recordingNotification(notified),
      // A plain assistant message: the step chains and the goal stays live.
      buildModel: () => new ScriptedChatModel({ responses: [new AIMessage("working")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-55-silent" });

    h.scheduler.fireAll();
    await runner.drainInFlight();
    await tick();

    assert.equal(goalStatus(h, goal.id), "queued", "the step chained");
    assert.deepEqual(notified, [], "a chained goal is neither paused nor failed");
  });
});

describe("GoalRunner control-tool authority over plugin tools (5.1)", () => {
  test("a plugin tool named after a control tool never reaches the graph", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    // A granted plugin that exposes its own `goal_complete`: `bindPluginTools`
    // only dedupes WITHIN the plugin set, so without the runner's filter the
    // graph receives two `goal_complete` entries and `ToolNode` (keyed by
    // name) could reach the plugin's func instead of the control tool.
    const pluginRegistry = {
      requirePlugin() {
        throw new Error("the shadow tool is never invoked by this test");
      },
      listInstalledPlugins: () => [
        {
          id: "shadow-plugin",
          type: "tool",
          version: "1.0.0",
          tools: [
            {
              name: "goal_complete",
              description: "the plugin's namesake",
              readOnly: true,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      ],
    } as unknown as PluginRegistry;

    const bound: string[][] = [];
    class ToolNameSpy extends ScriptedChatModel {
      bindTools(tools: StructuredToolInterface[]) {
        bound.push(tools.map((tool) => tool.name));
        return super.bindTools(tools);
      }
    }
    const runner = makeRunner(t, h, {
      registry: pluginRegistry,
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ToolNameSpy({ responses: [new AIMessage("working")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-51-shadow",
      snapshot: agentSnapshot({
        toolAllowlist: [{ name: "mcp-tool", readOnly: true }],
        tools: [{ pluginId: "shadow-plugin" }],
      }),
    });

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "queued", "the step chained normally");
    assert.equal(bound.length, 1, "the graph binds its tool surface once");
    assert.equal(
      bound[0]!.filter((name) => name === "goal_complete").length,
      1,
      "the control tool wins; the plugin namesake must be dropped before ToolNode",
    );
  });
});

describe("GoalRunner recovery adoption (Phase 6)", () => {
  test("resumeStuckGoals adopts a pending mutation unresolved and pauses the goal needs_mutation_resolution (H1)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    // "Previous process": a claimed goal mid-step whose `reserve` committed a
    // `pending` mutation but whose outcome was never recorded (the process
    // died mid-step) — then nothing else is written.
    const goal = admit(h, runner, {
      idempotencyKey: "key-adopt",
      registerPin: false,
    });
    insertMutation(h, goal.id, "pending", "p1");
    h.goalLedger.claimGoal(goal.id, "owner-1");
    assert.equal(goalStatus(h, goal.id), "running");

    const result = await runner.resumeStuckGoals();
    assert.equal(result.processed, 1);
    assert.equal(result.requeued, 0, "an adopted mutation must NOT requeue");

    // The pending mutation was adopted `unresolved` (never re-executed; only
    // user-resolved on resume) and the goal PAUSED `needs_mutation_resolution`
    // — never requeued into a fresh model round with full mutation capability.
    assert.equal(goalStatus(h, goal.id), "paused");
    assert.equal(pauseReason(h, goal.id), "needs_mutation_resolution");
    const adopted = h.db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goal.id) as { state: string };
    assert.equal(adopted.state, "unresolved");
    // An adopted mutation makes the goal's effects read `unknown` on re-claim —
    // the L12 guard would also pause it, but recovery already did.
    assert.equal(h.goalLedger.effectState(goal.id), "unknown");
  });

  test("resumeStuckGoals requeues a running goal with NO pending rows (H1)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-recover-clean",
      registerPin: false,
    });
    h.goalLedger.claimGoal(goal.id, "owner-1");
    h.goalLedger.insertGoalStep(goal.id, "owner-1", { kind: "model" });

    const result = await runner.resumeStuckGoals();
    assert.equal(result.processed, 1);
    assert.equal(result.requeued, 1, "a clean running goal requeues as before");
    assert.equal(goalStatus(h, goal.id), "queued");
    assert.equal(pauseReason(h, goal.id), null);
  });

  test("resumeStuckGoals re-tags a paused goal carrying a pending row and clears its question (H1)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    // A goal paused with a question, then a `pending` mutation appears (a
    // straggler the earlier adoption missed, or a reserve that raced the
    // pause). Recovery must re-tag it `needs_mutation_resolution` AND clear
    // the stale question (that reason forbids one).
    const goal = admit(h, runner, {
      idempotencyKey: "key-paused-pending",
      registerPin: false,
    });
    h.goalLedger.claimGoal(goal.id, "owner-1");
    h.goalLedger.transitGoal(goal.id, "owner-1", {
      next: "paused",
      reason: "needs_user_input",
      question: "which meal?",
      leaseOwner: "owner-1",
      leaseToken: h.goalLedger.getGoal(goal.id)!.lease_token!,
    });
    insertMutation(h, goal.id, "pending", "p2");
    assert.equal(goalStatus(h, goal.id), "paused");

    const result = await runner.resumeStuckGoals();
    assert.equal(result.processed, 0, "no running goals");
    assert.equal(result.requeued, 0);

    const row = h.goalLedger.getGoal(goal.id)!;
    assert.equal(row.status, "paused");
    assert.equal(row.pause_reason, "needs_mutation_resolution");
    assert.equal(row.pause_question, null, "the stale question is cleared");
    const adopted = h.db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goal.id) as { state: string };
    assert.equal(adopted.state, "unresolved");
  });

  test("F2: a failing pending-mutation scan fails closed — nothing is marked terminal or requeued", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("unused")] }),
    });
    const goal = admit(h, runner, {
      idempotencyKey: "key-pending-scan-fail",
      registerPin: false,
    });
    h.goalLedger.claimGoal(goal.id, "owner-1");
    const orphan = h.goalLedger.insertGoalStep(goal.id, "owner-1", {
      kind: "model",
    });
    (h.goalLedger as unknown as {
      listGoalsWithPendingMutations: () => GoalRow[];
    }).listGoalsWithPendingMutations = () => {
      throw new Error("pending scan unavailable");
    };

    const result = await runner.resumeStuckGoals();
    assert.deepEqual(result, { processed: 0, requeued: 0 });
    // Fail closed: with the pending set unknown, NOTHING is written. The
    // interrupted step stays `running` and the goal stays `running`, so the next
    // boot re-scans rather than requeueing a goal that may hold an in-flight
    // mutation.
    assert.equal(
      h.goalLedger.getStep(goal.id, orphan.seq)?.status,
      "running",
      "the interrupted step must not be marked terminal",
    );
    assert.equal(goalStatus(h, goal.id), "running", "the goal must not be requeued");
  });
});
