import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  BaseChatModelCallOptions,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { CheckpointStore } from "../../src/checkpoints/store.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type {
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import { createChatRoutes } from "../../src/transport/chat.ts";
import { toLangChainMessages } from "../../src/transport/chat.ts";
import type { JobModelRequestConfig } from "../../src/transport/chat.ts";
import {
  buildModel,
  createValidatedFetchAdapter,
  ModelBuildError,
} from "../../src/transport/model.ts";
import type { BuildModelInput } from "../../src/transport/model.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import { ThreadLockRegistry } from "../../src/jobs/thread_lock.ts";
import type {
  JobDescriptor,
  JobErrorCode,
  JobRunner,
  RunJobResult,
} from "../../src/jobs/runner.ts";

/**
 * Wave C1 chat-transport tests. Everything is fake/in-memory: a real
 * `PluginStore` over a temp dir (OpenRouter builtin + a tool plugin), an
 * optional fake checkpoint store wrapping an in-memory `MemorySaver`, and a
 * **fake model injected via the `buildModel` seam** (records the `BuildModelInput`
 * it received AND the message history the graph fed the model, so the seed/
 * resume rule and the body-credential sourcing are assertable without any
 * network).
 */

function openRouterPlugin(): ModelPluginDefinition {
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

function toolPlugin(): ToolPluginDefinition {
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
        description: "List tasks",
        readOnly: true,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Token", required: true } },
  };
}

const DNS: Record<string, LookupAddress[]> = {
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
};

function fakeLookup(records: Record<string, readonly LookupAddress[]> = DNS): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chat-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeEnv(
  dir: string,
): Promise<{ store: PluginStore; registry: PluginRegistry }> {
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [openRouterPlugin(), toolPlugin()],
    manifests: [],
    lookup: fakeLookup(),
  });
  await store.load();
  return { store, registry: new PluginRegistry(store) };
}

/**
 * Fake checkpoint store: an in-memory `MemorySaver` checkpointer (so the
 * seed/resume detection via `checkpointer.get` is real) + a minimal
 * `thread_owner` metadata table.
 */
function fakeCheckpointStore(): CheckpointStore {
  const checkpointer = new MemorySaver();
  const threads = new Map<string, { owner: string; lastError: string | null }>();
  return {
    checkpointer,
    async close() {},
    touchThread(owner, threadId, lastError = null) {
      threads.set(threadId, { owner, lastError });
    },
    getThread(threadId) {
      const t = threads.get(threadId);
      return t
        ? { threadId, owner: t.owner, createdAt: 0, updatedAt: 0, lastError: t.lastError }
        : undefined;
    },
    listThreads() {
      return [];
    },
    deleteThread() {
      return false;
    },
    deleteThreadsForOwner() {
      return 0;
    },
  };
}

type FakeBuildModel = {
  buildModelFn: typeof buildModel;
  /** Every `BuildModelInput` handed to the seam, in call order. */
  calls: BuildModelInput[];
  /** Every message array fed to the model, in call order (shared across
   *  `bindTools` copies). Each entry is ONE model turn. */
  recordedInputs: BaseMessage[][];
};

/**
 * The `buildModel` test seam: records its input and returns a streaming
 * scripted model whose single orchestrator turn streams the reply for that
 * request's call index (`replies[i]`), recording the messages it saw.
 */
function makeFakeBuildModel(
  replies: Array<Array<Record<string, unknown>>>,
): FakeBuildModel {
  const calls: BuildModelInput[] = [];
  const recordedInputs: BaseMessage[][] = [];
  const buildModelFn = ((input: BuildModelInput) => {
    const index = calls.length;
    calls.push(input);
    const reply = replies[index];
    return new RecordingChatModel(reply ? [reply] : [], recordedInputs);
  }) as typeof buildModel;
  return { buildModelFn, calls, recordedInputs };
}

