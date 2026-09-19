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
  HumanMessage,
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
import { checkpointThreadId } from "../../src/checkpoints/store.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ToolCallHandler } from "../../src/agents/orchestrator.ts";
import type {
  AgentPluginDefinition,
  ModelPluginDefinition,
  PluginDefinition,
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
import { createPerOwnerRateLimiter } from "../../src/middleware/rate_limit.ts";
import type { PerOwnerRateLimiter } from "../../src/middleware/rate_limit.ts";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import type { BudgetManager } from "../../src/middleware/budget.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import type { ToolResultCache } from "../../src/middleware/cache.ts";
import { redactForCheckpoint } from "../../src/checkpoints/store.ts";
import { createContextManager, estimateMessagesTokens } from "../../src/middleware/context.ts";
import type { ContextManager } from "../../src/middleware/context.ts";
import { createWarmupManager } from "../../src/middleware/warmup.ts";
import type { WarmupManager } from "../../src/middleware/warmup.ts";
import { JobRunner as RealJobRunner } from "../../src/jobs/runner.ts";
import { SUPERVISOR_PROMPT } from "../../src/agents/prompts.ts";
import { SystemMessage } from "@langchain/core/messages";

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
      {
        name: "create_task",
        description: "Create a task",
        readOnly: false,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Token", required: true } },
  };
}

