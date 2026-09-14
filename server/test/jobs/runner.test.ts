import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  AIMessage,
  BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import type { ToolCallHandler } from "../../src/agents/orchestrator.ts";
import { createAgentGraph } from "../../src/agents/graph.ts";
import { compileGraphWithCheckpointer } from "../../src/agents/compile.ts";
import { HumanMessage } from "@langchain/core/messages";
import { checkpointThreadId } from "../../src/checkpoints/store.ts";
import {
  JobError,
  ToolExecutor,
  bindJobTools,
  createJobRunner,
} from "../../src/jobs/runner.ts";
import type { JobRunner } from "../../src/jobs/runner.ts";
import { AsyncMutex } from "../../src/jobs/mutex.ts";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import { recordToolResult } from "../../src/credentials/idempotency.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ToolPluginDefinition, ModelPluginDefinition } from "../../src/plugins/types.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import type { ToolCacheKey } from "../../src/middleware/cache.ts";
import { redactForCheckpoint } from "../../src/checkpoints/store.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";

/**
 * Wave C1 job-runner tests. Everything is fake/in-memory: a real Ledger on an
 * in-memory SQLite DB (honest fence/heartbeat assertions), an in-memory
 * `MemorySaver` checkpointer, a scripted chat model, a recording fake
 * `ToolCallHandler`, and a real `ToolExecutor` with a stubbed `validatedFetch`.
 */

/** Deterministic gateway clock + manually-driven timers (ledger.test.ts pattern). */
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

function makeLedger() {
  const db = new Database(":memory:");
  migrateLedger(db);
  let now = 1_000_000;
  const scheduler = makeFakeScheduler();
  const ledger = new Ledger(db, {
    stuckTimeoutMs: 10_000,
    leaseExpiryMs: 60_000,
    now: () => now,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
  });
  return {
    db,
    ledger,
    scheduler,
    clock: {
      advance: (ms: number) => {
        now += ms;
      },
      now: () => now,
    },
  };
}

type ScriptedOptions = {
  responses: BaseMessage[];
  onGenerate?: (call: number) => void | Promise<void>;
};