/** Scripted streaming model that records every `_generate`/stream input. */
class RecordingChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  readonly recordedInputs: BaseMessage[][];
  private turns: Array<Record<string, unknown>>[];

  constructor(
    turns: Array<Array<Record<string, unknown>>>,
    recordedInputs: BaseMessage[][],
    options: BaseChatModelParams = {},
  ) {
    super(options);
    this.turns = turns.map((turn) => [...turn]);
    this.recordedInputs = recordedInputs;
  }

  _llmType(): string {
    return "recording-chat";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new RecordingChatModel(
      this.turns.map((turn) => [...turn]),
      this.recordedInputs,
    );
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.recordedInputs.push(_messages);
    return { generations: [{ message: new AIMessage("(scripted)"), text: "" }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.recordedInputs.push(_messages);
    const turn = this.turns.shift() ?? [];
    for (const fields of turn) {
      const chunk = new AIMessageChunk(fields);
      const text = typeof chunk.content === "string" ? chunk.content : "";
      const generation = new ChatGenerationChunk({ message: chunk, text });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
        chunk: generation,
      });
      yield generation;
    }
  }
}

/**
 * Scripted streaming model whose `_streamResponseChunks` serializes on an
 * injected `active` tracker while it runs. Used by the per-thread-lock tests to
 * prove two concurrent streams on one thread never overlap a model turn.
 */
class SlowScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private turns: Array<Array<Record<string, unknown>>>;
  readonly recordedInputs: BaseMessage[][];
  private readonly delayMs: number;
  private readonly active: { current: number; max: number };

  constructor(opts: {
    turns: Array<Array<Record<string, unknown>>>;
    recordedInputs: BaseMessage[][];
    delayMs: number;
    active: { current: number; max: number };
  }) {
    super({});
    this.turns = opts.turns.map((turn) => [...turn]);
    this.recordedInputs = opts.recordedInputs;
    this.delayMs = opts.delayMs;
    this.active = opts.active;
  }

  _llmType(): string {
    return "slow-scripted";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new SlowScriptedChatModel({
      turns: this.turns,
      recordedInputs: this.recordedInputs,
      delayMs: this.delayMs,
      active: this.active,
    });
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.recordedInputs.push(_messages);
    return { generations: [{ message: new AIMessage("(scripted)"), text: "" }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.active.current += 1;
    this.active.max = Math.max(this.active.max, this.active.current);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.recordedInputs.push(_messages);
      const turn = this.turns.shift() ?? [];
      for (const fields of turn) {
        const chunk = new AIMessageChunk(fields);
        const text = typeof chunk.content === "string" ? chunk.content : "";
        const generation = new ChatGenerationChunk({ message: chunk, text });
        await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
          chunk: generation,
        });
        yield generation;
      }
    } finally {
      this.active.current -= 1;
    }
  }
}

type AppOptions = {
  verifyKey?: VerifyApiKeyFn;
  limiter?: (key: string) => boolean;
  checkpointStore?: CheckpointStore;
  buildModel?: typeof buildModel;
  jobRunner?: JobRunner;
  pins?: CredentialPinStore;
  ledger?: Ledger;
  threadLocks?: ThreadLockRegistry;
};

async function makeApp(
  t: TestContext,
  opts: AppOptions = {},
): Promise<{ app: Hono; store: PluginStore; registry: PluginRegistry }> {
  const dir = await makeTempDir(t);
  const { store, registry } = await makeEnv(dir);
  const app = new Hono();
  app.route(
    "/v1",
    createChatRoutes({
      registry,
      pluginStore: store,
      checkpointStore: opts.checkpointStore,
      verifyKey: opts.verifyKey ?? (async () => "test-user"),
      limiter: opts.limiter ?? (() => true),
      buildModel: opts.buildModel,
      jobRunner: opts.jobRunner,
      pins: opts.pins,
      ledger: opts.ledger,
      threadLocks: opts.threadLocks,
      trustedHosts: [],
    }),
  );
  return { app, store, registry };
}

/** In-memory ledger for background-admission assertions (same shape as the
 *  job-runner tests: real Ledger on an in-memory SQLite DB). */
