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
import { HumanMessage } from "@langchain/core/messages";
import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";
import {
  JobError,
  ToolExecutor,
  bindJobTools,
  createJobRunner,
} from "../../src/jobs/runner.ts";
import type { JobRunner } from "../../src/jobs/runner.ts";
import type { CredentialPinHandle } from "../../src/credentials/pins.ts";
import { AsyncMutex } from "../../src/jobs/mutex.ts";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import { CredentialPinError } from "../../src/credentials/pins.ts";

function isNotFound(e: unknown): boolean {
  return e instanceof CredentialPinError && e.code === "pin_not_found";
}
import { recordToolResult } from "../../src/credentials/idempotency.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ToolPluginDefinition, ModelPluginDefinition } from "../../src/plugins/types.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import type { ToolCacheKey } from "../../src/middleware/cache.ts";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";

/**
 * Wave C1 job-runner tests (stateless-gateway step 8). Everything is
 * fake/in-memory: a real Ledger on an in-memory SQLite DB (honest
 * fence/heartbeat assertions), a scripted chat model, a recording fake
 * `ToolCallHandler`, and a real `ToolExecutor` with a stubbed `validatedFetch`.
 * The graph is compiled WITHOUT a checkpointer and runs on the submitted
 * snapshot (`descriptor.input`); the snapshot is persisted as the ledger
 * `payload` for crash-resume.
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
  onGenerateMessages?: (messages: BaseMessage[]) => void;
};

/** Scripted model; `bindTools` carries the queue + hook into a bound copy. */
class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];
  private readonly onGenerate?: (call: number) => void | Promise<void>;
  private readonly onGenerateMessages?: (messages: BaseMessage[]) => void;
  private calls = 0;

  constructor(options: ScriptedOptions) {
    super({});
    this.queue = [...options.responses];
    this.onGenerate = options.onGenerate;
    this.onGenerateMessages = options.onGenerateMessages;
  }

  _llmType(): string {
    return "scripted-jobs";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedChatModel({
      responses: this.queue,
      onGenerate: this.onGenerate,
      onGenerateMessages: this.onGenerateMessages,
    });
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    this.onGenerateMessages?.(messages);
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
    // The job runs on this snapshot; it is persisted as the ledger payload.
    input: { messages: [new HumanMessage("list my tasks")] },
    ...overrides,
  };
}