function agentPlugin(overrides?: Partial<AgentPluginDefinition>): AgentPluginDefinition {
  return {
    id: "kitchen-copilot",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Kitchen Copilot",
    description: "Mealie-powered cooking assistant",
    systemPrompt: "You are a kitchen assistant. Use tools sparingly.",
    tools: [{ pluginId: "vikunja", required: true }],
    ...overrides,
  } satisfies AgentPluginDefinition;
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
  extraPlugins?: PluginDefinition[],
): Promise<{ store: PluginStore; registry: PluginRegistry }> {
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [openRouterPlugin(), toolPlugin(), ...(extraPlugins ?? [])],
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
  const threads = new Map<string, { owner: string; lastError: string | null; publicId?: string | null; deleted?: boolean }>();
  return {
    checkpointer,
    async close() {},
    touchThread(owner, threadId, lastError = null, publicId) {
      if (threads.get(threadId)?.deleted) throw new Error("thread_deleted");
      const existing = threads.get(threadId);
      if (existing && existing.owner !== owner) throw new Error("thread_mapping_conflict");
      if (publicId !== undefined && existing && existing.publicId !== publicId) {
        throw new Error("thread_mapping_conflict");
      }
      threads.set(threadId, { owner, lastError, publicId: publicId ?? existing?.publicId ?? null });
    },
    getThread(threadId) {
      const t = threads.get(threadId);
      return t
        ? { threadId, publicId: t.publicId, owner: t.owner, createdAt: 0, updatedAt: 0, lastError: t.lastError }
        : undefined;
    },
    listThreads(owner) {
      return [...threads.entries()]
        .filter(([, t]) => t.owner === owner)
        .map(([threadId, t]) => ({
          threadId,
          publicId: t.publicId,
          owner: t.owner,
          createdAt: 0,
          updatedAt: 0,
          lastError: t.lastError,
          messageCount: 0,
        }));
    },
    deleteThread(owner, threadId) {
      const t = threads.get(threadId);
      if (!t || t.owner !== owner) return false;
      threads.set(threadId, { ...t, deleted: true });
      return true;
    },
    deleteThreadsForOwner(owner) {
      let n = 0;
      for (const [threadId, t] of threads) {
        if (t.owner === owner) {
          threads.set(threadId, { ...t, deleted: true });
          n++;
        }
      }
      return n;
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
  rateLimiter?: PerOwnerRateLimiter;
  budget?: BudgetManager;
  checkpointStore?: CheckpointStore;
  buildModel?: typeof buildModel;
  toolHandler?: ToolCallHandler;
  jobRunner?: JobRunner;
  pins?: CredentialPinStore;
  ledger?: Ledger;
  threadLocks?: ThreadLockRegistry;
  toolCache?: ToolResultCache;
  contextManager?: ContextManager;
  warmups?: WarmupManager;
};

async function makeApp(
  t: TestContext,
  opts: AppOptions = {},
  extraPlugins?: PluginDefinition[],
): Promise<{ app: Hono; store: PluginStore; registry: PluginRegistry }> {
  const dir = await makeTempDir(t);
  const { store, registry } = await makeEnv(dir, extraPlugins);
  const app = new Hono();
  app.route(
    "/v1",
    createChatRoutes({
      registry,
      pluginStore: store,
      checkpointStore: opts.checkpointStore,
      verifyKey: opts.verifyKey ?? (async () => "test-user"),
      limiter: opts.limiter ?? (() => true),
      rateLimiter: opts.rateLimiter,
      budget: opts.budget,
      buildModel: opts.buildModel,
      toolHandler: opts.toolHandler,
      jobRunner: opts.jobRunner,
      pins: opts.pins,
      ledger: opts.ledger,
      threadLocks: opts.threadLocks,
      toolCache: opts.toolCache,
      contextManager: opts.contextManager,
      warmups: opts.warmups,
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

  test("L7: 400 { error: invalid_request } for a role outside system/user/assistant/tool", async (t) => {
    const { app } = await makeApp(t);
    const bogus = await postChat(
      app,
      chatBody({ messages: [{ role: "bogus", content: "x" }] }),
    );
    assert.equal(bogus.status, 400);
    assert.deepEqual(await bogus.json(), { error: "invalid_request" });
    const nonRecord = await postChat(app, chatBody({ messages: ["not-an-object"] }));
    assert.equal(nonRecord.status, 400);
    assert.deepEqual(await nonRecord.json(), { error: "invalid_request" });
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
    assert.equal(typeof d.inputFactory, "function", "execution re-evaluates the seed under the runner lock");
    assert.equal(d.input, undefined, "no stale seed is shipped in the descriptor");
    const seed = await d.inputFactory!({
      graph: {} as never,
      threadId: checkpointThreadId("test-user", "thread-1"),
      isReplay: false,
      signal: new AbortController().signal,
    }) as { messages: BaseMessage[] };
    assert.equal(seed.messages.length, 1, "fresh thread seeds from client history");

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

  test("M1: a background duplicate (in_flight) releases the transport's model + tool pins (the runner never claimed them)", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([
      { status: "in_flight", taskId: "task-1", threadId: "thr-1" },
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
        messageId: "msg-dup",
        credentials: {
          openrouter: { apiKey: "sk-test-123" },
          vikunja: { apiKey: "tok-123" },
        },
      }),
    );
    assert.equal(res.status, 202);
    assert.throws(
      () => pins.get("test-user", "openrouter"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "the model pin must not leak after an in_flight duplicate",
    );
    assert.throws(
      () => pins.get("test-user", "vikunja"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
      "the tool pin must not leak after an in_flight duplicate",
    );
  });

  test("M1: an already_terminal re-submit also releases the transport's pins", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([
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

    const res = await postChat(
      app,
      chatBody({
        background: true,
        messageId: "msg-term",
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
      threadId: "thr-1",
    });
    assert.throws(
      () => pins.get("test-user", "openrouter"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
    );
    assert.throws(
      () => pins.get("test-user", "vikunja"),
      (e: unknown) => (e as { code?: string }).code === "pin_not_found",
    );
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
    // L5: touchThread runs AFTER validation, so a 400 must not leave a phantom
    // thread_owner row.
    assert.equal(
      checkpointStore.getThread(checkpointThreadId("test-user", "msg-bad-tool")),
      undefined,
      "a rejected request must not write a phantom thread_owner row",
    );
  });

  test("runJob failed: JobErrorCode -> HTTP mapping", async (t) => {
    const cases: Array<{ code: JobErrorCode; status: number }> = [
      { code: "credentials_expired", status: 401 },
      { code: "task_conflict", status: 409 },
      { code: "tool_retry_forbidden", status: 409 },
      { code: "plugin_unavailable", status: 502 },
      { code: "job_failed", status: 500 },
      { code: "budget_exhausted", status: 429 },
      { code: "context_length_exceeded", status: 400 },
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

  test("body.credentials.baseUrlEntry threads through to the buildModel seam for model plugins", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const res = await postChat(app, chatBody({
      credentials: { openrouter: { apiKey: "sk-test-123", baseUrlEntry: "openrouter-api" } },
    }));
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.credentials.apiKey, "sk-test-123");
    assert.equal(fake.calls[0]!.credentials.baseUrlEntry, "openrouter-api");
  });

  test("a baseUrlEntry sent to a TOOL plugin is dropped (never reaches a tool credential set)", async (t) => {
    // Tool plugins' credential sets must stay spec-only: a routing field that
    // only makes sense for model plugins is stripped at extraction + validation.
    const fake = makeFakeBuildModel([
      [
        {
          content: "",
          tool_call_chunks: [
            { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
          ],
        },
      ],
      [{ content: "done" }],
    ]);
    const collect: string[] = [];
    const { app } = await makeApp(t, {
      buildModel: fake.buildModelFn,
      toolHandler: {
        async execute(_pluginId, _tool, _args, credentials) {
          collect.push(JSON.stringify(credentials ?? null));
          return "handled";
        },
      },
    });

    const res = await postChat(app, chatBody({
      credentials: {
        openrouter: { apiKey: "sk-test-123", baseUrlEntry: "openrouter-api" },
        vikunja: { apiKey: "tok-vikunja", baseUrlEntry: "vikunja-api" },
      },
    }));
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(fake.calls[0]!.credentials.baseUrlEntry, "openrouter-api");
    assert.equal(collect.length, 1, "the tool handler executed once");
    assert.deepEqual(JSON.parse(collect[0]!), { apiKey: "tok-vikunja" });
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

  test("H1: a stateless request (no thread_id) streams cleanly to a finish chunk + [DONE] even when a checkpoint store is wired", async (t) => {
    // The checkpoint store is a real in-memory checkpointer whose `put` throws
    // `Missing "thread_id"` (the same contract SqliteSaver enforces). Before
    // the fix the graph was compiled WITH the checkpointer unconditionally, so
    // a stateless run's first super-step write threw mid-stream and the adapter
    // surfaced server_error + partial content — breaking every stateless
    // request on a normally-configured gateway.
    const fake = makeFakeBuildModel([[{ content: "Hello" }, { content: " world" }]]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn });

    const res = await postChat(
      app,
      chatBody({ messages: [{ role: "user", content: "hello" }] }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("server_error"), "no server_error on the wire");
    assert.ok(!text.includes("Missing \"thread_id\""), "no checkpointer crash leaks");

    const frames = parseFrames(text);
    assert.equal(frames[frames.length - 1], null, "stream terminates with [DONE]");
    assert.deepEqual(
      finishReasons(frames).at(-1),
      "stop",
      "a real finish chunk terminates the stream",
    );
  });
});

describe("POST /v1/chat/completions — sync path tool credentials (H2)", () => {
  test("tool credentials from body.credentials[<toolPlugin>] reach the tool handler on every execute", async (t) => {
    const recordedInputs: BaseMessage[][] = [];
    const buildModelFn = ((_input: BuildModelInput) =>
      new RecordingChatModel(
        [
          [
            {
              content: "",
              tool_call_chunks: [
                { index: 0, id: "call_1", name: "list_tasks", args: '{"projectId":"p1"}' },
              ],
            },
          ],
          [{ content: "done" }],
        ],
        recordedInputs,
      )) as typeof buildModel;

    const toolCalls: Array<{
      pluginId: string;
      toolName: string;
      args: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    }> = [];
    const { app } = await makeApp(t, {
      buildModel: buildModelFn,
      toolHandler: {
        async execute(pluginId, toolName, args, credentials) {
          toolCalls.push({ pluginId, toolName, args, credentials });
          return JSON.stringify({ ok: true, toolName, ...args });
        },
      },
    });

    const res = await postChat(
      app,
      chatBody({
        messages: [{ role: "user", content: "list my tasks" }],
        credentials: {
          openrouter: { apiKey: "sk-test-123" },
          vikunja: { apiKey: "tok-123" },
        },
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"), "the tool round-trip streams");

    assert.equal(toolCalls.length, 1, "the model called the tool exactly once");
    assert.equal(toolCalls[0]!.pluginId, "vikunja");
    assert.equal(toolCalls[0]!.toolName, "list_tasks");
    assert.deepEqual(toolCalls[0]!.args, { projectId: "p1" });
    assert.deepEqual(
      toolCalls[0]!.credentials,
      { apiKey: "tok-123" },
      "the sync tool call carries the client's validated tool-plugin credential",
    );
  });

  test("a missing tool-plugin credential does NOT fail the request (the model may never call the tool)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    // vikunja's spec REQUIRES apiKey, but the client simply does not supply it
    // — the request must still succeed (and simply never have that credential
    // available if the model calls the tool).
    const res = await postChat(
      app,
      chatBody({ credentials: { openrouter: { apiKey: "sk-test-123" } } }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
  });

  test("an explicitly-supplied but invalid tool credential is a 400 invalid_credentials", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    const res = await postChat(
      app,
      chatBody({
        credentials: {
          openrouter: { apiKey: "sk-test-123" },
          vikunja: { apiKey: "  " },
        },
      }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_credentials" });
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

  test("resumed: client-supplied history is ignored — only the last user message is appended", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "First reply" }],
      [{ content: "Second reply" }],
    ]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn });

    // Seed the thread so a checkpoint exists.
    const res1 = await postChat(
      app,
      chatBody({
        thread_id: "resume-history",
        messages: [{ role: "user", content: "first" }],
      }),
    );
    assert.equal(res1.status, 200);
    await res1.text();

    // Resume carrying the FULL client history, with a TAMPERED assistant turn
    // so any leak of client-supplied history into the model input is visible.
    const res2 = await postChat(
      app,
      chatBody({
        thread_id: "resume-history",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "tampered-by-client" },
          { role: "user", content: "new" },
        ],
      }),
    );
    assert.equal(res2.status, 200);
    const text2 = await res2.text();
    assert.ok(text2.includes("data: [DONE]"), "resume call streams");

    const resumeTurn = fake.recordedInputs[1]!;
    assert.deepEqual(
      contentsOf(resumeTurn),
      ["first", "First reply", "new"],
      "resume = checkpointed state + ONLY the last user message (client history ignored)",
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

  test("M3: resume with a non-user last message → 409 resume_conflict (never a silent re-seed)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "First reply" }]]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn });

    // Seed the thread so a checkpoint exists.
    const res1 = await postChat(
      app,
      chatBody({ thread_id: "mid-tool", messages: [{ role: "user", content: "first" }] }),
    );
    assert.equal(res1.status, 200);
    await res1.text();

    // Resume mid-tool-loop: the LAST message is an assistant/tool message.
    // Seeding with an older user message would drop tool results and re-run a
    // pending tool call; the honest answer is a 409.
    for (const messages of [
      [
        { role: "user", content: "continue" },
        { role: "assistant", content: "let me check", tool_calls: [] },
      ],
      [{ role: "tool", tool_call_id: "call_1", content: "[]" }],
    ]) {
      const res = await postChat(
        app,
        chatBody({ thread_id: "mid-tool", messages }),
      );
      assert.equal(res.status, 409, `409 for last role ${messages.at(-1)!.role}`);
      assert.deepEqual(await res.json(), {
        error: "resume_conflict",
        message: "resume with a user message only",
      });
    }
  });

  test("M3: a fresh thread (no checkpoint) accepts a seed whose last message is not a user message", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "hi" }]]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, { checkpointStore, buildModel: fake.buildModelFn });

    const res = await postChat(
      app,
      chatBody({
        thread_id: "fresh",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "assistant reply" },
          { role: "user", content: "last" },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
    const turn = fake.recordedInputs[0]!;
    const contents = contentsOf(turn);
    assert.deepEqual(
      contents,
      ["u1", "assistant reply", "last"],
      "a fresh seed uses the client's full history verbatim",
    );
  });
});

describe("POST /v1/chat/completions — managed conversation mode (Phase 5)", () => {
  test("managed with no thread_id generates a public UUID and returns it via x-thread-id", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const ledger = makeLedger();
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const { app } = await makeApp(t, {
      checkpointStore,
      ledger,
      threadLocks,
      buildModel: fake.buildModelFn,
    });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messageId: "msg-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
    const threadId = res.headers.get("x-thread-id");
    assert.ok(threadId, "x-thread-id header present");
    assert.match(threadId!, /^[0-9a-f-]{36}$/, "generated thread id is a UUID");
    assert.equal(res.headers.get("x-conversation-state"), "seeded");
    // The ledger records the turn so a retry is deduped.
    const task = ledger.getTaskByIntentKey("test-user", "msg-1");
    assert.ok(task);
    assert.equal(task!.status, "succeeded");
  });

  test("client-supplied thread_id is honored and echoed back", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const ledger = makeLedger();
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, {
      checkpointStore,
      ledger,
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messageId: "msg-1",
        thread_id: "11111111-2222-3333-4444-555555555555",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(res.headers.get("x-thread-id"), "11111111-2222-3333-4444-555555555555");
    assert.equal(res.headers.get("x-conversation-state"), "seeded");
  });

  test("retry with the SAME messageId after success returns already_completed, never a second run", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "only reply" }]]);
    const ledger = makeLedger();
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, {
      checkpointStore,
      ledger,
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });
    const body = chatBody({
      conversation_mode: "managed",
      messageId: "msg-1",
      thread_id: "22222222-2222-3333-4444-555555555555",
      messages: [{ role: "user", content: "hello" }],
    });
    const res1 = await postChat(app, body);
    assert.equal(res1.status, 200);
    await res1.text();

    const res2 = await postChat(app, body);
    assert.equal(res2.status, 200);
    const json = (await res2.json()) as { status: string; taskId: string };
    assert.equal(json.status, "already_completed");
    assert.equal(fake.recordedInputs.length, 1, "the model ran exactly once");
  });

  test("recreated: a known thread with a missing checkpoint re-seeds from client history", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const ledger = makeLedger();
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const { app } = await makeApp(t, {
      checkpointStore,
      ledger,
      threadLocks,
      buildModel: fake.buildModelFn,
    });
    // A KNOWN thread whose checkpoint is gone: the owner->thread mapping row
    // exists but no checkpoint does (e.g. the first stream failed before the
    // checkpointer wrote). Simulate by touching the mapping row directly.
    const publicId = "44444444-2222-3333-4444-555555555555";
    checkpointStore.touchThread(
      "test-user",
      checkpointThreadId("test-user", publicId),
      null,
      publicId,
    );

    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messageId: "msg-recreate",
        thread_id: publicId,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.equal(res.headers.get("x-thread-id"), publicId);
    assert.equal(res.headers.get("x-conversation-state"), "recreated");
    // A recreation re-seeds from the FULL client history, not just the last turn.
    assert.deepEqual(contentsOf(fake.recordedInputs[0]!), ["first", "second"]);
  });

  test("reseed_required: a known thread with a missing checkpoint and no client history → 409", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const ledger = makeLedger();
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const { app } = await makeApp(t, {
      checkpointStore,
      ledger,
      threadLocks,
      buildModel: fake.buildModelFn,
    });
    const publicId = "55555555-2222-3333-4444-555555555555";
    checkpointStore.touchThread(
      "test-user",
      checkpointThreadId("test-user", publicId),
      null,
      publicId,
    );

    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messageId: "msg-reseed",
        thread_id: publicId,
        messages: [{ role: "user", content: "only" }],
      }),
    );
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: string; reason?: string };
    assert.equal(json.error, "reseed_required");
    assert.equal(json.reason, "checkpoint_missing");
  });

  test("managed without messageId → 400 invalid_request", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(),
      ledger: makeLedger(),
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, "invalid_request");
  });

  test("managed without a checkpoint store → 503 managed_unavailable (never silent stateless)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, {
      ledger: makeLedger(),
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        messageId: "msg-1",
        thread_id: "33333333-2222-3333-4444-555555555555",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, "managed_unavailable");
  });

  test("a non-managed conversation_mode value → 400 invalid_request", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    const res = await postChat(
      app,
      chatBody({ conversation_mode: "wild", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(res.status, 400);
  });

  test("structured image content (vision SSE shape) is accepted on the same endpoint", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "image described" }]]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, {
      checkpointStore,
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });
    const res = await postChat(
      app,
      chatBody({
        thread_id: "44444444-2222-3333-4444-555555555555",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
            ],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"), "vision content streams on the same SSE endpoint");
  });

  test("enabled_plugins limits which tool plugins are bound (absent preserves legacy)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "ok" }], [{ content: "ok again" }]]);
    const checkpointStore = fakeCheckpointStore();
    const { app } = await makeApp(t, {
      checkpointStore,
      threadLocks: new ThreadLockRegistry(),
      buildModel: fake.buildModelFn,
    });

    // Absent enabled_plugins: legacy behavior (no 400, request streams).
    const legacy = await postChat(
      app,
      chatBody({ thread_id: "sel-1", messages: [{ role: "user", content: "hi" }] }),
    );
    assert.equal(legacy.status, 200);
    await legacy.text();

    // Present and valid: streams normally.
    const selected = await postChat(
      app,
      chatBody({
        thread_id: "sel-2",
        enabled_plugins: ["vikunja"],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(selected.status, 200);
    await selected.text();

    // Present but malformed: 400 invalid_request.
    const malformed = await postChat(
      app,
      chatBody({
        thread_id: "sel-3",
        enabled_plugins: "vikunja",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(malformed.status, 400);
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

  test("buildModel resolves a baseUrlEntry credential against the plugin's allowlisted baseUrls", async (t) => {
    const dir = await makeTempDir(t);
    // Two allowlisted base-URL instances for the same host; the client picks
    // one by id (the server-side allowlist is the only endpoint authority).
    const provider = openRouterPlugin();
    provider.baseUrls = [
      { id: "default", url: "https://openrouter.ai/api/v1", label: "Default" },
      { id: "alt", url: "https://openrouter.ai/api/v2", label: "Alt" },
    ];
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [provider, toolPlugin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await store.load();
    const model = buildModel({
      registry: new PluginRegistry(store),
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "sk-test", baseUrlEntry: "alt" },
    });
    const clientConfig = (
      model as unknown as { clientConfig: { baseURL?: string } }
    ).clientConfig;
    assert.equal(clientConfig.baseURL, "https://openrouter.ai/api/v2");
  });

  test("buildModel with an unknown baseUrlEntry id falls back to plugin.inference.endpoint", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    // A stale client selection (rotated allowlist) must never fail the build
    // and must never accept the raw value as a URL.
    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "sk-test", baseUrlEntry: "stale-id" },
    });
    const clientConfig = (
      model as unknown as { clientConfig: { baseURL?: string } }
    ).clientConfig;
    assert.equal(clientConfig.baseURL, "https://openrouter.ai/api/v1");
  });

  test("buildModel with a blank baseUrlEntry falls back to plugin.inference.endpoint", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "sk-test", baseUrlEntry: "   " },
    });
    const clientConfig = (
      model as unknown as { clientConfig: { baseURL?: string } }
    ).clientConfig;
    assert.equal(clientConfig.baseURL, "https://openrouter.ai/api/v1");
  });

  test("M5: a real model.invoke actually invokes the validatedFetch-backed custom fetch (the SSRF seam is live)", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      seen.push(String(url));
      // ChatOpenAI (streaming: true) consumes an OpenAI SSE stream.
      const body =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"openrouter/auto","choices":[{"index":0,"delta":{"role":"assistant","content":"hello from fake provider"},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"openrouter/auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "sk-test" },
      lookup: fakeLookup(),
      fetchFn,
      mode: "test",
    });
    const result = (await model.invoke([new HumanMessage("hi")])) as {
      content?: unknown;
    };

    assert.equal(
      seen.length,
      1,
      "the custom validatedFetch adapter was INVOKED (not just wired)",
    );
    assert.ok(
      seen[0]!.includes("/chat/completions"),
      `the provider call hit ${seen[0]}`,
    );
    assert.equal(String(result.content), "hello from fake provider");
  });

  test("provider failures never retry outside dispatch admission", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    let attempts = 0;
    const model = buildModel({
      registry,
      pluginStore: store,
      modelPluginId: "openrouter",
      credentials: { apiKey: "test-provider-key" },
      requestParameters: { maxRetries: 9 },
      lookup: fakeLookup(),
      mode: "test",
      fetchFn: async () => {
        attempts++;
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(model.invoke([new HumanMessage("hi")]));
    assert.equal(attempts, 1);
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

// ---------------------------------------------------------------------------
// Phase 4, Wave A middleware-gate helpers and integration tests
// ---------------------------------------------------------------------------

/** Block until `predicate()` returns true; throws after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, pollMs = 20 } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/**
 * Streaming model that blocks on an injectable `gate` promise before
 * producing its chunk. `onEntered()` fires when the model's stream method
 * begins — use it to coordinate that the budget slot is held before
 * dispatching a second request.
 */
class BlockingChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly gate: Promise<void>;
  private readonly onEntered: () => void;

  constructor(opts: { gate: Promise<void>; onEntered: () => void }) {
    super({});
    this.gate = opts.gate;
    this.onEntered = opts.onEntered;
  }

  _llmType(): string {
    return "blocking";
  }

  bindTools(tools: StructuredToolInterface[]) {
    return new BlockingChatModel({
      gate: this.gate,
      onEntered: this.onEntered,
    }).withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.onEntered();
    return {
      generations: [{ message: new AIMessage("(blocked)"), text: "" }],
    };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.onEntered();
    await this.gate;
    const chunk = new AIMessageChunk({ content: "hi" });
    const text = typeof chunk.content === "string" ? chunk.content : "";
    const generation = new ChatGenerationChunk({ message: chunk, text });
    await runManager?.handleLLMNewToken(
      text, undefined, undefined, undefined, undefined, { chunk: generation },
    );
    yield generation;
  }
}

/** Admissible fake whose `runJob` blocks until `releaseAll()` is called. */
type BlockingJobRunner = {
  runJob: JobRunner["runJob"];
  calls: JobDescriptor[];
  releaseAll(): void;
};

function makeBlockingJobRunner(): BlockingJobRunner {
  const calls: JobDescriptor[] = [];
  const resolvers: Array<() => void> = [];
  let callIdx = 0;

  const runJob: JobRunner["runJob"] = async (d) => {
    const i = callIdx++;
    calls.push(d);
    return new Promise<RunJobResult>((resolve) => {
      resolvers.push(() =>
        resolve({
          status: "succeeded",
          taskId: `task-${i}`,
          threadId: `thr-${i}`,
        }),
      );
    });
  };

  return {
    runJob,
    calls,
    releaseAll() {
      for (const fn of resolvers.splice(0)) fn();
    },
  };
}

describe("Phase 4, Wave A — middleware gates (rate limiter + budget)", () => {
  describe("per-owner rate limiter", () => {
    test("429 { error: rate_limited } + Retry-After when the per-owner rate limiter denies", async (t) => {
      const rateLimiter = createPerOwnerRateLimiter({ ratePerMinute: 1, burst: 1 });
      const fake = makeFakeBuildModel([[{ content: "hi" }]]);
      const { app } = await makeApp(t, {
        rateLimiter,
        buildModel: fake.buildModelFn,
      });
      const ok = await postChat(app, chatBody());
      assert.equal(ok.status, 200);
      await ok.text();

      const denied = await postChat(app, chatBody());
      assert.equal(denied.status, 429);
      assert.deepEqual(await denied.json(), { error: "rate_limited" });
      assert.equal(denied.headers.get("retry-after"), "60");
    });

    test("per-owner rate isolation: different owners get independent buckets", async (t) => {
      let ownerN = 0;
      // Returns "user-a" for the first TWO calls (requests 1 + 2 by the same
      // owner), then "user-b" for request 3 (a different owner, unaffected).
      const verifyKey: VerifyApiKeyFn = async () =>
        ownerN++ < 2 ? "user-a" : "user-b";
      const rateLimiter = createPerOwnerRateLimiter({
        ratePerMinute: 1,
        burst: 1,
      });
      const fake = makeFakeBuildModel([
        [{ content: "a" }],
        [{ content: "b" }],
      ]);
      const { app } = await makeApp(t, {
        verifyKey,
        rateLimiter,
        buildModel: fake.buildModelFn,
      });

      // user-a: first succeeds, second denied (burst=1 exhausted).
      const a1 = await postChat(app, chatBody());
      assert.equal(a1.status, 200);
      await a1.text();
      const a2 = await postChat(app, chatBody());
      assert.equal(a2.status, 429);

      // user-b: unaffected by user-a's exhaustion.
      const b1 = await postChat(app, chatBody());
      assert.equal(b1.status, 200);
      await b1.text();
    });
  });

  describe("sync budget", () => {
    test("429 { error: busy } + Retry-After when the sync budget is full", async (t) => {
      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => {
        releaseGate = r;
      });
      let enteredResolve!: () => void;
      const entered = new Promise<void>((r) => {
        enteredResolve = r;
      });
      const budget = createBudgetManager({ maxConcurrentPerUser: 1 });
      const buildModelFn = ((_input: BuildModelInput) =>
        new BlockingChatModel({ gate, onEntered: enteredResolve })) as typeof buildModel;
      const { app } = await makeApp(t, { budget, buildModel: buildModelFn });

      const p1 = postChat(app, chatBody());
      await entered;
      assert.equal(budget.activeCount("test-user"), 1);

      const p2 = postChat(app, chatBody());
      const [res1, res2] = await Promise.all([p1, p2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 429);
      assert.deepEqual(await res2.json(), { error: "busy" });
      assert.equal(res2.headers.get("retry-after"), "10");

      releaseGate();
      await res1.text();
      assert.equal(budget.activeCount("test-user"), 0);

      const res3 = await postChat(app, chatBody());
      assert.equal(res3.status, 200);
      await res3.text();
    });

    test("cancelled sync stream frees the budget slot", async (t) => {
      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => {
        releaseGate = r;
      });
      let enteredResolve!: () => void;
      const entered = new Promise<void>((r) => {
        enteredResolve = r;
      });
      const budget = createBudgetManager({ maxConcurrentPerUser: 1 });
      const buildModelFn = ((_input: BuildModelInput) =>
        new BlockingChatModel({ gate, onEntered: enteredResolve })) as typeof buildModel;
      const { app } = await makeApp(t, { budget, buildModel: buildModelFn });

      const res = await postChat(app, chatBody());
      await entered;
      assert.equal(budget.activeCount("test-user"), 1);

      await res.body?.cancel();
      assert.equal(budget.activeCount("test-user"), 1, "cancel must not release before execution settles");

      releaseGate();
      await waitFor(() => budget.activeCount("test-user") === 0);

      const res2 = await postChat(app, chatBody());
      assert.equal(res2.status, 200);
      await res2.text();
    });
  });

  describe("async budget", () => {
    test("503 { error: busy } + Retry-After when the async queue is full", async (t) => {
      const checkpointStore = fakeCheckpointStore();
      const pins = new CredentialPinStore();
      const ledger = makeLedger();
      const budget = createBudgetManager({
        maxConcurrentPerUser: 1,
        queueMaxPerUser: 1,
      });
      const fake = makeBlockingJobRunner();
      const { app } = await makeApp(t, {
        checkpointStore,
        pins,
        ledger,
        budget,
        jobRunner: fake as unknown as JobRunner,
      });

      const p1 = postChat(
        app,
        chatBody({
          background: true,
          messageId: "msg-1",
          thread_id: "thread-1",
          messages: [{ role: "user", content: "list" }],
        }),
      );
      await waitFor(() => budget.activeCount("test-user") === 1);

      // msg-2 parks (queued) — won't resolve until msg-1 finishes.
      const p2 = postChat(
        app,
        chatBody({
          background: true,
          messageId: "msg-2",
          thread_id: "thread-2",
          messages: [{ role: "user", content: "create" }],
        }),
      );

      // msg-3: queue full → immediate 503, no phantom ledger row.
      const res3 = await postChat(
        app,
        chatBody({
          background: true,
          messageId: "msg-3",
          thread_id: "thread-3",
          messages: [{ role: "user", content: "delete" }],
        }),
      );
      assert.equal(res3.status, 503);
      assert.deepEqual(await res3.json(), { error: "busy" });
      assert.equal(res3.headers.get("retry-after"), "10");
      assert.equal(ledger.getTaskByIntentKey("test-user", "msg-3"), null);

      // Release msg-1 → promotes msg-2.
      fake.releaseAll();
      await waitFor(() => fake.calls.length === 2);
      const res1 = await p1;
      assert.equal(res1.status, 200);

      // Release msg-2 → completes.
      fake.releaseAll();
      const res2 = await p2;
      assert.equal(res2.status, 200);
      await waitFor(() => budget.activeCount("test-user") === 0);
    });

    test("M1 in_flight duplicate releases the budget reservation", async (t) => {
      const checkpointStore = fakeCheckpointStore();
      const pins = new CredentialPinStore();
      const ledger = makeLedger();
      const budget = createBudgetManager({ maxConcurrentPerUser: 2 });
      const fake = makeFakeJobRunner([
        {
          status: "in_flight",
          taskId: "task-1",
          threadId: "thr-1",
        },
        {
          status: "in_flight",
          taskId: "task-2",
          threadId: "thr-2",
        },
      ]);
      const { app } = await makeApp(t, {
        checkpointStore,
        pins,
        ledger,
        budget,
        jobRunner: fake as unknown as JobRunner,
      });

      const [res1, res2] = await Promise.all([
        postChat(
          app,
          chatBody({
            background: true,
            messageId: "msg-1",
            thread_id: "thread-1",
            messages: [{ role: "user", content: "alpha" }],
          }),
        ),
        postChat(
          app,
          chatBody({
            background: true,
            messageId: "msg-2",
            thread_id: "thread-2",
            messages: [{ role: "user", content: "beta" }],
          }),
        ),
      ]);
      assert.equal(res1.status, 202);
      assert.deepEqual(await res1.json(), {
        status: "accepted",
        taskId: "task-1",
        threadId: "thr-1",
      });
      assert.equal(res2.status, 202);
      assert.deepEqual(await res2.json(), {
        status: "accepted",
        taskId: "task-2",
        threadId: "thr-2",
      });

      // Both reservations released despite the in_flight duplicate status.
      assert.equal(budget.activeCount("test-user"), 0);
    });
  });
});

describe("Phase 4, Wave B — sync path tool-result cache", () => {
  /** A scripted model whose one generation emits a single tool call. */
  function toolCallingModel(
    recorded: BaseMessage[][],
    toolName: string,
    argsJson: string,
  ): typeof buildModel {
    return ((_input: BuildModelInput) =>
      new RecordingChatModel(
        [
          [
            {
              content: "",
              tool_call_chunks: [
                { index: 0, id: "call_1", name: toolName, args: argsJson },
              ],
            },
          ],
          [{ content: "done" }],
        ],
        recorded,
      )) as typeof buildModel;
  }

  test("a read-only tool call is cached across requests: the second identical request does not re-execute, and the redacted cached result still reaches the model's turn", async (t) => {
    const recorded: BaseMessage[][] = [];
    let handlerCalls = 0;
    const toolCache = createToolResultCache();
    const { app } = await makeApp(t, {
      buildModel: toolCallingModel(recorded, "list_tasks", '{"projectId":"p1"}'),
      toolCache,
      toolHandler: {
        async execute() {
          handlerCalls += 1;
          return JSON.stringify({
            ok: true,
            seq: handlerCalls,
            token: "Bearer sk-secret123",
          });
        },
      },
    });

    const body = (n: number) =>
      chatBody({
        messages: [{ role: "user", content: `list tasks #${n}` }],
        credentials: {
          openrouter: { apiKey: "sk-test-123" },
          vikunja: { apiKey: "tok-123" },
        },
      });

    const res1 = await postChat(app, body(1));
    assert.equal(res1.status, 200);
    await res1.text();
    const res2 = await postChat(app, body(2));
    assert.equal(res2.status, 200);
    const text2 = await res2.text();
    assert.ok(text2.includes("data: [DONE]"), "the cached round-trip streams");

    assert.equal(
      handlerCalls,
      1,
      "the second request must not re-execute the read-only tool",
    );
    assert.equal(toolCache.size, 1, "exactly one entry cached");

    // Each request produces two model turns; the SECOND turn of each carries
    // the tool's ToolMessage. Both must hold the same REDACTED payload even
    // though only the first request executed the backend.
    const redacted = redactForCheckpoint(
      JSON.stringify({ ok: true, seq: 1, token: "Bearer sk-secret123" }),
    );
    assert.equal(recorded.length, 4, "two requests x two turns each");
    for (const turn of [recorded[1]!, recorded[3]!]) {
      const toolMessages = turn.filter((m) => m.constructor.name === "ToolMessage");
      assert.equal(toolMessages.length, 1, "the model saw exactly one ToolMessage");
      const content = String(toolMessages[0]!.content);
      assert.equal(content, redacted, "the served result is identical and redacted");
      assert.ok(!content.includes("sk-secret123"), "no raw credential-shaped value leaks");
    }
  });

  test("a mutating tool is never cached: identical requests re-execute and the cache stays empty", async (t) => {
    const recorded: BaseMessage[][] = [];
    let handlerCalls = 0;
    const toolCache = createToolResultCache();
    const { app } = await makeApp(t, {
      buildModel: toolCallingModel(recorded, "create_task", '{"title":"x"}'),
      toolCache,
      toolHandler: {
        async execute() {
          handlerCalls += 1;
          return JSON.stringify({ ok: true, seq: handlerCalls });
        },
      },
    });

    const body = chatBody({
      messages: [{ role: "user", content: "create a task" }],
      credentials: {
        openrouter: { apiKey: "sk-test-123" },
        vikunja: { apiKey: "tok-123" },
      },
    });
    const res1 = await postChat(app, body);
    assert.equal(res1.status, 200);
    await res1.text();
    const res2 = await postChat(app, body);
    assert.equal(res2.status, 200);
    await res2.text();

    assert.equal(handlerCalls, 2, "a mutating tool always executes");
    assert.equal(toolCache.size, 0, "mutating tool results are never cached");
  });

  test("a read-only call with NO tool credential still dedupes (stable empty-credential fingerprint)", async (t) => {
    const recorded: BaseMessage[][] = [];
    let handlerCalls = 0;
    const toolCache = createToolResultCache();
    const { app } = await makeApp(t, {
      buildModel: toolCallingModel(recorded, "list_tasks", '{"projectId":"p1"}'),
      toolCache,
      toolHandler: {
        async execute() {
          handlerCalls += 1;
          return JSON.stringify({ ok: true, seq: handlerCalls });
        },
      },
    });

    // vikunja's apiKey is REQUIRED by its spec, but the client simply does not
    // supply it — the request must still succeed, and the read-only call still
    // dedupes against the stable empty-credential fingerprint.
    const body = chatBody({
      messages: [{ role: "user", content: "list my tasks" }],
      credentials: { openrouter: { apiKey: "sk-test-123" } },
    });
    const res1 = await postChat(app, body);
    assert.equal(res1.status, 200);
    await res1.text();
    const res2 = await postChat(app, body);
    assert.equal(res2.status, 200);
    await res2.text();

    assert.equal(handlerCalls, 1, "the second request was served from the cache");
    assert.equal(toolCache.size, 1);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function toolTurns(): Array<Array<Record<string, unknown>>> {
  return [
    [{ content: "", tool_call_chunks: [{ index: 0, id: "call_1", name: "list_tasks", args: "{}" }] }],
    [{ content: "done" }],
  ];
}

describe("transport integration regressions", () => {
  test("cancel during a delayed model holds the thread lock and prevents tool dispatch", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const budget = createBudgetManager();
    const active = { current: 0, max: 0 };
    const recorded: BaseMessage[][] = [];
    let calls = 0;
    let builds = 0;
    const { app } = await makeApp(t, {
      checkpointStore, threadLocks, budget,
      buildModel: (() => new SlowScriptedChatModel({
        turns: builds++ === 0 ? toolTurns() : [[{ content: "second" }]],
        recordedInputs: recorded, delayMs: 100, active,
      })) as typeof buildModel,
      toolHandler: { async execute() { calls++; return "[]"; } },
    });
    const first = await postChat(app, chatBody({ thread_id: "cancel-model" }));
    await waitFor(() => active.current === 1);
    await first.body!.cancel();
    assert.equal(budget.activeCount("test-user"), 1);
    assert.equal(threadLocks.mutexes.size, 1);
    let secondStarted = false;
    const second = postChat(app, chatBody({ thread_id: "cancel-model" })).then((response) => {
      secondStarted = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondStarted, false);
    await (await second).text();
    assert.equal(active.max, 1);
    assert.equal(calls, 0);
    assert.equal(budget.activeCount("test-user"), 0);
    assert.equal(threadLocks.mutexes.size, 0);
    const config = { configurable: { thread_id: checkpointThreadId("test-user", "cancel-model") } };
    const checkpoint = await checkpointStore.checkpointer.get(config);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await checkpointStore.checkpointer.get(config))?.id, checkpoint?.id);
  });

  test("cancel during a delayed tool forwards abort and holds admission until the side effect settles", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const budget = createBudgetManager();
    const recorded: BaseMessage[][] = [];
    let signal: AbortSignal | undefined;
    let toolActive = false;
    let writes = 0;
    let builds = 0;
    let overlap = false;
    const { app } = await makeApp(t, {
      checkpointStore, threadLocks, budget,
      buildModel: (() => new RecordingChatModel(builds++ === 0 ? toolTurns() : [[{ content: "second" }]], recorded)) as typeof buildModel,
      toolHandler: {
        async execute(_pluginId, _toolName, _args, _credentials, abortSignal?: AbortSignal) {
          signal = abortSignal;
          toolActive = true;
          await gate.promise;
          writes++;
          toolActive = false;
          return "[]";
        },
      },
      contextManager: {
        truncateSeed: (messages) => messages,
        prepareMessages(messages) { overlap ||= toolActive; return messages; },
        async maybeCompactAfterStream() {},
      },
    });
    const first = await postChat(app, chatBody({ thread_id: "cancel-tool" }));
    await waitFor(() => toolActive);
    await first.body!.cancel();
    assert.equal(signal?.aborted, true);
    assert.equal(budget.activeCount("test-user"), 1);
    let admitted = false;
    const second = postChat(app, chatBody({ thread_id: "cancel-tool" })).then((response) => {
      admitted = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(admitted, false);
    assert.equal(writes, 0);
    gate.resolve();
    await (await second).text();
    assert.equal(writes, 1);
    assert.equal(overlap, false);
    assert.equal(recorded.length, 2, "cancelled run never dispatches its second model turn");
    assert.equal(budget.activeCount("test-user"), 0);
    assert.equal(threadLocks.mutexes.size, 0);
  });

  test("every model dispatch prepares context and consumes budget; exhaustion has an explicit SSE code", async (t) => {
    const budget = createBudgetManager({ maxModelCallsPerWindow: 1 });
    const recorded: BaseMessage[][] = [];
    let prepared = 0;
    const { app } = await makeApp(t, {
      budget,
      buildModel: (() => new RecordingChatModel(toolTurns(), recorded)) as typeof buildModel,
      toolHandler: { async execute() { return "[]"; } },
      contextManager: {
        truncateSeed: (messages) => messages,
        prepareMessages(messages) { prepared++; return messages; },
        async maybeCompactAfterStream() {},
      },
    });
    const frames = parseFrames(await (await postChat(app, chatBody())).text());
    assert.equal(prepared, 2);
    assert.equal(recorded.length, 1);
    assert.equal(budget.modelCallCount("test-user"), 1);
    const errors = frames.filter((frame) => frame?.error);
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.error as { code: string }).code, "budget_exhausted");
    assert.equal(frames.filter((frame) => frame === null).length, 1);
    assert.equal(budget.activeCount("test-user"), 0);
  });

  test("context bounds include the supervisor on every resumed and tool round; compaction receives the graph", async (t) => {
    const threadLocks = new ThreadLockRegistry();
    const limitTokens = estimateMessagesTokens([new SystemMessage(SUPERVISOR_PROMPT)]) + 100;
    const context = createContextManager({ limitTokens, threadLocks });
    const recorded: BaseMessage[][] = [];
    let compactions = 0;
    const { app } = await makeApp(t, {
      checkpointStore: fakeCheckpointStore(), threadLocks,
      contextManager: {
        ...context,
        async maybeCompactAfterStream(args) {
          assert.ok(args.graph);
          assert.equal(args.checkpointer, undefined);
          assert.equal(args.lockHeld, true);
          compactions++;
          await context.maybeCompactAfterStream(args);
        },
      },
      buildModel: (() => new RecordingChatModel(toolTurns(), recorded)) as typeof buildModel,
      toolHandler: { async execute() { return "x".repeat(2000); } },
    });
    for (const content of ["first", "second"]) {
      const response = await postChat(app, chatBody({ thread_id: "context", messages: [{ role: "user", content }] }));
      const frames = parseFrames(await response.text());
      assert.equal(frames.some((frame) => frame?.error), false);
    }
    assert.equal(recorded.length, 4);
    assert.equal(compactions, 2);
    for (const messages of recorded) assert.ok(estimateMessagesTokens(messages) <= limitTokens);
    assert.ok(recorded[2]!.some((message) => message.content === "second"));
  });

  test("context exhaustion is explicit before streaming and when the supervisor exceeds the limit", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "unused" }]]);
    const { app } = await makeApp(t, {
      buildModel: fake.buildModelFn,
      contextManager: createContextManager({ limitTokens: 2 }),
    });
    const rejected = await postChat(app, chatBody({ messages: [{ role: "user", content: "too long to fit" }] }));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { error: string }).error, "context_length_exceeded");
    const streamed = await postChat(app, chatBody({ messages: [{ role: "user", content: "hi" }] }));
    const errors = parseFrames(await streamed.text()).filter((frame) => frame?.error);
    assert.equal((errors[0]!.error as { code: string }).code, "context_length_exceeded");
    assert.equal(fake.recordedInputs.length, 0);
  });

  test("background inputFactory re-reads after another writer seeds the thread while awaiting the runner lock", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const threadLocks = new ThreadLockRegistry();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const recorded: BaseMessage[][] = [];
    const env = await makeEnv(await makeTempDir(t));
    const runner = new RealJobRunner({
      ledger, pins, registry: env.registry, checkpointer: checkpointStore.checkpointer,
      threadLocks, buildModel: () => new RecordingChatModel([], recorded),
    });
    t.after(() => runner.dispose());
    const { app } = await makeApp(t, { checkpointStore, threadLocks, pins, ledger, jobRunner: runner });
    const threadId = checkpointThreadId("test-user", "seed-race");
    const unlock = await threadLocks.acquire(threadId);
    t.after(unlock);
    const response = postChat(app, chatBody({
      background: true, messageId: "seed-race", thread_id: "seed-race",
      messages: [{ role: "user", content: "stale history" }, { role: "assistant", content: "stale reply" }, { role: "user", content: "new turn" }],
    }));
    await waitFor(() => ledger.getTaskByIntentKey("test-user", "seed-race")?.status === "running");
    const seed = await makeApp(t, {
      checkpointStore,
      buildModel: makeFakeBuildModel([[{ content: "checkpoint reply" }]]).buildModelFn,
    });
    await (await postChat(seed.app, chatBody({ thread_id: "seed-race", messages: [{ role: "user", content: "checkpoint history" }] }))).text();
    unlock();
    assert.equal((await response).status, 200);
    const contents = recorded[0]!.map((message) => message.content);
    assert.ok(contents.includes("checkpoint history"));
    assert.ok(contents.includes("new turn"));
    assert.equal(contents.includes("stale history"), false);
    assert.equal(contents.includes("stale reply"), false);
  });

  test("background inputFactory re-reads after a false admission snapshot: a mapping row created by a concurrent writer between admission and inputFactory yields a recreated turn, not a stale seed", async (t) => {
    // The admission-time snapshot (getThread call 1) and the pre-admission
    // validation re-read (call 2) both miss; the mapping row materialises only
    // by the time the deferred inputFactory computes the seed (call 3+),
    // mimicking a concurrent same-thread writer racing admission.
    let reads = 0;
    const checkpointStore: CheckpointStore = {
      checkpointer: new MemorySaver(),
      async close() {},
      touchThread() {},
      getThread(threadId) {
        reads++;
        if (reads < 3) return undefined;
        return { threadId, publicId: null, owner: "test-user", createdAt: 0, updatedAt: 0, lastError: null };
      },
      listThreads: () => [],
      deleteThread: () => false,
      deleteThreadsForOwner: () => 0,
    };
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const fake = makeFakeJobRunner([
      { status: "succeeded", taskId: "task-1", threadId: "thr-1" },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore,
      pins,
      ledger,
      jobRunner: fake as unknown as JobRunner,
    });
    // Single user turn: no client history — a "recreated" (known) thread with a
    // missing checkpoint must force the reseed round-trip (reseed_required)
    // rather than silently seed.
    const res = await postChat(app, chatBody({
      background: true, messageId: "mapping-race", thread_id: "mapping-race",
      messages: [{ role: "user", content: "hello" }],
    }));
    assert.equal(res.status, 200, "admission validation saw no mapping and seeded");
    const d = fake.calls[0]!;
    const seedContext = {
      graph: {} as never,
      threadId: checkpointThreadId("test-user", "mapping-race"),
      isReplay: false,
      signal: new AbortController().signal,
    };
    // The stale `false` snapshot must NOT suppress the live re-read: now that
    // the concurrent writer's mapping row exists, the turn is recreated
    // (reseed_required), never a fresh seed.
    await assert.rejects(
      async () => d.inputFactory!(seedContext),
      { name: "ReseedRequiredError" },
      "known thread with no checkpoint and no client history forces reseed_required",
    );
    assert.equal(reads, 3, "snapshot + validation + one inputFactory live read");
  });

  test("duplicate and rejected admissions release only their exact pins", async (t) => {
    for (const reject of [false, true]) {
      const pins = new CredentialPinStore();
      const modelPin = pins.pin("test-user", "openrouter", { apiKey: "original-model" });
      const toolPin = pins.pin("test-user", "vikunja", { apiKey: "original-tool" });
      const budget = createBudgetManager({ maxConcurrentPerUser: 1, queueMaxPerUser: 0 });
      const held = reject ? budget.reserveSync("test-user") : undefined;
      const runner = makeFakeJobRunner([{ status: "in_flight", taskId: "duplicate", threadId: "thread" }]);
      const { app } = await makeApp(t, {
        pins, budget, checkpointStore: fakeCheckpointStore(), ledger: makeLedger(), jobRunner: runner as unknown as JobRunner,
      });
      const response = await postChat(app, chatBody({ background: true, messageId: "duplicate", credentials: {
        openrouter: { apiKey: "replacement-model" }, vikunja: { apiKey: "replacement-tool" },
      } }));
      assert.equal(response.status, reject ? 503 : 202);
      assert.equal(pins.get("test-user", "openrouter").handle, modelPin.handle);
      assert.equal(pins.get("test-user", "vikunja").handle, toolPin.handle);
      if (!reject) {
        const handles = runner.calls[0]!.pinHandles!;
        assert.notEqual(handles.openrouter, modelPin.handle);
        assert.throws(() => pins.get("test-user", "openrouter", handles.openrouter));
      }
      if (held?.ok) held.release();
    }
  });

  test("warmups use bound read-only credentials only for admitted requests and remain disabled by default", async (t) => {
    for (const enabled of [false, true]) {
      const env = await makeEnv(await makeTempDir(t));
      const budget = createBudgetManager();
      const calls: Array<{ plugin: string; tool: string; credentials: unknown }> = [];
      const warmups = createWarmupManager({
        enabled, registry: env.registry, cache: createToolResultCache(), budget,
        createHandler: () => ({ async execute(plugin, tool, _args, credentials) {
          calls.push({ plugin, tool, credentials });
          return "[]";
        } }),
      });
      t.after(() => warmups.dispose());
      const { app } = await makeApp(t, { warmups, budget, buildModel: makeFakeBuildModel([[{ content: "ok" }]]).buildModelFn });
      const body = chatBody({ credentials: { openrouter: { apiKey: "model-key" }, vikunja: { apiKey: "tool-key" } } });
      assert.equal((await postChat(app, { ...body, messages: [] })).status, 400);
      assert.equal(calls.length, 0);
      const held = [budget.reserveSync("test-user"), budget.reserveSync("test-user")];
      assert.equal((await postChat(app, body)).status, 429);
      assert.equal(calls.length, 0);
      for (const slot of held) if (slot.ok) slot.release();
      await (await postChat(app, body)).text();
      await waitFor(() => warmups.activeCount === 0);
      assert.deepEqual(calls, enabled ? [{ plugin: "vikunja", tool: "list_tasks", credentials: { apiKey: "tool-key" } }] : []);
    }
  });
});