function makeLedger(): Ledger {
  const db = new Database(":memory:");
  migrateLedger(db);
  return new Ledger(db, { stuckTimeoutMs: 10_000, leaseExpiryMs: 60_000 });
}

type FakeJobRunner = {
  runJob: JobRunner["runJob"];
  /** Every descriptor handed to `runJob`, in call order. */
  calls: JobDescriptor[];
};

/** A recording fake `JobRunner` that returns the scripted results in order. */
function makeFakeJobRunner(results: RunJobResult[]): FakeJobRunner {
  const calls: JobDescriptor[] = [];
  const runJob: JobRunner["runJob"] = async (descriptor) => {
    calls.push(descriptor);
    return results[Math.min(calls.length, results.length) - 1]!;
  };
  return { runJob, calls };
}

function postChat(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Body fixture the client sends today (legacy fields included). */
function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openrouter",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    chat_template_kwargs: { enable_thinking: false },
    enable_thinking: false,
    credentials: { openrouter: { apiKey: "sk-test-123" } },
    ...overrides,
  };
}

/** Split an SSE body into frames: payload objects, or `null` for `[DONE]`. */
function parseFrames(text: string): Array<Record<string, unknown> | null> {
  return text
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      const payload = line.slice("data: ".length);
      return payload === "[DONE]" ? null : (JSON.parse(payload) as Record<string, unknown>);
    });
}

function finishReasons(frames: Array<Record<string, unknown> | null>): Array<string | null> {
  return frames
    .filter((f): f is Record<string, unknown> => f !== null)
    .map((f) => {
      const choices = f["choices"] as Array<{ finish_reason?: string | null }> | undefined;
      return choices?.[0]?.finish_reason ?? null;
    });
}

/** String contents of a recorded model turn, excluding the graph's system prompt. */
function contentsOf(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m.constructor.name !== "SystemMessage")
    .map((m) => m.content)
    .filter((c): c is string => typeof c === "string");
}

describe("POST /v1/chat/completions — pre-stream errors (§5.1)", () => {
  test("401 { error: unauthorized } without a gateway key", async (t) => {
    const { app } = await makeApp(t, { verifyKey: async () => null });
    const res = await postChat(app, chatBody());
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("429 { error: rate_limited } when the limiter rejects", async (t) => {
    const { app } = await makeApp(t, { limiter: () => false });
    const res = await postChat(app, chatBody());
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "rate_limited" });
  });

  test("400 { error: invalid_request } on a non-JSON body", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this is not json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
  });

  test("400 { error: invalid_request } for an unknown or non-model plugin id", async (t) => {
    const { app } = await makeApp(t);
    const unknown = await postChat(app, chatBody({ model: "does-not-exist" }));
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "invalid_request" });

    // "vikunja" is an installed TOOL plugin — never a model.
    const tool = await postChat(app, chatBody({ model: "vikunja" }));
    assert.equal(tool.status, 400);
    assert.deepEqual(await tool.json(), { error: "invalid_request" });
  });

  test("400 { error: invalid_credentials } when the model key is missing from the body", async (t) => {
    const { app } = await makeApp(t);
    // No body.credentials at all — even WITH the gateway Authorization header
    // (the header is gateway auth, NOT the provider key).
    const res = await postChat(app, chatBody({ credentials: undefined }), {
      authorization: "Bearer gateway-key",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_credentials" });
  });

  test("400 { error: invalid_credentials } for an invalid key value", async (t) => {
    const { app } = await makeApp(t);
    const res = await postChat(app, chatBody({ credentials: { openrouter: { apiKey: " " } } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_credentials" });
  });

  test("400 { error: invalid_request } when messages are missing/empty", async (t) => {
    const { app } = await makeApp(t);
    const missing = await postChat(app, chatBody({ messages: undefined }));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "invalid_request" });
    const empty = await postChat(app, chatBody({ messages: [] }));
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "invalid_request" });
  });
});