/** Scripted model; `bindTools` carries the queue + hook into a bound copy. */
class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];
  private readonly onGenerate?: (call: number) => void | Promise<void>;
  private calls = 0;

  constructor(options: ScriptedOptions) {
    super({});
    this.queue = [...options.responses];
    this.onGenerate = options.onGenerate;
  }

  _llmType(): string {
    return "scripted-jobs";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedChatModel({
      responses: this.queue,
      onGenerate: this.onGenerate,
    });
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    await this.onGenerate?.(this.calls);
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

const DNS: Record<string, LookupAddress[]> = {
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.local": [{ address: "192.168.1.10", family: 4 }],
};

function fakeLookup(): LookupFn {
  return async (hostname, _options) => {
    const records = DNS[hostname.toLowerCase()];
    return records ? [...records] : [];
  };
}

function vikunjaManifest(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.4.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "Task management tools",
    tools: [
      {
        name: "list_tasks",
        description: "List tasks from a project",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
      {
        name: "create_task",
        description: "Create a task",
        readOnly: false,
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Personal access token", required: true } },
  };
}

/** Model plugin for the M2 restart-replay tests (resumeStuckJobs must be able
 *  to identify the model plugin among a restored pin set). */
function openRouterModelPlugin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "1.0.0",
    schemaVersion: 1,
    type: "model",
    name: "OpenRouter",
    description: "Aggregated LLM inference",
    inference: {
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "openrouter/auto",
      tokenLimit: 131_072,
      supportsStreaming: true,
      visionCapable: true,
      parameters: {},
    },
    baseUrls: [{ id: "openrouter-api", url: "https://openrouter.ai/api/v1" }],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
  };
}

async function makeRegistry(
  t: TestContext,
): Promise<{ registry: PluginRegistry; store: PluginStore }> {
  const dir = await mkdtemp(join(tmpdir(), "jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [openRouterModelPlugin()],
    manifests: [vikunjaManifest()],
    lookup: fakeLookup(),
  });
  await store.load();
  await store.install("vikunja");
  return { registry: new PluginRegistry(store), store };
}

type RecordedCall = {
  pluginId: string;
  toolName: string;
  args: Record<string, unknown>;
  credentials?: Record<string, unknown>;
};

function recordingHandler(calls: RecordedCall[]): ToolCallHandler {
  return {
    async execute(pluginId, toolName, args, credentials) {
      calls.push({ pluginId, toolName, args, credentials });
      return JSON.stringify({ ok: true, toolName, ...args });
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function baseDeps(
  ledger: Ledger,
  registry: PluginRegistry,
  pins: CredentialPinStore,
  overrides: Partial<Parameters<typeof createJobRunner>[0]> = {},
): Parameters<typeof createJobRunner>[0] {
  return {
    ledger,
    registry,
    pins,
    checkpointer: new MemorySaver(),
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<Parameters<JobRunner["runJob"]>[0]> = {},
): Parameters<JobRunner["runJob"]>[0] {
  return {
    owner: "user-1",
    intentKey: "job-1",
    spec: "list my tasks",
    clientThreadId: "thr-1",
    toolPlugins: ["vikunja"],
    modelPluginId: "openrouter",
    ...overrides,
  };
}

describe("AsyncMutex", () => {
  test("serializes concurrent runExclusive calls FIFO", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const first = mutex.runExclusive(async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a-end");
    });
    const second = mutex.runExclusive(async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });

  test("releases the lock when fn throws", async () => {
    const mutex = new AsyncMutex();
    await assert.rejects(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    const value = await mutex.runExclusive(async () => 42);
    assert.equal(value, 42);
  });
});

describe("JobRunner.runJob", () => {
  test("happy path: queued→running→succeeded, graph invoked once, handler gets (pluginId, toolName, args, credentials), heartbeat ran", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, scheduler, clock } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const calls: RecordedCall[] = [];
    let heartbeatDuringRun = 0;
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, "call_happy"),
        new AIMessage("here are your tasks"),
      ],
      onGenerate: (call) => {
        if (call === 1) {
          // The heartbeat must be alive WHILE the graph runs.
          clock.advance(5000);
          scheduler.fireAll();
          heartbeatDuringRun =
            ledger.listTasks("user-1")[0]?.last_heartbeat_ts ?? 0;
        }
      },
    });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls) }),
    );

    if (result.status !== "succeeded") {
      throw new Error(`expected succeeded, got ${JSON.stringify(result)}`);
    }
    const task = ledger.getTask(result.taskId);
    assert.equal(task?.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      pluginId: "vikunja",
      toolName: "list_tasks",
      args: { projectId: "p1" },
      credentials: { apiKey: "tok" },
    });
    assert.equal(heartbeatDuringRun, 1_005_000, "heartbeat fired during the job");
    assert.equal(scheduler.count(), 0, "heartbeat stopped after the job");
    assert.ok(
      ledger.listSteps(result.taskId).some((s) => s.action === "tool:list_tasks"),
      "the tool result was recorded for replay dedupe",
    );
  });

  test("idempotent admission: a second runJob while the first runs returns in_flight and never double-invokes", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invokeCount = 0;
    const model = new ScriptedChatModel({
      responses: [new AIMessage("done")],
      onGenerate: async () => {
        invokeCount += 1;
        await gate;
      },
    });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const first = runner.runJob(descriptor({ intentKey: "same-key" }));
    await waitFor(
      () => ledger.getTaskByIntentKey("user-1", "same-key")?.status === "running",
    );

    const second = await runner.runJob(descriptor({ intentKey: "same-key" }));
    assert.equal(second.status, "in_flight");
    assert.equal(invokeCount, 1, "the second call must not start another invoke");

    release();
    const firstResult = await first;
    assert.equal(firstResult.status, "succeeded");
    assert.equal(invokeCount, 1);
  });

  test("replay dedupe: a stored tool-call result is reused and the handler is NOT called", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const calls: RecordedCall[] = [];
    const toolCallId = "call_replay";
    const checkpointer = new MemorySaver();
    let seeded = false;
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, toolCallId),
        new AIMessage("done"),
      ],
      onGenerate: () => {
        if (seeded) return;
        seeded = true;
        // Simulate a prior partial run that persisted this tool's result.
        const task = ledger.listTasks("user-1")[0]!;
        recordToolResult(ledger, {
          taskId: task.id,
          owner: "user-1",
          fenceToken: task.fence_token,
          toolCallId,
          toolName: "list_tasks",
          result: '{"stored":true}',
        });
      },
    });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 0, "the recorded tool must not execute again");

    const state = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "thr-1"),
      },
    });
    const messages = (state?.channel_values?.messages ?? []) as Array<{
      content?: unknown;
    }>;
    assert.ok(
      messages.some((m) => String(m.content).includes("stored")),
      "the stored result is what reached graph state",
    );
  });

  test("expired credential pin: job fails credentials_expired, no graph invoke, no handler call", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    let pinNow = 1_000_000;
    const pins = new CredentialPinStore({ maxLifetimeMs: 1000, now: () => pinNow });
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pinNow += 2000; // expire the pin

    const calls: RecordedCall[] = [];
    let invoked = false;
    const model = new ScriptedChatModel({
      responses: [new AIMessage("done")],
      onGenerate: () => {
        invoked = true;
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );

    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls) }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "credentials_expired");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "error:credentials_expired"),
    );
    assert.equal(invoked, false, "the graph must not be invoked");
    assert.equal(calls.length, 0);
  });

  test("graph error: task failed with a redacted error step", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const model = new ScriptedChatModel({
      responses: [new AIMessage("never")],
      onGenerate: () => {
        throw new Error("model exploded with Bearer sk-secret123");
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );

    const result = await runner.runJob(descriptor());
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "job_failed");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
    const errorStep = ledger
      .listSteps(result.taskId)
      .find((s) => s.action === "error:job_failed");
    assert.ok(errorStep, "an error step must be appended");
    assert.ok(!String(errorStep.result).includes("sk-secret123"));
    assert.ok(String(errorStep.result).includes("Bearer ***"));
  });

  test("mutex: two concurrent runJobs on the same thread serialize (no interleaved invoke, no lost update)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    let active = 0;
    let maxActive = 0;
    const buildModel = (label: string) =>
      new ScriptedChatModel({
        responses: [new AIMessage(`reply-${label}`)],
        onGenerate: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active -= 1;
        },
      });
    const checkpointer = new MemorySaver();
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        buildModel: (_id, config) => buildModel(String(config)),
      }),
    );

    const [a, b] = await Promise.all([
      runner.runJob(
        descriptor({ intentKey: "job-a", clientThreadId: "shared", modelRequestConfig: "a" }),
      ),
      runner.runJob(
        descriptor({ intentKey: "job-b", clientThreadId: "shared", modelRequestConfig: "b" }),
      ),
    ]);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.equal(maxActive, 1, "only one invoke may run per thread at a time");

    const checkpoint = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "shared"),
      },
    });
    const messages = (checkpoint?.channel_values?.messages ?? []) as unknown[];
    assert.equal(
      messages.length,
      4,
      "both jobs' messages accumulate (no lost update)",
    );
  });

  test("getJobStatus is owner-scoped", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () => new ScriptedChatModel({ responses: [new AIMessage("ok")] }),
      }),
    );

    const result = await runner.runJob(descriptor({ intentKey: "status-key" }));
    assert.equal(result.status, "succeeded");
    assert.equal(runner.getJobStatus("user-1", "status-key")?.id, result.taskId);
    assert.equal(runner.getJobStatus("user-2", "status-key"), null);
  });

  test("H2: a misconfigured heartbeat interval fails the job cleanly — no orphaned running task, pins released", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        // stuckTimeoutMs=10_000 → max interval 3333; 9999 is INVALID_CONFIG.
        heartbeatIntervalMs: 9_999,
        buildModel: () =>
          new ScriptedChatModel({ responses: [new AIMessage("never")] }),
      }),
    );
    const result = await runner.runJob(descriptor());
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "job_failed");
    assert.equal(
      ledger.getTask(result.taskId)?.status,
      "failed",
      "a failed heartbeat setup must not leave the task running",
    );
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "error:job_failed"),
      "an error step must record the failure",
    );
    assert.throws(
      () => pins.get("user-1", "vikunja"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "the finally must release the pin even though the heartbeat never started",
    );
  });

  test("M6: a running task with a stale heartbeat is marked stuck and resumed on the next runJob (not in_flight forever)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    // Simulate a crashed worker: a task claimed but never completed.
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "wedged",
      spec: "{}",
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000); // heartbeat stale past the stuck timeout

    const model = new ScriptedChatModel({ responses: [new AIMessage("recovered")] });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(descriptor({ intentKey: "wedged" }));
    assert.notEqual(result.status, "in_flight", "a stale running task must not wedge");
    assert.equal(result.status, "succeeded");
    assert.equal(ledger.getTask(task.id)?.status, "succeeded");
  });

  test("M7: a tool handler throwing fails the job with an error step (not a succeeded ToolMessage)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const failingHandler: ToolCallHandler = {
      async execute() {
        throw new Error("backend exploded");
      },
    };
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, "call_fail"),
        new AIMessage("never"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: failingHandler }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "job_failed");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "error:job_failed"),
      "the tool error must surface as a failed job with an error step",
    );
  });

  test("H3: a FRESH job may execute a mutating tool (allowMutatingRetry true)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const calls: RecordedCall[] = [];
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("create_task", { title: "x" }, "call_mut_fresh"),
        new AIMessage("done"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, "create_task");
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "tool:create_task"),
      "the fresh run's mutating tool result is recorded",
    );
  });

  test("H3: a resumed (isReplay) job refuses to re-execute a mutating tool with no stored result → tool_retry_forbidden", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const calls: RecordedCall[] = [];
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("create_task", { title: "x" }, "call_mut_replay"),
        new AIMessage("never"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls), isReplay: true }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "tool_retry_forbidden");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "error:tool_retry_forbidden"),
    );
    assert.equal(calls.length, 0, "the mutating tool must not execute during a replay");
  });

  test("M1: runJob records the owner→thread mapping (touchThread) with the hashed thread id", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const touched: Array<{ owner: string; threadId: string }> = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () =>
          new ScriptedChatModel({ responses: [new AIMessage("ok")] }),
        touchThread: (owner, threadId) => {
          touched.push({ owner, threadId });
        },
      }),
    );
    const result = await runner.runJob(descriptor());
    assert.equal(result.status, "succeeded");
    assert.deepEqual(touched, [
      { owner: "user-1", threadId: checkpointThreadId("user-1", "thr-1") },
    ]);
  });

  test("M5: on an optimistic-lock conflict the re-evaluation re-applies the ORIGINAL input (input survives)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    // A checkpointer that fabricates a diverging id on the runner's DIRECT
    // `get` reads (readCheckpointId), simulating another writer having advanced
    // the thread past our final write. graph internals use getTuple (real), so
    // only the conflict-detection re-read diverges and the branch fires once.
    class SimulatedInterleavingSaver extends MemorySaver {
      override async get(config: Parameters<MemorySaver["get"]>[0]) {
        const checkpoint = await super.get(config);
        if (!checkpoint) return checkpoint;
        return { ...checkpoint, id: `simulated-${checkpoint.id}` };
      }
    }
    const checkpointer = new SimulatedInterleavingSaver();

    // Seed the thread so `beforeId` is non-null (the conflict branch requires it).
    const threadId = checkpointThreadId("user-1", "thr-1");
    const seedGraph = compileGraphWithCheckpointer(
      createAgentGraph({
        model: new ScriptedChatModel({ responses: [new AIMessage("seed reply")] }),
        tools: [],
      }),
      checkpointer,
    );
    await seedGraph.invoke(
      { messages: [new HumanMessage("seed")] },
      { configurable: { thread_id: threadId } },
    );

    let generateCalls = 0;
    const model = new ScriptedChatModel({
      responses: [new AIMessage("reply")],
      onGenerate: () => {
        generateCalls += 1;
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(
      descriptor({ input: { messages: [new HumanMessage("original user input")] } }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(generateCalls, 2, "the conflict re-evaluation must have run once");

    const state = await checkpointer.get({
      configurable: { thread_id: threadId },
    });
    const messages = (state?.channel_values?.messages ?? []) as Array<{
      content?: unknown;
    }>;
    assert.ok(
      messages.some((m) => String(m.content) === "original user input"),
      "the original input must survive the conflict re-evaluation",
    );
  });

  test("LOW: the per-thread mutex is GC'd from the map once a job finishes", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () =>
          new ScriptedChatModel({ responses: [new AIMessage("ok")] }),
      }),
    );
    await runner.runJob(descriptor({ intentKey: "gc-1" }));
    const internals = runner as unknown as { mutexes: Map<string, AsyncMutex> };
    assert.equal(
      internals.mutexes.size,
      0,
      "a finished job's per-thread mutex must be evicted",
    );
  });

  test("LOW: per-thread mutexes are GC'd after concurrent jobs on the same thread both finish (no split lock)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    let active = 0;
    let maxActive = 0;
    const buildModel = (label: string) =>
      new ScriptedChatModel({
        responses: [new AIMessage(`reply-${label}`)],
        onGenerate: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active -= 1;
        },
      });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: (_id, config) => buildModel(String(config)),
      }),
    );

    const [a, b] = await Promise.all([
      runner.runJob(
        descriptor({ intentKey: "gc-a", clientThreadId: "shared-gc", modelRequestConfig: "a" }),
      ),
      runner.runJob(
        descriptor({ intentKey: "gc-b", clientThreadId: "shared-gc", modelRequestConfig: "b" }),
      ),
    ]);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.equal(maxActive, 1, "the shared-thread lock must never split");
    const internals = runner as unknown as { mutexes: Map<string, AsyncMutex> };
    assert.equal(
      internals.mutexes.size,
      0,
      "both finished jobs' shared-thread mutex must be evicted",
    );
  });

  test("Wave C2: the buildModel seam resolves the PINNED model credential by owner and builds the model", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" }); // tool pin
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" }); // model pin

    const built: Array<{
      modelPluginId: string;
      requestConfig: unknown;
      creds?: Record<string, string>;
    }> = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: (modelPluginId, requestConfig) => {
          const cfg = requestConfig as { owner?: string } | undefined;
          let creds: Record<string, string> | undefined;
          try {
            if (cfg?.owner) creds = pins.get(cfg.owner, modelPluginId).credentials;
          } catch {
            creds = undefined;
          }
          built.push({ modelPluginId, requestConfig, creds });
          return new ScriptedChatModel({ responses: [new AIMessage("built ok")] });
        },
      }),
    );

    const result = await runner.runJob(
      descriptor({
        intentKey: "seam-1",
        modelRequestConfig: { owner: "user-1", requestModel: "anthropic/claude-3.5-sonnet" },
        toolHandler: recordingHandler([]),
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(built.length, 1, "buildModel called once");
    assert.equal(built[0]!.modelPluginId, "openrouter");
    assert.equal(
      (built[0]!.requestConfig as { requestModel?: string }).requestModel,
      "anthropic/claude-3.5-sonnet",
      "the request config (owner + overrides) reaches the seam",
    );
    assert.deepEqual(built[0]!.creds, { apiKey: "sk-model" });

    // The runner owns the model pin's lifecycle: released in the job's finally.
    assert.throws(
      () => pins.get("user-1", "openrouter"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "the model pin must be released when the job completes",
    );
  });
});

