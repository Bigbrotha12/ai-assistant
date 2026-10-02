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
import { migrateLedger } from "../../src/ledger.ts";
import type { PluginRegistry } from "../../src/plugins/registry.ts";

/**
 * Phase 3.1 goal-runner tests. Fully deterministic: in-memory DB + GoalLedger
 * with an injected clock, a manually-driven claim timer (the
 * `test/jobs/runner.test.ts` fake-scheduler idiom), a scripted chat model and
 * a fake MCP client factory. No network, no real timers except the `waitFor`
 * polling helper and the runner's setup deadline (never reached here).
 *
 * M2 semantics these tests pin:
 *   - a step's input vector is rebuilt from `goal_message` (admission appends
 *     the instruction as the first `user` row — mirrored in `admit()`);
 *   - a non-terminal step CHAINS `running -> queued` (control tools that end a
 *     goal are Phase 3.3's seam and do not exist yet, so a goal loops until a
 *     global bound stops it);
 *   - bound violations terminate `failed(<reason>)` via `transitGoal`'s
 *     `failureReason` (M2 has no pause machinery).
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

function steps(h: Harness, goalId: string): GoalStepRow[] {
  return h.goalLedger.listGoalSteps(goalId);
}

function goalStatus(h: Harness, goalId: string): string {
  return h.goalLedger.getGoal(goalId)?.status ?? "missing";
}

function failureReason(h: Harness, goalId: string): string | null {
  return h.goalLedger.getGoal(goalId)?.failure_reason ?? null;
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

  test("wall-clock bound from admission fails the goal and it does not spin", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("hello")] }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-wc" });
    // Admitted 11 minutes ago (> GOAL_MAX_WALL_CLOCK_MS = 10 min from
    // `goal.created_ts`); the pin's 15-min TTL is still valid — the bound
    // fires BEFORE any setup, and the failure reason proves which bound won.
    h.clock.advance(11 * 60_000);

    h.scheduler.fireAll();
    await runner.drainInFlight();

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), "wall_clock_exceeded");
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);

    // Does not spin: another claim pass re-claims nothing.
    h.scheduler.fireAll();
    await runner.drainInFlight();
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(goalStatus(h, goal.id), "failed");
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

  test("credentials_required: absent or expired pins fail the goal; it never hangs", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      buildModel: () =>
        new ScriptedChatModel({ responses: [new AIMessage("hello")] }),
    });
    // A: no registry entry at all (the M2 restart story — the registry is
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

    for (const goal of [goalA, goalB]) {
      assert.equal(goalStatus(h, goal.id), "failed");
      assert.match(failureReason(h, goal.id) ?? "", /credentials/);
      assert.equal(steps(h, goal.id).length, 1);
      assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    }
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
  test("a setup that outruns the deadline fails setup_timeout and never hangs (abandoned resolve contained)", async (t) => {
    const h = makeHarness();
    const mcp = fakeMcp();
    const runner = makeRunner(t, h, {
      mcpClientFactory: mcp.factory,
      setupDeadlineMs: 10,
      // Model resolution hangs past the deadline, then rejects. The runner's
      // wait-race must abandon it at the deadline and FAIL the goal; the
      // late rejection is caught by the attached `.catch` (an unhandled
      // rejection would crash the test run).
      buildModel: () =>
        new Promise<BaseChatModel>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late model resolution failure")), 60);
        }),
    });
    const goal = admit(h, runner, { idempotencyKey: "key-setup-deadline" });

    h.scheduler.fireAll();
    await runner.drainInFlight(); // resolves promptly: the lost race never hangs

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), "setup_timeout");
    assert.equal(steps(h, goal.id).length, 1);
    assert.equal(steps(h, goal.id)[0]?.status, "terminal");
    assert.equal(mcp.calls.length, 0);

    // Let the abandoned resolve settle; if the runner had not contained it the
    // process would surface an unhandled rejection here.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(goalStatus(h, goal.id), "failed");
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

    assert.equal(goalStatus(h, goal.id), "failed");
    assert.equal(failureReason(h, goal.id), "setup_timeout");
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