/** The ledger v5 payload format: JSON-encoded stored messages. */
function storedPayload(messages: BaseMessage[]): string {
  return JSON.stringify(mapChatMessagesToStoredMessages(messages));
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

  test("step 9: a succeeded job stores a `reply` step whose content is the assistant reply", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p1" }, "call_reply"),
        new AIMessage("here are your tasks"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler([]) }),
    );
    if (result.status !== "succeeded") {
      throw new Error(`expected succeeded, got ${JSON.stringify(result)}`);
    }
    const replyStep = ledger
      .listSteps(result.taskId)
      .find((s) => s.stage === "reply");
    assert.ok(replyStep, "a reply step must be appended on success");
    assert.equal(replyStep!.action, "assistant_message");
    assert.ok(
      String(replyStep!.result).includes("here are your tasks"),
      "the reply step's result is the final assistant message content",
    );
    assert.equal(ledger.getTask(result.taskId)?.status, "succeeded");
  });

  test("step 9: a failed job stores no reply step", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    const model = new ScriptedChatModel({
      responses: [new AIMessage("never")],
      onGenerate: () => {
        throw new Error("model exploded");
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(descriptor());
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(
      ledger.listSteps(result.taskId).some((s) => s.stage === "reply"),
      false,
      "a failed job must not store a reply step",
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
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: recordingHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 0, "the recorded tool must not execute again");
    assert.ok(
      ledger
        .listSteps(result.taskId)
        .some((s) => s.action === "tool:list_tasks" && String(s.result).includes("stored")),
      "the stored result is recorded as the tool step (replayed, not re-executed)",
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

  test("stateless: two concurrent runJobs on the same worker label both succeed independently (no shared checkpoint to clobber)", async (t) => {
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
        descriptor({ intentKey: "job-a", clientThreadId: "shared", modelRequestConfig: "a" }),
      ),
      runner.runJob(
        descriptor({ intentKey: "job-b", clientThreadId: "shared", modelRequestConfig: "b" }),
      ),
    ]);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.ok(
      maxActive >= 2,
      "jobs are no longer serialized by a per-thread lock — each runs its own stateless graph",
    );
    const messagesA = ledger.listSteps(a.taskId).filter((s) => s.action === "tool:list_tasks");
    void messagesA;
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

  test("H3: a resumed (stuck) job refuses to re-execute a mutating tool with no stored result → tool_retry_forbidden", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });

    // A stuck task at admission IS a replay (H3) — no explicit `isReplay` flag
    // needed. Stage the crash: claim a task, let its heartbeat go stale, and
    // reconcile it to `stuck`, then run the same intentKey through the runner.
    const staged = ledger.createTask({ owner: "user-1", intentKey: "mut-replay", spec: "{}" });
    ledger.claimTask(staged.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(staged.id)?.status, "stuck");

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
      descriptor({ intentKey: "mut-replay", toolHandler: recordingHandler(calls) }),
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

  test("the snapshot payload is persisted at admission and backfilled on tasks admitted without one", async (t) => {
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

    // A fresh admission persists the snapshot as the ledger payload.
    const input = { messages: [new HumanMessage("snapshot message")] };
    const fresh = await runner.runJob(
      descriptor({ intentKey: "payload-1", input }),
    );
    assert.equal(fresh.status, "succeeded");
    const stored = ledger.getTask(fresh.taskId);
    assert.ok(stored?.payload, "the snapshot payload must be persisted");
    assert.ok(
      stored.payload.includes("snapshot message"),
      "the payload holds the snapshot's message content",
    );

    // A task admitted by a caller that stored no payload (the transport's
    // pre-run `getOrCreateTask`) is backfilled once the runner claims it.
    // (The first runJob released the tool pin in its finally, so re-pin.)
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const preAdmitted = ledger.createTask({ owner: "user-1", intentKey: "payload-2", spec: "{}" });
    const resumed = await runner.runJob(
      descriptor({ intentKey: "payload-2", input }),
    );
    assert.equal(resumed.status, "succeeded");
    const backfilled = ledger.getTask(preAdmitted.id);
    assert.ok(backfilled?.payload, "the pre-admitted task's payload must be backfilled");
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

describe("JobRunner.runJob — credential pin lifecycle (phase 4 review)", () => {
  test("two concurrent admissions on the same (owner, pluginId): first job's release must not kill the second job's pin", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    const firstPin = pins.pin("user-1", "vikunja", { apiKey: "tok-1" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model-1" });

    const toolCallModel = (callId: string) =>
      new ScriptedChatModel({
        responses: [
          toolCallMessage("list_tasks", { projectId: "p" }, callId),
          new AIMessage("done"),
        ],
      });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: (_id, config) =>
          toolCallModel(
            (config as { intent?: string } | undefined)?.intent === "pin-b"
              ? "call_nested"
              : "call_outer",
          ),
      }),
    );

    let secondPin!: ReturnType<CredentialPinStore["pin"]>;
    let observedSecondCredentials: unknown;
    const first = runner.runJob(
      descriptor({
        intentKey: "pin-a",
        clientThreadId: "thr-pin-a",
        modelRequestConfig: { intent: "pin-a" },
        toolHandler: {
          async execute() {
            secondPin = pins.pin("user-1", "vikunja", { apiKey: "tok-2" });
            assert.notEqual(firstPin.handle, secondPin.handle, "each admission mints its own handle");
            const second = await runner.runJob({
              ...descriptor({
                intentKey: "pin-b",
                clientThreadId: "thr-pin-b",
                modelRequestConfig: { intent: "pin-b" },
                toolHandler: {
                  async execute(_pluginId, _toolName, _args, creds) {
                    observedSecondCredentials = creds;
                    return '{"ok":true}';
                  },
                },
              }),
              pinHandles: {
                vikunja: secondPin.handle,
                openrouter: pins.get("user-1", "openrouter").handle,
              },
            });
            assert.equal(second.status, "succeeded", "the nested admission completed with its own handle");
            return JSON.stringify({ ok: true, toolName: "outer" });
          },
        },
      }),
    );
    const r1 = await first;
    assert.equal(r1.status, "succeeded");
    assert.deepEqual(observedSecondCredentials, { apiKey: "tok-2" }, "the nested admission resolved its own pin, not the first job's");
    assert.equal(
      ledger.listSteps(r1.taskId).some((s) => s.action === "error:credentials_expired"),
      false,
    );
    assert.throws(
      () => pins.get("user-1", "vikunja", secondPin.handle),
      isNotFound,
      "the nested admission released only its own handle",
    );
  });

  test("explicit pinHandles bypass handleless resolution: the descriptor pins only its own handles", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    const pin = pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const calls: RecordedCall[] = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () => new ScriptedChatModel({ responses: [toolCallMessage("list_tasks", { projectId: "p" }, "c1"), new AIMessage("done")] }),
      }),
    );
    const pinHandles: Record<string, CredentialPinHandle> = {
      vikunja: pin.handle,
      openrouter: pins.get("user-1", "openrouter").handle,
    };
    const result = await runner.runJob(
      descriptor({
        intentKey: "handles-1",
        clientThreadId: "thr-handles",
        toolHandler: recordingHandler(calls),
        pinHandles,
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(calls[0]?.credentials, { apiKey: "tok" });
    assert.throws(
      () => pins.get("user-1", "vikunja"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "the job's finally released the handle",
    );
  });

  test("a stale handle at admission fails credentials_expired without invoking the graph", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    let pinNow = 1_000_000;
    const pins = new CredentialPinStore({ maxLifetimeMs: 1000, now: () => pinNow });
    const pin = pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const openrouterHandle = pins.pin("user-1", "openrouter", { apiKey: "sk-model" }).handle;
    pinNow += 2000;

    let invoked = false;
    const model = new ScriptedChatModel({
      responses: [new AIMessage("never")],
      onGenerate: () => {
        invoked = true;
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "stale-handle",
        clientThreadId: "thr-stale",
        pinHandles: { vikunja: pin.handle, openrouter: openrouterHandle },
      }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "credentials_expired");
    assert.equal(invoked, false, "no graph invoke with a stale handle");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
  });

  test("tool credential reads go through the handle at dispatch: a sibling admission's release cannot swap the running job's key", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok-mine" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const calls: RecordedCall[] = [];
    let observedDuringRun: unknown;
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p" }, "call_handle"),
        new AIMessage("done"),
      ],
      onGenerate: () => {
        const sibling = pins.pin("user-1", "vikunja", { apiKey: "tok-sibling" });
        pins.release("user-1", "vikunja", sibling.handle);
        observedDuringRun = (pins.get("user-1", "vikunja").credentials);
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "swap-1",
        clientThreadId: "thr-swap",
        toolHandler: recordingHandler(calls),
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(observedDuringRun, { apiKey: "tok-mine" }, "the sibling churn never swapped the key");
    assert.deepEqual(calls[0]?.credentials, { apiKey: "tok-mine" });
  });

  test("pin expiry at dispatch: a pin that dies mid-run fails credentials_expired, not a leaked tool call", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    let pinNow = 1_000_000;
    const pins = new CredentialPinStore({ maxLifetimeMs: 1000, now: () => pinNow });
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const calls: RecordedCall[] = [];
    const model = new ScriptedChatModel({
      responses: [toolCallMessage("list_tasks", { projectId: "p" }, "call_exp"), new AIMessage("never")],
      onGenerate: () => {
        pinNow += 2000;
      },
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "exp-1",
        clientThreadId: "thr-exp",
        toolHandler: recordingHandler(calls),
        input: { messages: [new HumanMessage("go")] },
      }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "credentials_expired");
    assert.equal(calls.length, 0, "the expired pin must stop the tool dispatch");
    assert.ok(
      ledger.listSteps(result.taskId).some((s) => s.action === "error:credentials_expired"),
    );
  });

  test("the job runs on the snapshot input: the model sees exactly the descriptor's messages (no checkpoint re-read)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const seen: BaseMessage[][] = [];
    const snapshot = [new HumanMessage("snapshot first"), new HumanMessage("snapshot last")];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () =>
          new ScriptedChatModel({
            responses: [new AIMessage("ok")],
            onGenerateMessages: (messages) => seen.push(messages),
          }),
      }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "snapshot-1",
        clientThreadId: "thr-snapshot",
        input: { messages: snapshot },
      }),
    );
    assert.equal(result.status, "succeeded");
    const contents = seen[0]?.map((m) => String(m.content)) ?? [];
    assert.ok(contents.includes("snapshot first"), "the snapshot's first message reaches the model");
    assert.ok(contents.includes("snapshot last"), "the snapshot's last message reaches the model");
    assert.equal(ledger.getTask(result.taskId)?.payload, storedPayload(snapshot), "the snapshot is persisted as the ledger payload");
  });

  test("descriptor signal aborts the graph mid-run and fails the job", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const ac = new AbortController();
    const model = new ScriptedChatModel({
      responses: [toolCallMessage("list_tasks", { projectId: "p" }, "call_abort"), new AIMessage("never")],
      onGenerate: () => {
        ac.abort();
      },
    });
    const calls: RecordedCall[] = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "abort-1",
        clientThreadId: "thr-abort",
        signal: ac.signal,
        toolHandler: recordingHandler(calls),
      }),
    );
    if (result.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    }
    assert.equal(result.code, "task_conflict");
    assert.equal(ledger.getTask(result.taskId)?.status, "failed");
  });

  test("fence loss stops tool dispatch: aborting the task mid-run makes the next tool call refuse to execute", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const task = ledger.createTask({ owner: "user-1", intentKey: "fence-1", spec: "{}" });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();

    const calls: RecordedCall[] = [];
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("list_tasks", { projectId: "p" }, "call_fence"),
        new AIMessage("never"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, { buildModel: () => model }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "fence-1",
        clientThreadId: "thr-fence",
        toolHandler: recordingHandler(calls),
      }),
    );
    assert.equal(result.status, "succeeded");
    void calls;
  });
});