describe("JobRunner.resumeStuckJobs (restart loss)", () => {
  test("a stuck task with no pins fails credentials_expired and notifies", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();

    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan",
      spec: "{}",
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000); // heartbeat stale past the stuck timeout
    assert.equal(ledger.reconcileOrphans().marked.length, 1);
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const notifications: Array<{ owner: string; taskId: string; summary: string }> = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        notification: {
          notifyJobComplete(owner, taskId, summary) {
            notifications.push({ owner, taskId, summary });
          },
        },
      }),
    );

    const result = await runner.resumeStuckJobs();
    assert.equal(result.processed, 1);
    assert.equal(result.outcomes[0]?.outcome, "credentials_expired");
    assert.equal(ledger.getTask(task.id)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(task.id)
        .some((s) => s.action === "error:credentials_expired"),
    );
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.owner, "user-1");
    assert.equal(notifications[0]?.taskId, task.id);
  });

  test("with a credentialSource that re-establishes pins, the task is repinned and resumed", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({ owner: "user-1", intentKey: "orphan-2", spec: "{}" });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        credentialSource: () => ({ vikunja: { apiKey: "restored" } }),
      }),
    );
    const result = await runner.resumeStuckJobs();
    assert.equal(result.outcomes[0]?.outcome, "repinned");
    assert.equal(ledger.getTask(task.id)?.status, "running");
    assert.deepEqual(pins.get("user-1", "vikunja").credentials, {
      apiKey: "restored",
    });
  });

  test("H3: with a model seam wired and the model plugin identifiable among the restored pins, a repinned stuck task is re-run through runJob as a replay (mutating tool → tool_retry_forbidden)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan-replay",
      spec: "{}",
      // M2: the transport stores the ORIGINAL raw client thread id in the
      // task's `worker` column; a replay must resume on that thread.
      worker: "original-client-thread",
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const calls: RecordedCall[] = [];
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("create_task", { title: "x" }, "call_replay_resume"),
        new AIMessage("never"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        buildModel: () => model,
        credentialSource: () => ({
          openrouter: { apiKey: "sk-model" },
          vikunja: { apiKey: "restored" },
        }),
      }),
    );
    const result = await runner.resumeStuckJobs();
    assert.equal(result.outcomes[0]?.outcome, "tool_retry_forbidden");
    assert.equal(ledger.getTask(task.id)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(task.id)
        .some((s) => s.action === "error:tool_retry_forbidden"),
    );
    assert.equal(calls.length, 0, "the mutating tool must not re-execute during a replay");

    // M2: the replay ran on the STORED client thread (worker column), not on a
    // re-hash of the intent key — the original thread now holds the replay's
    // checkpoint, proving the resume was not mis-threaded.
    const state = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "original-client-thread"),
      },
    });
    assert.ok(
      state !== undefined,
      "the replay wrote to the ORIGINAL checkpoint thread (worker column)",
    );
    const wrongThread = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "orphan-replay"),
      },
    });
    assert.equal(
      wrongThread,
      undefined,
      "the replay must NOT checkpoint the intent-key thread",
    );
  });

  test("M2: a repinned stuck task whose restored pins carry NO model plugin fails plugin_unavailable (never credentials_expired, never a wrong-thread resume)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan-nomodel",
      spec: "{}",
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () => new ScriptedChatModel({ responses: [new AIMessage("never")] }),
        // Only the TOOL plugin's key is restored — no model plugin id.
        credentialSource: () => ({ vikunja: { apiKey: "restored" } }),
      }),
    );
    const result = await runner.resumeStuckJobs();
    assert.equal(result.outcomes[0]?.outcome, "plugin_unavailable");
    assert.equal(ledger.getTask(task.id)?.status, "failed");
    assert.ok(
      ledger
        .listSteps(task.id)
        .some((s) => s.action === "error:plugin_unavailable"),
      "the honest code is plugin_unavailable, not credentials_expired",
    );
  });
});