describe("POST /v1/chat/completions — agent resolution (Wave 1, Step 4)", () => {
  test("no agent field: existing behavior unchanged", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "Hello" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }, [agentPlugin()]);
    const res = await postChat(app, chatBody({ credentials: { openrouter: { apiKey: "sk-test" }, vikunja: { apiKey: "tok-123" } } }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.modelPluginId, "openrouter");
    assert.equal(fake.calls[0]!.requestModel, undefined);
    // System prompt is the default supervisor prompt (no agent override)
    const systemMsg = fake.recordedInputs[0]!.find((m) => m.constructor.name === "SystemMessage");
    assert.ok(systemMsg, "system prompt present");
  });

  test("valid agent id without modelRef: model stays as-is, systemPrompt overrides", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "agent reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }, [agentPlugin()]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      credentials: { openrouter: { apiKey: "sk-test" }, vikunja: { apiKey: "tok-123" } },
    }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.modelPluginId, "openrouter", "model plugin unchanged when agent has no modelRef");
    const systemMsg = fake.recordedInputs[0]!.find((m) => m.constructor.name === "SystemMessage");
    assert.ok(systemMsg, "system prompt present");
    assert.match(String(systemMsg!.content), /kitchen assistant/, "agent system prompt overrides default");
  });

  test("agent with modelRef: model plugin overridden", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "agent reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }, [agentPlugin({ modelRef: "openrouter", tools: [] })]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      credentials: { openrouter: { apiKey: "sk-test" } },
    }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.modelPluginId, "openrouter", "agent modelRef overrides client model");
  });

  test("agent with required tool grant but missing credentials → 400 invalid_credentials", async (t) => {
    const { app } = await makeApp(t, {}, [agentPlugin()]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      credentials: { openrouter: { apiKey: "sk-test" } },
    }));
    assert.equal(res.status, 400);
    const json = await res.json() as { error: string; message?: string };
    assert.equal(json.error, "invalid_credentials");
    assert.match(json.message ?? "", /vikunja/, "error message references the missing tool plugin");
  });

  test("unknown agent id → 400 invalid_request", async (t) => {
    const { app } = await makeApp(t, {}, [agentPlugin()]);
    const res = await postChat(app, chatBody({ agent: "does-not-exist" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
  });

  test("non-agent plugin id in agent field → 400 invalid_request", async (t) => {
    const { app } = await makeApp(t, {}, [agentPlugin()]);
    const res = await postChat(app, chatBody({ agent: "vikunja" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
  });

  test("agent with empty tools array: no tool plugins bind", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "no tools" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }, [agentPlugin({ tools: [] })]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      credentials: { openrouter: { apiKey: "sk-test" } },
    }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fake.calls.length, 1);
    // With empty agent tools, no tool plugins are bound (the model should never call tools)
    const turn = fake.recordedInputs[0]!;
    assert.ok(turn.length > 0, "model received messages");
  });

  test("agent with inference overrides merges into requestParameters", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "agent reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn }, [agentPlugin({
      inference: { temperature: 0.3, maxTokens: 512, visionCapable: true },
    })]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      credentials: { openrouter: { apiKey: "sk-test" }, vikunja: { apiKey: "tok-123" } },
    }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.requestParameters?.["temperature"], 0.3);
    assert.equal(fake.calls[0]!.requestParameters?.["maxTokens"], 512);
  });

  test("background (async) path with agent: systemPrompt threads through to the runner", async (t) => {
    const checkpointStore = fakeCheckpointStore();
    const pins = new CredentialPinStore();
    const ledger = makeLedger();
    const runner = makeFakeJobRunner([
      { status: "succeeded", taskId: "task-agent", threadId: "thr-agent" },
    ]);
    const { app } = await makeApp(t, {
      checkpointStore,
      pins,
      ledger,
      jobRunner: runner as unknown as JobRunner,
    }, [agentPlugin()]);
    const res = await postChat(app, chatBody({
      agent: "kitchen-copilot",
      background: true,
      messageId: "msg-agent",
      thread_id: "thread-agent",
      credentials: { openrouter: { apiKey: "sk-test" }, vikunja: { apiKey: "tok-123" } },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "succeeded",
      taskId: "task-agent",
      threadId: "thr-agent",
    });
    assert.equal(runner.calls.length, 1, "background: runner called once");
    const d = runner.calls[0]!;
    assert.equal(d.modelPluginId, "openrouter", "background: model plugin unchanged");
    assert.equal(d.systemPrompt, "You are a kitchen assistant. Use tools sparingly.", "background: systemPrompt in descriptor");
    assert.deepEqual(d.toolPlugins, ["vikunja"], "background: tool scoping from agent grants");
  });
});