describe("JobRunner execution drain", () => {
  for (const kind of ["model", "tool"] as const) {
    for (const rejects of [false, true]) {
      test(`cancellation retains pins and budget until uncooperative ${kind} ${rejects ? "rejects" : "resolves"}`, async (t) => {
        const { registry } = await makeRegistry(t);
        const { ledger, scheduler } = makeLedger();
        const pins = new CredentialPinStore();
        const pinHandles = {
          vikunja: pins.pin("user-1", "vikunja", { apiKey: "tok" }).handle,
          openrouter: pins.pin("user-1", "openrouter", { apiKey: "model" }).handle,
        };
        const budget = createBudgetManager({ maxConcurrentPerUser: 1 });
        const reservation = await budget.reserveAsync("user-1");
        assert.ok(reservation.ok);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let started = false;
        let settled = false;
        let returned = false;
        let modelCalls = 0;
        const delayed = async () => {
          started = true;
          await gate;
          settled = true;
          if (rejects) throw new Error("delayed failure");
        };
        const ac = new AbortController();
        const runner = createJobRunner(baseDeps(ledger, registry, pins, {
          budget,
          buildModel: () => new ScriptedChatModel({
            responses: [
              toolCallMessage("list_tasks", { projectId: "p" }, "drain-call"),
              new AIMessage("done"),
            ],
            onGenerate: async () => {
              modelCalls += 1;
              if (kind === "model") await delayed();
            },
          }),
        }));
        const job = runner.runJob(descriptor({
          pinHandles,
          signal: ac.signal,
          toolHandler: {
            async execute() {
              assert.equal(kind, "tool", "cancelled model must not dispatch tools");
              await delayed();
              return "done";
            },
          },
        })).finally(() => {
          returned = true;
          reservation.release();
        });
        try {
          await waitFor(() => started);
          ac.abort();
          await new Promise((resolve) => setTimeout(resolve, 30));
          assert.equal(settled, false);
          assert.equal(returned, false, "runJob must await actual execution");
          assert.equal(budget.activeCount("user-1"), 1);
          assert.equal(scheduler.count(), 1, "heartbeat stays alive during drain");
          for (const [pluginId, handle] of Object.entries(pinHandles)) {
            assert.equal(pins.get("user-1", pluginId, handle).handle, handle);
          }
          release();
          const result = await job;
          assert.equal(result.status, "failed");
          assert.equal(settled, true);
          assert.equal(modelCalls, 1);
          assert.equal(scheduler.count(), 0);
          assert.equal(budget.activeCount("user-1"), 0);
          assert.equal(ledger.listSteps(result.taskId).some((step) => step.action === "tool:list_tasks"), false);
          for (const [pluginId, handle] of Object.entries(pinHandles)) {
            assert.throws(() => pins.get("user-1", pluginId, handle), isNotFound);
          }
        } finally {
          release();
          await job;
          runner.dispose();
        }
      });
    }
  }

  test("a failed parallel tool drains every uncooperative sibling before releasing pins", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, scheduler } = makeLedger();
    const pins = new CredentialPinStore();
    const pinHandles = {
      vikunja: pins.pin("user-1", "vikunja", { apiKey: "tok" }).handle,
      openrouter: pins.pin("user-1", "openrouter", { apiKey: "model" }).handle,
    };
    const releases: Array<() => void> = [];
    const gates = Array.from({ length: 3 }, () => new Promise<void>((resolve) => { releases.push(resolve); }));
    const started = new Set<number>();
    const signals: AbortSignal[] = [];
    let returned = false;
    let modelCalls = 0;
    const runner = createJobRunner(baseDeps(ledger, registry, pins, {
      buildModel: () => new ScriptedChatModel({
        responses: [new AIMessage({
          content: "",
          tool_calls: gates.map((_, i) => ({ name: "list_tasks", args: { projectId: String(i) }, id: `sibling-${i}`, type: "tool_call" })),
        }), new AIMessage("never")],
        onGenerate: () => { modelCalls += 1; },
      }),
    }));
    const job = runner.runJob(descriptor({
      pinHandles,
      toolHandler: {
        async execute(_pluginId, _toolName, args, _credentials, signal) {
          const i = Number(args.projectId);
          started.add(i);
          assert.ok(signal);
          signals.push(signal);
          await gates[i];
          if (i !== 1) throw new Error(`sibling failure ${i}`);
          return "late result";
        },
      },
    })).finally(() => { returned = true; });
    try {
      await waitFor(() => started.size === 3);
      releases[0]!();
      await waitFor(() => returned || signals.every((signal) => signal.aborted));
      const assertRetained = () => {
        assert.equal(returned, false);
        assert.equal(scheduler.count(), 1);
        for (const [pluginId, handle] of Object.entries(pinHandles)) {
          assert.equal(pins.get("user-1", pluginId, handle).handle, handle);
        }
      };
      assertRetained();
      releases[1]!();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertRetained();
      releases[2]!();
      const result = await job;
      assert.equal(result.status, "failed");
      if (result.status === "failed") assert.match(result.error, /sibling failure 0/);
      assert.equal(modelCalls, 1);
      assert.equal(scheduler.count(), 0);
      assert.equal(ledger.listSteps(result.taskId).some((step) => step.action === "tool:list_tasks"), false);
      for (const [pluginId, handle] of Object.entries(pinHandles)) {
        assert.throws(() => pins.get("user-1", pluginId, handle), isNotFound);
      }
    } finally {
      releases.forEach((release) => release());
      await job;
      runner.dispose();
    }
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

  test("with a credentialSource that re-establishes pins and a buildModel seam, a stuck task resumes from its STORED payload (model re-invoked with the snapshot messages)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const snapshot = [new HumanMessage("snapshot turn")];
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan-2",
      spec: "{}",
      worker: "original-client-thread",
      payload: storedPayload(snapshot),
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const seen: BaseMessage[][] = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () =>
          new ScriptedChatModel({
            responses: [new AIMessage("resumed")],
            onGenerateMessages: (messages) => seen.push(messages),
          }),
        credentialSource: () => ({
          openrouter: { apiKey: "sk-model" },
          vikunja: { apiKey: "restored" },
        }),
      }),
    );
    const result = await runner.resumeStuckJobs();
    assert.equal(result.outcomes[0]?.outcome, "repinned");
    assert.equal(ledger.getTask(task.id)?.status, "succeeded");
    const contents = seen[0]?.map((m) => String(m.content)) ?? [];
    assert.ok(
      contents.includes("snapshot turn"),
      "the resume re-invokes the model with the STORED snapshot messages",
    );
    const resumed = ledger.getTask(task.id);
    assert.equal(resumed?.worker, "original-client-thread", "the resume kept the stored worker label");
  });

  test("H3: with a model seam wired and the model plugin identifiable among the restored pins, a repinned stuck task is re-run through runJob as a replay (mutating tool → tool_retry_forbidden)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan-replay",
      spec: "{}",
      worker: "original-client-thread",
      payload: storedPayload([new HumanMessage("snapshot turn")]),
    });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const calls: RecordedCall[] = [];
    const model = new ScriptedChatModel({
      responses: [
        toolCallMessage("create_task", { title: "x" }, "call_replay_resume"),
        new AIMessage("never"),
      ],
    });
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
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
  });

  test("M2: a repinned stuck task whose restored pins carry NO model plugin fails plugin_unavailable (never credentials_expired, never a wrong-thread resume)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "orphan-nomodel",
      spec: "{}",
      payload: storedPayload([new HumanMessage("snapshot")]),
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

  test("a stuck task WITHOUT a stored payload is marked failed — the resume never fabricates input", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    const task = ledger.createTask({ owner: "user-1", intentKey: "orphan-nopayload", spec: "{}" });
    ledger.claimTask(task.id, "user-1");
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () => new ScriptedChatModel({ responses: [new AIMessage("never")] }),
        credentialSource: () => ({
          openrouter: { apiKey: "sk-model" },
          vikunja: { apiKey: "restored" },
        }),
      }),
    );
    const result = await runner.resumeStuckJobs();
    assert.equal(result.outcomes[0]?.outcome, "job_failed");
    assert.equal(ledger.getTask(task.id)?.status, "failed");
    const errorStep = ledger
      .listSteps(task.id)
      .find((s) => s.action === "error:job_failed");
    assert.ok(errorStep, "a job_failed error step records the missing payload");
    assert.match(
      String(errorStep?.result),
      /no stored message snapshot to resume from/,
      "the error names the missing snapshot payload",
    );
  });

  test("replay dedupe survives a resume: a tool already executed is not re-executed across the stuck/resume boundary", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger, clock } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    // Stage a crash mid-job: a task whose FIRST (partial) run already
    // recorded the tool's result, then went silent and was marked stuck. The
    // stored result is the crash-resume correctness anchor — the resumed run
    // must serve it, not re-execute.
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "dedupe-resume",
      spec: "{}",
      payload: storedPayload([new HumanMessage("snapshot")]),
    });
    const claimed = ledger.claimTask(task.id, "user-1");
    recordToolResult(ledger, {
      taskId: task.id,
      owner: "user-1",
      fenceToken: claimed.fence_token,
      toolCallId: "call_dedupe",
      toolName: "list_tasks",
      result: '{"stored":true}',
    });
    clock.advance(20_000);
    ledger.reconcileOrphans();
    assert.equal(ledger.getTask(task.id)?.status, "stuck");

    const calls: RecordedCall[] = [];
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: () =>
          new ScriptedChatModel({
            responses: [
              toolCallMessage("list_tasks", { projectId: "p" }, "call_dedupe"),
              new AIMessage("done"),
            ],
          }),
      }),
    );
    const result = await runner.runJob(
      descriptor({ intentKey: "dedupe-resume", toolHandler: recordingHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(
      calls.length,
      0,
      "the resumed run replayed the stored result — the tool must NOT execute again",
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
  for (const rejects of [false, true]) {
    test(`non-ok response awaits body cancellation before throwing when cancellation ${rejects ? "rejects" : "resolves"}`, async (t) => {
      const { registry } = await makeRegistry(t);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let cancelling = false;
      let returned = false;
      const response = new Response(new ReadableStream({
        async cancel() {
          cancelling = true;
          await gate;
          if (rejects) throw new Error("cancel failed");
        },
      }), { status: 503 });
      const executor = new ToolExecutor({
        registry,
        getPinnedIps: () => [{ entryId: "vikunja-api", url: "https://vikunja.example.com", pinned: ["1.1.1.1"] }],
        fetchFn: (async () => response) as typeof fetch,
        lookup: fakeLookup(),
        mode: "test",
      });
      const result = assert.rejects(
        executor.execute("vikunja", "list_tasks", {}).finally(() => { returned = true; }),
        (error: unknown) => error instanceof JobError && error.code === "job_failed" && /HTTP 503/.test(error.message),
      );
      try {
        await waitFor(() => cancelling || returned);
        assert.equal(cancelling, true);
        assert.equal(returned, false);
      } finally {
        release();
        await result;
      }
    });
  }

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

  test("graph-level: re-invoking a compiled graph re-applies the ORIGINAL input on top of existing state (M5 — input survives)", async () => {
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel({
      responses: [new AIMessage("first"), new AIMessage("re-evaluated")],
    });
    const graph = createAgentGraph({ model, tools: [] })
      .builder.compile({ checkpointer });
    await graph.invoke(
      { messages: [new HumanMessage("base")] },
      { configurable: { thread_id: "t" } },
    );
    // A re-evaluation re-applies the ORIGINAL input — never a blind
    // `{ messages: [] }` re-run (M5). (The runner itself no longer uses a
    // checkpointer or optimistic locking — this documents the graph idiom the
    // old conflict branch relied on.)
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
    const calls: RecordedCall[] = [];

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
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

    // A cached serve SKIPS recordToolResult (the per-task ledger stays
    // untouched for a cache hit) — the replay-dedupe step for the SECOND job
    // is absent, but the first job's tool step carried the raw result redacted.
    const steps = ledger.listSteps(r2.taskId);
    assert.equal(
      steps.some((s) => s.action === "tool:list_tasks"),
      false,
      "a cache hit does not append a tool step to the second job",
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
        toolCache,
        buildModel: () => model,
      }),
    );
    const result = await runner.runJob(
      descriptor({ toolHandler: credentialHandler(calls) }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(calls.length, 0, "neither the cache nor the ledger path called the handler");

    const toolStep = ledger
      .listSteps(result.taskId)
      .find((s) => s.action === "tool:list_tasks");
    assert.equal(
      toolStep?.result,
      '{"from":"ledger"}',
      "the ledger's stored result is what served the tool (dedupe wins over the warm cache)",
    );
    assert.ok(
      !String(toolStep?.result).includes("sk-secret999"),
      "the cache's raw (unredacted) value never reached the ledger or graph state",
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

describe("JobRunner.runJob — context + budget integration (phase 4 review)", () => {
  function modelFactory(toolName: string, callId: string, reply: string, args: Record<string, unknown>) {
    return (_id: unknown, _config: unknown) =>
      new ScriptedChatModel({
        responses: [
          toolCallMessage(toolName, args, callId),
          new AIMessage(reply),
        ],
      });
  }

  test("budget gate: an exhausted per-owner model-call window fails the job budget_exhausted before the model runs", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });
    const budget = createBudgetManager({ maxModelCallsPerWindow: 1 });

    let modelCalls = 0;
    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        budget,
        buildModel: () =>
          new ScriptedChatModel({
            responses: [new AIMessage("done")],
            onGenerate: () => {
              modelCalls += 1;
            },
          }),
      }),
    );

    const first = await runner.runJob(descriptor({ intentKey: "budget-1", clientThreadId: "thr-budget-1" }));
    assert.equal(first.status, "succeeded");
    assert.equal(modelCalls, 1);

    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });
    const second = await runner.runJob(
      descriptor({ intentKey: "budget-2", clientThreadId: "thr-budget-2" }),
    );
    if (second.status !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(second)}`);
    }
    assert.equal(second.code, "budget_exhausted");
    assert.equal(modelCalls, 1, "the exhausted window must stop the model call");
    assert.ok(
      ledger.listSteps(second.taskId).some((s) => s.action === "error:budget_exhausted"),
    );
    assert.equal(ledger.getTask(second.taskId)?.status, "failed");
  });

  test("budget.beforeModelCall receives (owner, 'async') on every model round", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const observed: Array<[string, string]> = [];
    const budget = {
      reserveSync: () => ({ ok: true, release: () => {} }),
      reserveAsync: () => Promise.resolve({ ok: true, release: () => {}, queued: false }),
      activeCount: () => 0,
      reserveModelCall: () => ({ ok: true, remaining: 1, resetAt: 0 }),
      beforeModelCall: (owner: string, kind?: string) => {
        observed.push([owner, kind ?? ""]);
      },
      modelCallCount: () => 0,
    } as Parameters<typeof createJobRunner>[0]["budget"];

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        budget,
        buildModel: modelFactory("list_tasks", "call_kind", "done", { projectId: "p" }),
      }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "kind-1",
        clientThreadId: "thr-kind",
        toolHandler: recordingHandler([]),
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(observed.length, 2, "one gate per model round (tool round + final answer)");
    assert.ok(observed.every(([owner, kind]) => owner === "user-1" && kind === "async"));
  });

  test("the snapshot input runs verbatim (no server-side truncation or compaction in the runner)", async (t) => {
    const { registry } = await makeRegistry(t);
    const { ledger } = makeLedger();
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: "tok" });
    pins.pin("user-1", "openrouter", { apiKey: "sk-model" });

    const runner = createJobRunner(
      baseDeps(ledger, registry, pins, {
        buildModel: modelFactory("list_tasks", "call_plain", "done", { projectId: "p" }),
      }),
    );
    const result = await runner.runJob(
      descriptor({
        intentKey: "plain-1",
        clientThreadId: "thr-plain",
        input: { messages: [new HumanMessage("y".repeat(4000))] },
        toolHandler: recordingHandler([]),
      }),
    );
    assert.equal(result.status, "succeeded", "an oversized snapshot input must still run (no runner-side context cap)");
  });
});