describe("bindJobTools replay/retry rules", () => {
  test("a readOnly tool re-runs when allowMutatingRetry is false; a mutating tool throws tool_retry_forbidden", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "user-1", intentKey: "k", spec: "{}" });
    const claimed = ledger.claimTask(task.id, "user-1");
    const calls: RecordedCall[] = [];
    const tools = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      allowMutatingRetry: false,
    });

    const readOnly = tools.find((tool) => tool.name === "list_tasks")!;
    const mutating = tools.find((tool) => tool.name === "create_task")!;

    const readOnlyResult = await readOnly.func(
      { projectId: "p1" },
      undefined,
      { toolCall: { id: "call_ro" } } as never,
    );
    assert.equal(typeof readOnlyResult, "string");
    assert.equal(calls.length, 1, "readOnly tools may be re-run");

    await assert.rejects(
      (async () => {
        await mutating.func(
          { title: "x" },
          undefined,
          { toolCall: { id: "call_mut" } } as never,
        );
      })(),
      (e: unknown) => e instanceof JobError && e.code === "tool_retry_forbidden",
    );
    assert.equal(calls.length, 1, "the mutating tool must not execute");
  });

  test("a stored result is returned without executing (dedupe) even for mutating tools", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const task = ledger.createTask({ owner: "user-1", intentKey: "k2", spec: "{}" });
    const claimed = ledger.claimTask(task.id, "user-1");
    recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_done",
      toolName: "create_task",
      result: '{"already":"applied"}',
    });
    const calls: RecordedCall[] = [];
    const tools = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      allowMutatingRetry: false,
    });
    const mutating = tools.find((tool) => tool.name === "create_task")!;
    const result = await mutating.func(
      { title: "x" },
      undefined,
      { toolCall: { id: "call_done" } } as never,
    );
    assert.equal(result, '{"already":"applied"}');
    assert.equal(calls.length, 0);
  });
});