describe("POST /v1/chat/completions — async delegation (background: true, Wave C2)", () => {
  test("happy path: admits a task, pins model + tool credentials, delegates runJob with the right descriptor", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([
      { status: "succeeded", taskId: "task-1", threadId: "thr-hash" },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore,
      pins,
      ledger,
      jobRunner: fake as unknown as JobRunner,
    });

    const res = await postChat(
      app,
      chatBody({
        background: true,
        messageId: "msg-1",
        thread_id: "thread-1",
        messages: [{ role: "user", content: "list my tasks" }],
        credentials: {
          openrouter: { apiKey: "sk-test-123" },
          vikunja: { apiKey: "tok-123" },
        },
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "succeeded",
      taskId: "task-1",
      threadId: "thr-hash",
    });

    assert.equal(fake.calls.length, 1, "runJob delegated exactly once");
    const d = fake.calls[0]!;
    assert.equal(d.owner, "test-user");
    assert.equal(d.intentKey, "msg-1");
    assert.equal(d.spec, "list my tasks", "spec = last user message text");
    assert.equal(d.clientThreadId, "thread-1");
    assert.equal(d.modelPluginId, "openrouter");
    assert.deepEqual(d.toolPlugins, ["vikunja"]);
    const requestConfig = d.modelRequestConfig as JobModelRequestConfig;
    assert.equal(requestConfig.owner, "test-user");
    const input = d.input as { messages: BaseMessage[] };
    assert.equal(input.messages.length, 1, "fresh thread seeds from client history");

    // Model + tool credentials are pinned for the job (the runner resolves them).
    assert.deepEqual(pins.get("test-user", "openrouter").credentials, {
      apiKey: "sk-test-123",
    });
    assert.deepEqual(pins.get("test-user", "vikunja").credentials, {
      apiKey: "tok-123",
    });
    // The task was admitted owner-scoped by (owner, messageId).
    const admitted = ledger.getTaskByIntentKey("test-user", "msg-1");
    assert.ok(admitted, "task admitted by (owner, messageId)");
    assert.equal(admitted!.spec, "list my tasks");
    assert.equal(ledger.getTaskByIntentKey("other-user", "msg-1"), null);
  });

  test("a background request without thread_id runs on a thread keyed by its messageId", async (t) => {
    const fake = makeFakeJobRunner([
      { status: "succeeded", taskId: "task-1", threadId: "thr-1" },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      pins: new CredentialPinStore(),
      ledger: makeLedger(),
      jobRunner: fake as unknown as JobRunner,
    });
    const res = await postChat(app, chatBody({ background: true, messageId: "msg-no-thread" }));
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(fake.calls[0]!.clientThreadId, "msg-no-thread");
  });

  test("idempotent retry: the same messageId admits ONE task; the second delegate returns already_terminal", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([
      { status: "succeeded", taskId: "task-1", threadId: "thr-1" },
      {
        status: "already_terminal",
        taskId: "task-1",
        threadId: "thr-1",
        terminalStatus: "succeeded",
      },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore,
      pins,
      ledger,
      jobRunner: fake as unknown as JobRunner,
    });

    const res1 = await postChat(app, chatBody({ background: true, messageId: "msg-same" }));
    assert.equal(res1.status, 200);

    const res2 = await postChat(app, chatBody({ background: true, messageId: "msg-same" }));
    assert.equal(res2.status, 200);
    assert.deepEqual(await res2.json(), {
      status: "succeeded",
      taskId: "task-1",
      threadId: "thr-1",
    });

    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0]!.intentKey, "msg-same");
    assert.equal(fake.calls[1]!.intentKey, "msg-same");
    const tasks = ledger.listTasks("test-user").filter((task) => task.intent_key === "msg-same");
    assert.equal(tasks.length, 1, "one task row per (owner, messageId)");
  });

  test("a duplicate while the first job runs maps to 202 { status: accepted }", async (t) => {
    const fake = makeFakeJobRunner([
      { status: "in_flight", taskId: "task-1", threadId: "thr-1" },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      pins: new CredentialPinStore(),
      ledger: makeLedger(),
      jobRunner: fake as unknown as JobRunner,
    });
    const res = await postChat(app, chatBody({ background: true, messageId: "msg-running" }));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), {
      status: "accepted",
      taskId: "task-1",
      threadId: "thr-1",
    });
  });

  test("missing messageId -> 400 invalid_request, runJob never called", async (t) => {
    const fake = makeFakeJobRunner([]);
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      pins: new CredentialPinStore(),
      ledger: makeLedger(),
      jobRunner: fake as unknown as JobRunner,
    });
    const res = await postChat(app, chatBody({ background: true }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "invalid_request",
      message: "messageId required for background requests",
    });
    assert.equal(fake.calls.length, 0);
  });

  test("async path not wired (no runner/checkpointer/ledger/pins) -> 503 background_unavailable", async (t) => {
    const { app } = await makeApp(t); // no checkpointStore/jobRunner/pins/ledger
    const res = await postChat(app, chatBody({ background: true, messageId: "msg-x" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "background_unavailable" });
  });

  test("checkpointStore present but jobRunner absent -> 503 background_unavailable", async (t) => {
    const { app } = await makeApp(t, { checkpointStore: fakeCheckpointStore() });
    const res = await postChat(app, chatBody({ background: true, messageId: "msg-x" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "background_unavailable" });
  });

  test("an invalid tool-plugin credential -> 400 invalid_credentials before admission, nothing pinned, no task", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([]);
    const { app } = await makeApp(t, {
      checkpointStore,
      pins,
      ledger,
      jobRunner: fake as unknown as JobRunner,
    });
    const res = await postChat(
      app,
      chatBody({
        background: true,
        messageId: "msg-bad-tool",
        credentials: { openrouter: { apiKey: "sk-test-123" }, vikunja: { apiKey: "  " } },
      }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_credentials" });
    assert.equal(fake.calls.length, 0);
    assert.equal(ledger.getTaskByIntentKey("test-user", "msg-bad-tool"), null);
    assert.throws(
      () => pins.get("test-user", "openrouter"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "a rejected admission must not leave a model pin behind",
    );
  });

  test("runJob failed: JobErrorCode -> HTTP mapping", async (t) => {
    const cases: Array<{ code: JobErrorCode; status: number }> = [
      { code: "credentials_expired", status: 401 },
      { code: "task_conflict", status: 409 },
      { code: "tool_retry_forbidden", status: 409 },
      { code: "plugin_unavailable", status: 502 },
      { code: "job_failed", status: 500 },
    ];
    for (const { code, status } of cases) {
      const fake = makeFakeJobRunner([
        { status: "failed", taskId: "t", threadId: "thr", code, error: `boom-${code}` },
      ]);
      const { app } = await makeApp(t, {
        checkpointStore: fakeCheckpointStore(),
        pins: new CredentialPinStore(),
        ledger: makeLedger(),
        jobRunner: fake as unknown as JobRunner,
      });
      const res = await postChat(app, chatBody({ background: true, messageId: `msg-${code}` }));
      assert.equal(res.status, status, `${code} -> HTTP ${status}`);
      assert.deepEqual(await res.json(), { error: code, message: `boom-${code}` });
    }
  });

  test("a non-boolean background value is rejected, never silently run synchronously", async (t) => {
    const fake = makeFakeJobRunner([]);
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      pins: new CredentialPinStore(),
      ledger: makeLedger(),
      jobRunner: fake as unknown as JobRunner,
    });
    const res = await postChat(app, chatBody({ background: "yes", messageId: "msg-x" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "invalid_request",
      message: "background must be a boolean",
    });
    assert.equal(fake.calls.length, 0);
  });
});

describe("POST /v1/chat/completions — sync path per-thread lock (Wave C2)", () => {
  test("two concurrent streams on the same thread serialize under the shared lock (no interleaved model turn)", async (t) => {
    const tracker = { current: 0, max: 0 };
    const recordedInputs: BaseMessage[][] = [];
    const buildModelFn = ((_input: BuildModelInput) =>
      new SlowScriptedChatModel({
        turns: [[{ content: "reply" }]],
        recordedInputs,
        delayMs: 40,
        active: tracker,
      })) as typeof buildModel;
    const locks = new ThreadLockRegistry();
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      buildModel: buildModelFn,
      threadLocks: locks,
    });

    // Both requests are dispatched before either body is consumed. The first
    // handler acquires the thread's mutex and returns its Response; the second
    // handler blocks on the mutex until the first stream has fully completed.
    const res1Promise = postChat(
      app,
      chatBody({ thread_id: "shared", messages: [{ role: "user", content: "one" }] }),
    );
    const res2Promise = postChat(
      app,
      chatBody({ thread_id: "shared", messages: [{ role: "user", content: "two" }] }),
    );
    const res1 = await res1Promise;
    const text1Promise = res1.text();
    const res2 = await res2Promise;
    const text2Promise = res2.text();
    const [text1, text2] = await Promise.all([text1Promise, text2Promise]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    assert.ok(text1.includes("data: [DONE]"));
    assert.ok(text2.includes("data: [DONE]"));
    assert.equal(tracker.max, 1, "only one stream may run per thread at a time");
    assert.ok(
      recordedInputs.some((turn) =>
        turn.some((m) => String(m.content) === "one"),
      ),
      "the first request's message reached the model",
    );
    assert.ok(
      recordedInputs.some((turn) =>
        turn.some((m) => String(m.content) === "two"),
      ),
      "the second request's message reached the model (after the first stream completed)",
    );
  });

  test("a finished sync stream releases the thread's mutex (lock registry GCs it)", async (t) => {
    const buildModelFn = ((_input: BuildModelInput) =>
      new SlowScriptedChatModel({
        turns: [[{ content: "hi" }]],
        recordedInputs: [],
        delayMs: 5,
        active: { current: 0, max: 0 },
      })) as typeof buildModel;
    const locks = new ThreadLockRegistry();
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      buildModel: buildModelFn,
      threadLocks: locks,
    });
    const res = await postChat(
      app,
      chatBody({ thread_id: "gc-1", messages: [{ role: "user", content: "x" }] }),
    );
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(locks.size, 0, "the finished stream's mutex must be evicted");
  });
});

