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
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";

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

async function makeRegistry(
  t: TestContext,
): Promise<{ registry: PluginRegistry; store: PluginStore }> {
  const dir = await mkdtemp(join(tmpdir(), "jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [],
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
    threadId: "thr-1",
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
      configurable: { thread_id: "thr-1" },
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
        descriptor({ intentKey: "job-a", threadId: "shared", modelRequestConfig: "a" }),
      ),
      runner.runJob(
        descriptor({ intentKey: "job-b", threadId: "shared", modelRequestConfig: "b" }),
      ),
    ]);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.equal(maxActive, 1, "only one invoke may run per thread at a time");

    const checkpoint = await checkpointer.get({
      configurable: { thread_id: "shared" },
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

  test("the optimistic-lock re-evaluation idiom: graph.invoke({ messages: [] }) re-reads and re-evaluates the merged state (never a blind retry)", async () => {
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel({
      responses: [new AIMessage("first"), new AIMessage("re-evaluated")],
    });
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model, tools: [] }),
      checkpointer,
    );
    await graph.invoke(
      { messages: [new HumanMessage("hi")] },
      { configurable: { thread_id: "t" } },
    );
    // A conflict detected after our write would re-run this exact evaluation.
    const result = await graph.invoke(
      { messages: [] },
      { configurable: { thread_id: "t" } },
    );
    assert.equal(result.messages.length, 3);
    assert.equal(String(result.messages[2]?.content), "re-evaluated");
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
});