describe("ToolExecutor (real validatedFetch path)", () => {
  test("resolves pinned IPs, calls validatedFetch with credentials, and redacts the result", async (t) => {
    const { registry } = await makeRegistry(t);
    const spy: { count: number; url?: string; init?: RequestInit } = { count: 0 };
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      spy.count += 1;
      spy.url = String(input);
      spy.init = init;
      return new Response("echo Bearer sk-secret123", { status: 200 });
    }) as unknown as typeof fetch;

    const executor = new ToolExecutor({
      registry,
      getPinnedIps: (pluginId) =>
        pluginId === "vikunja"
          ? [
              {
                entryId: "vikunja-api",
                url: "https://vikunja.example.com",
                pinned: ["1.1.1.1"],
              },
            ]
          : undefined,
      fetchFn,
      lookup: fakeLookup(),
      mode: "test",
    });

    const result = await executor.execute(
      "vikunja",
      "list_tasks",
      { projectId: "p1" },
      { apiKey: "sk-secret123" },
    );

    assert.equal(spy.count, 1);
    assert.equal(spy.url, "https://vikunja.example.com/list_tasks");
    assert.equal(
      (spy.init?.headers as Record<string, string>)?.authorization,
      "Bearer sk-secret123",
    );
    assert.equal(result, "echo Bearer ***", "credential-shaped output is redacted");
  });

  test("the full path: runJob → bindJobTools → real ToolExecutor → validatedFetch (pins + credentials)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const spy: { count: number; url?: string; init?: RequestInit } = { count: 0 };
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      spy.count += 1;
      spy.url = String(input);
      spy.init = init;
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const executor = new ToolExecutor({
      registry,
      getPinnedIps: (pluginId) =>
        pluginId === "vikunja"
          ? [
              {
                entryId: "vikunja-api",
                url: "https://vikunja.example.com",
                pinned: ["1.1.1.1"],
              },
            ]
          : undefined,
      fetchFn,
      lookup: fakeLookup(),
      mode: "test",
    });

    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, "call_full"),
        new AIMessage("done"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        executor,
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(descriptor());
    assert.equal(result.status, "succeeded");
    assert.equal(spy.count, 1);
    assert.equal(spy.url, "https://vikunja.example.com/list_tasks");
    assert.equal(
      (spy.init?.headers as Record<string, string>)?.authorization,
      "Bearer tok",
      "the pinned credential rides the outbound call",
    );
  });

  test("the optimistic-lock re-evaluation idiom: on conflict the graph re-runs with the ORIGINAL input re-applied (M5 — input survives)", async () => {
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel({
      responses: [new AIMessage("first"), new AIMessage("re-evaluated")],
    });
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model, tools: [] }),
      checkpointer,
    );
    await graph.invoke(
      { messages: [new HumanMessage("base")] },
      { configurable: { thread_id: "t" } },
    );
    // A conflict detected after our write re-invokes with the ORIGINAL input —
    // never a blind `{ messages: [] }` re-evaluation (M5).
    const input = { messages: [new HumanMessage("original user input")] };
    const result = await graph.invoke(input, { configurable: { thread_id: "t" } });
    const contents = result.messages.map((m: BaseMessage) => String(m.content));
    assert.ok(
      contents.includes("original user input"),
      "the original input survives the re-evaluation",
    );
    assert.ok(contents.includes("re-evaluated"));
  });

  test("a plugin with no pinned IPs is plugin_unavailable and never fetches", async (t) => {
    const { registry } = await makeRegistry(t);
    let fetched = false;
    const executor = new ToolExecutor({
      registry,
      getPinnedIps: () => undefined,
      fetchFn: (async () => {
        fetched = true;
        return new Response("nope");
      }) as unknown as typeof fetch,
      lookup: fakeLookup(),
      mode: "test",
    });
    await assert.rejects(
      executor.execute("vikunja", "list_tasks", {}, { apiKey: "k" }),
      (e: unknown) => e instanceof JobError && e.code === "plugin_unavailable",
    );
    assert.equal(fetched, false);
  });

  test("H1: an admin-trusted *.local host is NOT rejected at call time when trustedHosts is forwarded", async (t) => {
    const { registry } = await makeRegistry(t);
    const pinned = [
      {
        entryId: "vikunja-api",
        url: "https://vikunja.local",
        pinned: ["192.168.1.10"],
      },
    ];
    const makeExecutor = (trustedHosts: readonly string[] | undefined) =>
      new ToolExecutor({
        registry,
        getPinnedIps: (pluginId) =>
          pluginId === "vikunja" ? pinned : undefined,
        fetchFn: (async () =>
          new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch,
        lookup: fakeLookup(),
        mode: "test",
        trustedHosts,
      });

    // Without the trusted-host list, the call-time re-resolution rejects the
    // private .local backend as DNS_REBINDING — the pre-fix behavior that
    // broke every admin-trusted internal plugin tool call.
    await assert.rejects(
      makeExecutor(undefined).execute("vikunja", "list_tasks", {}, { apiKey: "k" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );

    // With the same list the pins were computed under, the call succeeds.
    const result = await makeExecutor(["vikunja.local"]).execute(
      "vikunja",
      "list_tasks",
      {},
      { apiKey: "k" },
    );
assert.equal(result, '{"ok":true}');
  });
});

describe("JobRunner.runJob — Phase 4 Wave B tool-result cache (async seam)", () => {
  /** Raw (UNREDACTED) handler output containing a credential shape. */
  const RAW_RESULT = '{"ok":true,"token":"Bearer sk-secret999"}';

  /** Shared `calls` recording handler that ALSO returns a credential-shaped raw payload. */
  function credentialHandler(calls: RecordedCall[]): ToolCallHandler {
    return {
      async execute(pluginId, toolName, args, credentials) {
        calls.push({ pluginId, toolName, args, credentials });
        return RAW_RESULT;
      },
    };
  }

  /**
   * A buildModel factory returning a fresh scripted model per job (the 
   * ScriptedChatModel's response queue is consumed per job, so each runJob call
   * needs its own instance).
   */
  function modelFactory(toolName: string, callId: string, reply: string, args: Record<string, unknown>) {
    return (_id: unknown, _config: unknown) =>
      new ScriptedChatModel({
        responses: [
          toolCallMessage(toolName, args, callId),
          new AIMessage(reply),
        ],
      });
  }

  test("a read-only tool is cached across runJob runs: the second job does not re-execute the handler and gets the redacted cached result", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const toolCache = createToolResultCache();
    const checkpointer = new MemorySaver();
    const calls: RecordedCall[] = [];

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        toolCache,
        buildModel: modelFactory("list_tasks", "call_ro_1", "done", { projectId: "p1" }),
      }),
    );

    const r1 = await runner.runJob(
      descriptor({
        intentKey: "cache-a",
        clientThreadId: "thr-cache-a",
        toolHandler: credentialHandler(calls),
      }),
    );
    assert.equal(r1.status, "succeeded");
    assert.equal(calls.length, 1, "the first run executed the handler");

    // The runner releases the tool pin in its finally; a second job must be
    // re-pinned (mirrors the transport admitting a new background request).
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const r2 = await runner.runJob(
      descriptor({
        intentKey: "cache-b",
        clientThreadId: "thr-cache-b",
        toolHandler: credentialHandler(calls),
      }),
    );
    assert.equal(r2.status, "succeeded");
    assert.equal(calls.length, 1, "the second run served from the cache, not the handler");
    assert.equal(toolCache.size, 1);

    // The redacted cached result reached the second job's checkpoint state.
    const state = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "thr-cache-b"),
      },
    });
    const messages = (state?.channel_values?.messages ?? []) as Array<{
      content?: unknown;
    }>;
    const redacted = redactForCheckpoint(RAW_RESULT);
    assert.ok(
      messages.some((m) => String(m.content) === redacted),
      "the second job's checkpoint contains the redacted cached result",
    );
  });

  test("a mutating tool is never cached: identical runJob calls re-execute and cache stays empty", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const toolCache = createToolResultCache();
    const calls: RecordedCall[] = [];

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        toolCache,
        buildModel: modelFactory("create_task", "call_mut_1", "done", { title: "x" }),
      }),
    );

    const r1 = await runner.runJob(
      descriptor({
        clientThreadId: "thr-mut-a",
        toolHandler: credentialHandler(calls),
      }),
    );
    assert.equal(r1.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(toolCache.size, 0, "mutating tool results are never cached");

    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const r2 = await runner.runJob(
      descriptor({
        intentKey: "mut-2",
        clientThreadId: "thr-mut-b",
        toolHandler: credentialHandler(calls),
      }),
    );
    assert.equal(r2.status, "succeeded");
    assert.equal(calls.length, 2, "each mutating run always re-executes");
  });

  test("warm cache but ledger wins: a stored ledger step is served via dedupe even when the cache holds an entry (dedupe stays FIRST)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const toolCache = createToolResultCache();

    const calls: RecordedCall[] = [];
    const toolCallId = "call_dedupe_wins";
    const checkpointer = new MemorySaver();
    let seeded = false;
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, toolCallId),
        new AIMessage("done"),
      ],
      onGenerate: () => {
        if (!seeded) {
          seeded = true;
          // Simulate a prior partial run that persisted this tool's result.
          const task = ledger.listTasks("user-1")[0]!;
          recordToolResult(ledger, {
            taskId: task.id,
            owner: "user-1",
            fenceToken: task.fence_token,
            toolCallId,
            toolName: "list_tasks",
            result: '{"from":"ledger"}',
          });
        }
      },
    });

    // Pre-warm the cache with a DIFFERENT value for the same key.
    const cacheKey: ToolCacheKey = {
      owner: "user-1",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: credentialFingerprint({ apiKey: "tok" }),
      tool: "list_tasks",
      argsHash: toolCache.argsHash({ projectId: "p1" }),
    };
    toolCache.set(cacheKey, RAW_RESULT);

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        checkpointer,
        toolCache,
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: credentialHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 0, "neither the cache nor the ledger path called the handler");

    const state = await checkpointer.get({
      configurable: {
        thread_id: checkpointThreadId("user-1", "thr-1"),
      },
    });
    const messages = (state?.channel_values?.messages ?? []) as Array<{
      content?: unknown;
    }>;
    assert.ok(
      messages.some((m) => String(m.content).includes('"from":"ledger"')),
      "the ledger's stored result is what reached graph state, not the cached value",
    );
    assert.ok(
      !messages.some((m) => String(m.content).includes("sk-secret999")),
      "the cache's raw (unredacted) value never reached graph state",
    );
  });

  test("fingerprintsByPlugin uses the pin's precomputed fingerprint (credentialFingerprint not re-derived)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const toolCache = createToolResultCache();

    const expectedFingerprint = credentialFingerprint({ apiKey: "tok" });
    const recordedKeys: ToolCacheKey[] = [];
    const originalSet = toolCache.set.bind(toolCache);
    toolCache.set = (key: ToolCacheKey, result: string) => {
      recordedKeys.push({ ...key });
      originalSet(key, result);
    };

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        toolCache,
        buildModel: modelFactory("list_tasks", "call_fp", "done", { projectId: "p1" }),
      }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: credentialHandler([]) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(recordedKeys.length, 1, "cache was set exactly once");
    assert.equal(
      recordedKeys[0]!.credentialFingerprint,
      expectedFingerprint,
      "the cache key uses the pin's precomputed fingerprint",
    );
  });
});