describe("POST /v1/chat/completions — happy path (stateless)", () => {
  test("SSE response: text/event-stream, no-cache, [DONE], finish chunk, no mid-stream finish_reason", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "Hello" }, { content: " world" }, { content: "." }],
    ]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const res = await postChat(app, chatBody());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-cache");

    const text = await res.text();
    assert.ok(text.includes("data: [DONE]\n\n"), "exactly-one [DONE] terminator present");
    const frames = parseFrames(text);
    assert.equal(frames[frames.length - 1], null, "stream terminates with [DONE]");

    const reasons = finishReasons(frames);
    assert.ok(reasons.length >= 3, "content deltas plus the terminal chunk");
    assert.deepEqual(
      reasons.slice(0, -1),
      reasons.slice(0, -1).map(() => null),
      "no mid-stream finish_reason",
    );
    assert.equal(reasons[reasons.length - 1], "stop", "finish chunk carries stop");

    const first = frames[0] as Record<string, unknown>;
    assert.equal(first["model"], "openrouter/auto", "SSE model echoes the resolved provider model");
  });

  test("model key comes from body.credentials[modelPluginId], not the Authorization header", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    // The gateway key on the Authorization header does NOT satisfy the model
    // credential (asserted above); with the body credential present, the seam
    // receives exactly that key.
    const res = await postChat(app, chatBody(), { authorization: "Bearer gateway-key" });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.modelPluginId, "openrouter");
    assert.equal(fake.calls[0]!.credentials.apiKey, "sk-test-123");
    assert.equal(fake.calls[0]!.requestModel, undefined);
  });

  test("legacy fields tolerated (chat_template_kwargs/enable_thinking); temperature/max_tokens forwarded", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const res = await postChat(
      app,
      chatBody({
        chat_template_kwargs: { enable_thinking: false },
        enable_thinking: false,
        temperature: 0.5,
        max_tokens: 128,
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));

    assert.equal(fake.calls[0]!.requestParameters?.["temperature"], 0.5);
    assert.equal(fake.calls[0]!.requestParameters?.["maxTokens"], 128);
  });

  test("stateless when no checkpoint store: client messages used verbatim, thread_id ignored", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }); // no checkpointStore

    const res = await postChat(
      app,
      chatBody({
        thread_id: "client-thread-1",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "assistant reply" },
          { role: "user", content: "second" },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));

    const turn = fake.recordedInputs[0]!;
    const contents = contentsOf(turn);
    assert.ok(contents.includes("first"), "client history fed verbatim");
    assert.ok(contents.includes("assistant reply"));
    assert.ok(contents.includes("second"));
  });
});

describe("POST /v1/chat/completions — seed/resume with a checkpoint store", () => {
  test("first call seeds from client history; second call with the same thread_id resumes with ONLY the last user message", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "First reply" }],
      [{ content: "Second reply" }],
    ]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn });

    // Call 1 — SEED: the client's full history creates the checkpoint.
    const res1 = await postChat(
      app,
      chatBody({
        thread_id: "thread-1",
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    );
    assert.equal(res1.status, 200);
    const text1 = await res1.text();
    assert.ok(text1.includes("data: [DONE]"), "seed call streams");

    assert.equal(fake.calls.length, 1);
    const seedTurn = fake.recordedInputs[0]!;
    const seedContents = contentsOf(seedTurn);
    assert.deepEqual(seedContents, ["first", "second"], "seed = client history");

    // Call 2 — RESUME: the client now sends only its latest message; the server
    // ignores the (shorter) client history and appends ONLY the last user
    // message on top of the checkpointed state.
    const res2 = await postChat(
      app,
      chatBody({
        thread_id: "thread-1",
        messages: [{ role: "user", content: "third" }],
      }),
    );
    assert.equal(res2.status, 200);
    const text2 = await res2.text();
    assert.ok(text2.includes("data: [DONE]"), "resume call streams");

    assert.equal(fake.calls.length, 2);
    const resumeTurn = fake.recordedInputs[1]!;
    const resumeContents = contentsOf(resumeTurn);
    assert.deepEqual(
      resumeContents,
      ["first", "second", "First reply", "third"],
      "resume = checkpointed history + ONLY the last user message",
    );
  });

  test("distinct owners map to distinct threads (owner-scoped hashing)", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "A reply" }],
      [{ content: "B reply" }],
    ]);
    const checkpointStore = fakeCheckpointStore();
    // Second owner: a verifyKey stub that returns owner B on the 2nd call.
    let calls = 0;
    const verifyKey = async () => {
      calls += 1;
      return calls === 1 ? "owner-a" : "owner-b";
    };
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn, verifyKey });

    const res1 = await postChat(
      app,
      chatBody({ thread_id: "thread-1", messages: [{ role: "user", content: "a" }] }),
    );
    assert.equal(res1.status, 200);
    await res1.text();

    const res2 = await postChat(
      app,
      chatBody({ thread_id: "thread-1", messages: [{ role: "user", content: "b" }] }),
    );
    assert.equal(res2.status, 200);
    await res2.text();

    const turn2 = fake.recordedInputs[1]!;
    const contents = contentsOf(turn2);
    assert.deepEqual(
      contents,
      ["b"],
      "owner B starts a FRESH thread (no checkpoint from owner A's thread)",
    );
  });
});

describe("transport/model.ts — model construction + SSRF fetch seam", () => {
  test("buildModel wires configuration.baseURL + a validatedFetch-backed fetch (never the global fetch)", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "sk-test" },
    });
    const clientConfig = (
      model as unknown as { clientConfig: { baseURL?: string; fetch?: unknown } }
    ).clientConfig;
    assert.equal(clientConfig.baseURL, "https://openrouter.ai/api/v1");
    assert.equal(typeof clientConfig.fetch, "function");
    assert.notEqual(clientConfig.fetch, globalThis.fetch, "raw global fetch is never used");
  });

  test("buildModel resolves requestModel over the plugin defaultModel", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      requestModel: "anthropic/claude-3.5-sonnet",
      credentials: { apiKey: "sk-test" },
    });
    assert.equal((model as unknown as { model: string }).model, "anthropic/claude-3.5-sonnet");
  });

  test("buildModel error codes: missing_credentials / plugin_not_model / plugin_not_found", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);

    assert.throws(
      () => buildModel({ registry, pluginStore: store, modelPluginId: "openrouter", credentials: {} }),
      (err: unknown) =>
        err instanceof ModelBuildError && err.code === "missing_credentials",
    );
    assert.throws(
      () =>
        buildModel({
          registry,
          pluginStore: store,
          modelPluginId: "vikunja",
          credentials: { apiKey: "x" },
        }),
      (err: unknown) => err instanceof ModelBuildError && err.code === "plugin_not_model",
    );
    assert.throws(
      () =>
        buildModel({
          registry,
          pluginStore: store,
          modelPluginId: "ghost",
          credentials: { apiKey: "x" },
        }),
      (err: unknown) => err instanceof ModelBuildError && err.code === "plugin_not_found",
    );
  });

  test("validated-fetch adapter rejects a private-range endpoint via injected lookup (DNS_REBINDING)", async () => {
    const lookup: LookupFn = async (hostname) =>
      hostname === "evil.internal"
        ? [{ address: "10.0.0.5", family: 4 }]
        : [];
    const adapter = createValidatedFetchAdapter({
      lookup,
      mode: "test",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    await assert.rejects(
      adapter("https://evil.internal/api/chat", {}),
      (err: unknown) =>
        err instanceof SsrfValidationError && err.code === "DNS_REBINDING",
    );
  });

  test("validated-fetch adapter forwards a public endpoint to the injected fetchFn with redirect: manual", async () => {
    let seenUrl: string | null = null;
    let seenInit: RequestInit | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const adapter = createValidatedFetchAdapter({
      lookup: fakeLookup(),
      mode: "test",
      fetchFn,
    });
    const res = await adapter("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.equal(seenUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(seenInit?.redirect, "manual", "validatedFetch forces redirect: manual");
  });

  test("admin-trusted internal hosts are NOT rejected (trustedHosts honored)", async () => {
    const lookup: LookupFn = async (hostname) =>
      hostname === "vikunja.local" ? [{ address: "192.168.1.10", family: 4 }] : [];
    const adapter = createValidatedFetchAdapter({
      lookup,
      mode: "test",
      trustedHosts: ["*.local"],
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    const res = await adapter("https://vikunja.local/api/chat", {});
    assert.equal(res.status, 200);
  });
});

describe("toLangChainMessages (role mapping)", () => {
  test("maps system/user/assistant/tool and tolerates legacy function + unknown roles", () => {
    const messages = toLangChainMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_tasks", arguments: '{"projectId":"p1"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "function", name: "list_tasks", content: "old result" },
      { role: "mystery", content: "ignored" },
    ]);

    assert.equal(messages.length, 5);
    assert.equal(messages[0]!.constructor.name, "SystemMessage");
    assert.equal(messages[1]!.constructor.name, "HumanMessage");
    assert.equal(messages[2]!.constructor.name, "AIMessage");
    const ai = messages[2] as AIMessage;
    assert.equal(ai.tool_calls?.[0]?.name, "list_tasks");
    assert.deepEqual(ai.tool_calls?.[0]?.args, { projectId: "p1" });
    assert.equal(messages[3]!.constructor.name, "ToolMessage");
    assert.equal(messages[4]!.constructor.name, "ToolMessage");
  });
});