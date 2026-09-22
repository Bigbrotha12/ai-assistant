import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
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
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type {
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import { createChatRoutes } from "../../src/transport/chat.ts";
import type { Catalogs, ResolvedAgentDef } from "../../src/catalog/index.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import type { BuildModelInput } from "../../src/transport/model.ts";
import { ModelBuildError } from "../../src/transport/model.ts";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import type { BudgetManager } from "../../src/middleware/budget.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import { createSessionStore } from "../../src/sessions/store.ts";
import type { SessionStore } from "../../src/sessions/store.ts";
import { createSessionRoutes } from "../../src/sessions/routes.ts";
import type { Ledger } from "../../src/ledger.ts";

/**
 * Managed-session path (plan §4/§5) transport tests: `session_id` establishes
 * and deltas against the in-memory `createSessionStore`, the wire-shape
 * dedupe responses, the session read-back route, the establish body cap, and
 * the eviction recovery flow. Everything is fake/in-memory: a real
 * `PluginStore` over a temp dir, a scripted recording model via the
 * `buildModel` seam, and a store injected with a fake clock for TTL eviction.
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
  const dir = await mkdtemp(join(tmpdir(), "chat-sessions-"));
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

/** Scripted streaming model that records every stream input. */
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

/** A chat model whose stream explodes mid-turn (drives `on_chat_model_error`). */
class ExplodingChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  readonly recordedInputs: BaseMessage[][];

  constructor(recordedInputs: BaseMessage[][]) {
    super({});
    this.recordedInputs = recordedInputs;
  }

  _llmType(): string {
    return "exploding-chat";
  }

  bindTools(tools: StructuredToolInterface[]) {
    return new ExplodingChatModel(this.recordedInputs).withConfig({
      tools,
    } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    throw new Error("upstream model unavailable");
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.recordedInputs.push(_messages);
    throw new Error("upstream model unavailable");
  }
}

type FakeBuildModel = {
  buildModelFn: typeof import("../../src/transport/model.ts").buildModel;
  /** Every `BuildModelInput` handed to the seam, in call order. */
  calls: BuildModelInput[];
  /** Every message array fed to the model, in call order. */
  recordedInputs: BaseMessage[][];
};

/**
 * The `buildModel` test seam: scripted replies per call index; calls at
 * `explodeAt` indices return a model whose stream throws mid-turn.
 */
function makeFakeBuildModel(
  replies: Array<Array<Record<string, unknown>>>,
  explodeAt: number[] = [],
): FakeBuildModel {
  const calls: BuildModelInput[] = [];
  const recordedInputs: BaseMessage[][] = [];
  const buildModelFn = ((input: BuildModelInput) => {
    const index = calls.length;
    calls.push(input);
    if (explodeAt.includes(index)) {
      return new ExplodingChatModel(recordedInputs);
    }
    const reply = replies[index];
    return new RecordingChatModel(reply ? [reply] : [], recordedInputs);
  }) as FakeBuildModel["buildModelFn"];
  return { buildModelFn, calls, recordedInputs };
}

/** Fake clock + injectable timers (drives the store's TTL sweep deterministically). */
function makeClock(initial = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  fireIntervals: () => void;
} {
  let now = initial;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setInterval: ((fn: () => void) => {
      const handle = {} as unknown as ReturnType<typeof setInterval>;
      timers.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval,
    fireIntervals: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

function buildCatalogs(): Catalogs {
  const agentDefs: ResolvedAgentDef[] = [];
  return { skills: [], mcps: [], agents: agentDefs };
}

type AppOptions = {
  verifyKey?: VerifyApiKeyFn;
  buildModel?: typeof import("../../src/transport/model.ts").buildModel;
  sessionStore?: SessionStore;
  ledger?: Ledger;
  budget?: BudgetManager;
};

async function makeApp(
  t: TestContext,
  opts: AppOptions = {},
): Promise<{ app: Hono; sessionStore: SessionStore }> {
  const dir = await makeTempDir(t);
  const { store, registry } = await makeEnv(dir);
  const sessionStore = opts.sessionStore ?? createSessionStore();
  t.after(() => sessionStore.dispose());
  const app = new Hono();
  app.route(
    "/v1",
    createChatRoutes({
      registry,
      pluginStore: store,
      verifyKey: opts.verifyKey ?? (async () => "test-user"),
      limiter: () => true,
      buildModel: opts.buildModel,
      sessionStore,
      ledger: opts.ledger,
      budget: opts.budget,
      trustedHosts: [],
      catalogs: buildCatalogs(),
    }),
  );
  app.route(
    "/v1",
    createSessionRoutes({ store: sessionStore, verifyKey: opts.verifyKey ?? (async () => "test-user") }),
  );
  return { app, sessionStore };
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

/** POST with an abortable signal so the tests can simulate a client cancel. */
function postChatAbortable(
  app: Hono,
  body: unknown,
  controller: AbortController = new AbortController(),
): { response: Promise<Response>; controller: AbortController } {
  const response = Promise.resolve(
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }),
  );
  return { response, controller };
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openrouter",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    credentials: { openrouter: { apiKey: "sk-test-123" } },
    ...overrides,
  };
}

function getSession(app: Hono, sessionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/sessions/${sessionId}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    }),
  );
}

function deleteSession(app: Hono, sessionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }),
  );
}

/** The read-back's messages for an owner-scoped session (200 expected). */
async function readSessionMessages(
  app: Hono,
  sessionId: string,
): Promise<Array<{ role: string; content: string }>> {
  const res = await getSession(app, sessionId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
  return body.messages;
}

/**
 * Poll the read-back until `predicate` holds or the timeout elapses. The turn
 * finalization (`finalizeSessionTurn`) runs asynchronously after the stream
 * terminates, so post-cancel read-backs must poll rather than assume the mark
 * already landed.
 */
async function pollReadBack(
  app: Hono,
  sessionId: string,
  predicate: (messages: Array<{ role: string; content: string }>) => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const messages = await readSessionMessages(app, sessionId);
    if (predicate(messages)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`read-back never satisfied: ${label}`);
}

/** String contents of a recorded model turn, excluding the graph's system prompt. */
function contentsOf(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m.constructor.name !== "SystemMessage")
    .map((m) => m.content)
    .filter((c): c is string => typeof c === "string");
}

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("POST /v1/chat/completions — managed session path (plan §4/§5)", () => {
  test("establish turn (full history) streams a reply with x-session-id + seeded state", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "first reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"), "stream terminates");
    assert.equal(res.headers.get("x-session-id"), SID);
    assert.equal(res.headers.get("x-conversation-state"), "seeded");
    // The model received the full establish history.
    assert.deepEqual(contentsOf(fake.recordedInputs[0]!), ["first", "second"]);
  });

  test("delta turn appends one user message and feeds the model the accumulated history", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "reply one" }],
      [{ content: "reply two" }],
    ]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const delta = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: "how are you" }],
      }),
    );
    assert.equal(delta.status, 200);
    const text = await delta.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.equal(delta.headers.get("x-session-id"), SID);
    assert.equal(delta.headers.get("x-conversation-state"), "resumed");
    // The delta model turn saw the full accumulated session: the establish
    // history + its own reply + the new user message.
    assert.deepEqual(contentsOf(fake.recordedInputs[1]!), [
      "hello",
      "reply one",
      "how are you",
    ]);
  });

  test("compaction re-base (F2): a full-history body under a LIVE session replaces messages and returns seeded", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "seed reply" }],
      [{ content: "rebase reply" }],
    ]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();
    assert.equal(seed.headers.get("x-conversation-state"), "seeded");

    // Client compaction re-base: a TRIMMED history under the SAME session_id.
    // The server must REPLACE messages (not treat it as a delta append).
    const rebase = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "old message" },
          { role: "assistant", content: "old reply" },
          { role: "user", content: "live question" },
        ],
      }),
    );
    assert.equal(rebase.status, 200);
    await rebase.text();
    assert.equal(rebase.headers.get("x-conversation-state"), "seeded");
    // The model saw the full re-base body (not just the last user message).
    assert.deepEqual(contentsOf(fake.recordedInputs[1]!), [
      "old message",
      "old reply",
      "live question",
    ]);

    // The server replaced messages: the pre-re-base content is GONE and the
    // re-base body + the reply are readable back.
    const read = await getSession(app, SID);
    const body = (await read.json()) as {
      sessionId: string;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.sessionId, SID);
    assert.equal(body.messages.some((m) => m.content === "hello"), false, "pre-re-base message gone");
    assert.deepEqual(
      body.messages.map((m) => [m.role, m.content]),
      [
        ["system", "sys"],
        ["user", "old message"],
        ["assistant", "old reply"],
        ["user", "live question"],
        ["assistant", "rebase reply"],
      ],
    );
  });

  test("same messageId re-sent after completion -> already_completed (no taskId/terminalStatus); reply readable via GET", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "the answer" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const establishBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
    const first = await postChat(app, establishBody);
    assert.equal(first.status, 200);
    await first.text();

    const retry = await postChat(app, establishBody);
    assert.equal(retry.status, 200);
    const json = (await retry.json()) as Record<string, unknown>;
    assert.deepEqual(json, { status: "already_completed", sessionId: SID, messageId: "m1" });
    assert.equal("taskId" in json, false, "no taskId on the session dedupe surface");
    assert.equal("terminalStatus" in json, false, "no terminalStatus");
    assert.equal("threadId" in json, false, "no threadId");
    assert.equal(fake.recordedInputs.length, 1, "the model ran exactly once");
    // F3: the client requires x-conversation-state on every managed 2xx.
    assert.equal(retry.headers.get("x-session-id"), SID);
    assert.equal(retry.headers.get("x-conversation-state"), "resumed");

    // The reply is persisted into the session and readable via read-back.
    const read = await getSession(app, SID);
    assert.equal(read.status, 200);
    const body = (await read.json()) as { sessionId: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.sessionId, SID);
    assert.ok(
      body.messages.some((m) => m.role === "assistant" && m.content === "the answer"),
      "assistant reply is readable via GET /v1/sessions/:id",
    );
  });

  test("failed turn rolls back; same messageId retries as a clean re-run, then dedupes to already_completed", async (t) => {
    const fake = makeFakeBuildModel(
      [
        [{ content: "seed reply" }],
        [{ content: "(unused — boom)" }],
        [{ content: "retried ok" }],
      ],
      [1], // the boom delta (build call 1) explodes mid-stream
    );
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const boomBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m2",
      messages: [{ role: "user", content: "boom" }],
    });
    const boom = await postChat(app, boomBody);
    assert.equal(boom.status, 200, "mid-stream failure does not change the HTTP status");
    const boomText = await boom.text();
    assert.ok(boomText.includes('"error"'), "SSE carries an error envelope");
    assert.ok(boomText.includes("data: [DONE]"));
    assert.equal(fake.recordedInputs.length, 2, "boom turn reached the model");

    // markFailed rolled the failed user turn back (not visible in the read-back).
    const after = await getSession(app, SID);
    const afterBody = (await after.json()) as { messages: Array<{ content: string }> };
    assert.equal(
      afterBody.messages.some((m) => m.content === "boom"),
      false,
      "failed user message rolled back",
    );

    // Retrying the SAME messageId is a clean re-run (plan §4 step 6): the
    // model runs again and streams a successful reply.
    const retry = await postChat(app, boomBody);
    assert.equal(retry.status, 200);
    const retryText = await retry.text();
    assert.ok(retryText.includes("data: [DONE]"));
    assert.ok(!retryText.includes('"error"'), "the retried turn streams a clean reply");
    assert.equal(retry.headers.get("x-conversation-state"), "resumed");
    assert.equal(fake.recordedInputs.length, 3, "the retry re-runs the model");

    // The re-appended user message appears EXACTLY once in the session.
    const read = await getSession(app, SID);
    const readBody = (await read.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(
      readBody.messages.filter((m) => m.content === "boom").length,
      1,
      "retried user message appears exactly once",
    );
    assert.ok(
      readBody.messages.some((m) => m.role === "assistant" && m.content === "retried ok"),
      "retried reply is persisted",
    );

    // A second duplicate send of that messageId is now already_completed.
    const dup = await postChat(app, boomBody);
    assert.equal(dup.status, 200);
    assert.deepEqual(await dup.json(), {
      status: "already_completed",
      sessionId: SID,
      messageId: "m2",
    });
    assert.equal(dup.headers.get("x-conversation-state"), "resumed");
    assert.equal(fake.recordedInputs.length, 3, "no model run for the duplicate");
  });

  test("delta hitting a full budget pool -> 429 busy AND the turn is rolled back (same messageId retries as a clean re-run)", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "seed reply" }],
      [{ content: "(unused — busy build never streams)" }],
      [{ content: "retried ok" }],
    ]);
    const budget = createBudgetManager({ maxConcurrentPerUser: 1 });
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn, budget });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    // Hold the owner's only budget slot directly so the delta's `reserveSync`
    // returns `{ ok: false }` -> the designed busy path.
    const held = budget.reserveSync("test-user");
    assert.ok(held.ok, "held reservation must be granted");
    t.after(() => {
      if (held.ok) held.release();
    });

    const deltaBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m2",
      messages: [{ role: "user", content: "busy turn" }],
    });
    const busy = await postChat(app, deltaBody);
    assert.equal(busy.status, 429);
    assert.deepEqual(await busy.json(), { error: "busy" });
    assert.equal(busy.headers.get("retry-after"), "10");

    // N1: the appended user message was rolled back — the session read-back
    // must NOT contain the busy turn's message.
    const after = await readSessionMessages(app, SID);
    assert.equal(
      after.some((m) => m.content === "busy turn"),
      false,
      "busy turn rolled back (not left in_progress)",
    );

    // Release the slot; a retry of the SAME messageId is a clean re-run (plan
    // §4 step 6) rather than a permanent 409 conversation_in_flight.
    held.release();
    const retry = await postChat(app, deltaBody);
    assert.equal(retry.status, 200);
    const text = await retry.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.ok(!text.includes('"error"'), "the retried turn streams a clean reply");
    assert.equal(retry.headers.get("x-conversation-state"), "resumed");
    assert.equal(fake.recordedInputs.length, 2, "the retried turn re-runs the model");
  });

  test("model-build failure rolls the turn back; a same-messageId retry re-runs (not conversation_in_flight)", async (t) => {
    const recordedInputs: BaseMessage[][] = [];
    let buildCount = 0;
    const buildModelFn = ((_input: BuildModelInput) => {
      buildCount += 1;
      if (buildCount === 2) {
        throw new ModelBuildError(
          "missing_credentials",
          "plugin 'openrouter' requires an apiKey",
        );
      }
      return new RecordingChatModel([[{ content: "ok reply" }]], recordedInputs);
    }) as FakeBuildModel["buildModelFn"];
    const { app } = await makeApp(t, { buildModel: buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();
    assert.equal(buildCount, 1);

    const deltaBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m2",
      messages: [{ role: "user", content: "boom build" }],
    });
    const boom = await postChat(app, deltaBody);
    assert.equal(boom.status, 400, "model-build failure keeps the pre-stream error");
    assert.deepEqual(await boom.json(), { error: "invalid_credentials" });
    assert.equal(buildCount, 2, "the failing delta reached the model build");

    // N1: the appended user message was rolled back.
    const after = await readSessionMessages(app, SID);
    assert.equal(
      after.some((m) => m.content === "boom build"),
      false,
      "failed build's user message rolled back (not left in_progress)",
    );

    // A retry of the SAME messageId is a clean re-run (not conversation_in_flight).
    const retry = await postChat(app, deltaBody);
    assert.equal(retry.status, 200);
    const text = await retry.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.ok(!text.includes('"error"'), "the retried turn streams a clean reply");
    assert.equal(retry.headers.get("x-conversation-state"), "resumed");
    assert.equal(buildCount, 3, "the retry rebuilds the model");
    assert.equal(recordedInputs.length, 2, "the retry re-runs the model");
  });

  test("fresh session + single-message body establishes (F1: the first turn is a single-message full history)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "first reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: "brand-new-session",
        messageId: "m1",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.equal(res.headers.get("x-session-id"), "brand-new-session");
    assert.equal(res.headers.get("x-conversation-state"), "seeded");
    assert.deepEqual(contentsOf(fake.recordedInputs[0]!), ["hi"]);
    assert.equal(fake.recordedInputs.length, 1, "the first turn ran the model exactly once");
  });

  test("evicted session + single-message body -> 409 session_missing (evicted) so the client re-establishes with full history (F1)", async (t) => {
    const clock = makeClock();
    const sessionStore = createSessionStore({
      idleTtlMs: 1000,
      sweepIntervalMs: 1000,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => sessionStore.dispose());
    const { app } = await makeApp(t, { sessionStore });

    await sessionStore.establish("test-user", SID, []);
    clock.advance(1001);
    clock.fireIntervals(); // TTL sweep evicts → leaves a tombstone

    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "session_missing",
      reason: "evicted",
    });
    assert.equal(res.headers.get("x-session-id"), SID);
  });

  test("evicted session -> 409 session_missing (evicted); re-establish under the same session_id -> seeded", async (t) => {
    const clock = makeClock();
    const sessionStore = createSessionStore({
      idleTtlMs: 1000,
      sweepIntervalMs: 1000,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => sessionStore.dispose());
    const fake = makeFakeBuildModel([[{ content: "first reply" }], [{ content: "reseeded reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn, sessionStore });

    const establishBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
    const seed = await postChat(app, establishBody);
    assert.equal(seed.status, 200);
    await seed.text();

    // Force the idle-TTL sweep to evict the session.
    clock.advance(1001);
    clock.fireIntervals();

    const delta = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: "are you there" }],
      }),
    );
    assert.equal(delta.status, 409);
    assert.deepEqual(await delta.json(), {
      error: "session_missing",
      reason: "evicted",
    });

    // Recovery: the client re-establishes under the SAME session_id.
    const reseed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m3",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "full history again" },
        ],
      }),
    );
    assert.equal(reseed.status, 200);
    await reseed.text();
    assert.equal(reseed.headers.get("x-conversation-state"), "seeded");
    assert.deepEqual(contentsOf(fake.recordedInputs[1]!), ["full history again"]);
  });

  test("concurrent identical messageId runs the model exactly once; the loser gets in_flight or already_completed", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "seed" }], [{ content: "deduped" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const deltaBody = chatBody({
      conversation_mode: "managed",
      session_id: SID,
      messageId: "m-dup",
      messages: [{ role: "user", content: "race" }],
    });
    const [r1, r2] = await Promise.all([postChat(app, deltaBody), postChat(app, deltaBody)]);
    const statuses = [r1.status, r2.status];
    assert.ok(statuses.includes(200), `one request streamed, got ${statuses.join(",")}`);
    const other = r1.status === 200 ? r2 : r1;
    if (other.status === 409) {
      assert.equal((await other.json() as { error: string }).error, "conversation_in_flight");
    } else {
      assert.equal((await other.json() as { status: string }).status, "already_completed");
    }
    // Drain the winner's stream so its model turn has completed.
    await (r1.status === 200 ? r1 : r2).text();
    // Establish (1 turn) + one winner (1 turn); no double model execution.
    assert.equal(fake.recordedInputs.length, 2);
  });

  test("session delta with no trailing user message -> 400 invalid_request", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "ok" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const bad = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "assistant", content: "not a user turn" }],
      }),
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: string }).error, "invalid_request");
  });

  test("session_id wins over thread_id for managed turns", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        thread_id: "11111111-2222-3333-4444-555555555555",
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(res.headers.get("x-session-id"), SID);
    assert.equal(res.headers.get("x-thread-id"), null, "no thread header on the session path");
    assert.equal(res.headers.get("x-conversation-state"), "seeded");
  });

  test("abort AFTER the reply frames completes the outcome (F4): the delivered reply is retained", async (t) => {
    const fake = makeFakeBuildModel([
      [{ content: "seed reply" }],
      [{ content: "delivered reply" }],
    ]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const { response, controller } = postChatAbortable(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: "cancel after reply?" }],
      }),
    );
    const res = await response;
    assert.equal(res.status, 200);
    const decoder = new TextDecoder();
    let acc = "";
    const reader = res.body!.getReader();
    // Read until the §3.3 finish frame is on the wire. The finish frame is
    // emitted while processing the root on_chain_end — which `captureAssistantReply`
    // observes (replyComplete) BEFORE yielding it onward — so reading it
    // guarantees the full reply was generated AND emitted before the abort.
    // (Note: `"finish_reason":null` appears on every delta frame, so match the
    // terminal value `"stop"`.)
    while (!acc.includes('"finish_reason":"stop"')) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    assert.ok(acc.includes('"finish_reason":"stop"'), "the reply + finish frame reached the wire");
    // Abort now, before [DONE].
    controller.abort();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // the abort may reject the reader; the drain is best-effort
    }

    // The delivered reply must NOT be rolled back (F4). The read-back races the
    // async finalization, so poll for the reply to land.
    await pollReadBack(
      app,
      SID,
      (messages) =>
        messages.some((m) => m.role === "assistant" && m.content === "delivered reply"),
      "delivered reply retained in the session",
    );
    const messages = await readSessionMessages(app, SID);
    assert.equal(
      messages.filter((m) => m.content === "cancel after reply?").length,
      1,
      "the user turn is retained",
    );
  });

  test("abort mid-stream (F4): no reply reached the wire -> the turn is rolled back", async (t) => {
    // A gated model: the second turn's reply is held until the test releases
    // it. On release AFTER the abort it throws (instead of producing a reply),
    // so the stream terminates without a clean reply and the turn is rolled
    // back — deterministic, no race with the graph completing on its own.
    const controller = new AbortController();
    const recordedInputs: BaseMessage[][] = [];
    let gate!: () => void;
    const gatePromise = new Promise<void>((resolve) => { gate = resolve; });
    class GatedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
      constructor(private readonly requestSignal: AbortSignal) {
        super({});
      }
      _llmType(): string { return "gated-chat"; }
      bindTools(_tools: StructuredToolInterface[]) { return this; }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        return { generations: [{ message: new AIMessage("gated"), text: "" }] };
      }
      async *_streamResponseChunks(
        messages: BaseMessage[],
        _options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatGenerationChunk> {
        recordedInputs.push(messages);
        await gatePromise; // park here until the test aborts
        if (this.requestSignal.aborted) {
          throw new Error("client aborted mid-stream");
        }
        const chunk = new AIMessageChunk({ content: "gated reply" });
        const text = "gated reply";
        const generation = new ChatGenerationChunk({ message: chunk, text });
        await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk: generation });
        yield generation;
      }
    }
    let buildCount = 0;
    const buildModelFn = (() => {
      buildCount += 1;
      if (buildCount === 2) return new GatedChatModel(controller.signal);
      return new RecordingChatModel([[{ content: "seed reply" }]], recordedInputs);
    }) as FakeBuildModel["buildModelFn"];
    const { app } = await makeApp(t, { buildModel: buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const { response } = postChatAbortable(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: "boom mid-stream" }],
      }),
      controller,
    );
    const res = await response;
    assert.equal(res.status, 200);
    // Wait for the gated model to start streaming (and park on the gate) so the
    // abort is genuinely mid-stream.
    for (let i = 0; i < 100 && recordedInputs.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(recordedInputs.length, 2, "the second turn reached the model");
    controller.abort();
    gate(); // release the parked stream: it observes the abort and throws
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // best-effort drain
    }

    // No reply was delivered for the aborted turn and the aborted user turn is
    // rolled back (the seed turn's reply stays — it predates the abort). The
    // read-back races the async finalization, so poll for the rollback.
    await pollReadBack(
      app,
      SID,
      (messages) =>
        !messages.some((m) => m.content === "boom mid-stream") &&
        !messages.some((m) => m.role === "assistant" && m.content === "gated reply"),
      "aborted turn rolled back",
    );
    const messages = await readSessionMessages(app, SID);
    assert.equal(
      messages.some((m) => m.role === "assistant" && m.content === "seed reply"),
      true,
      "the pre-abort seed reply survives",
    );
  });
});

describe("GET /v1/sessions/:id read-back (§5)", () => {
  test("returns the accumulated messages for the owner", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply one" }], [{ content: "reply two" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();
    const delta = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: "again" }],
      }),
    );
    assert.equal(delta.status, 200);
    await delta.text();

    const res = await getSession(app, SID);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sessionId: string;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.sessionId, SID);
    assert.deepEqual(
      body.messages.map((m) => [m.role, m.content]),
      [
        ["system", "sys"],
        ["user", "hello"],
        ["assistant", "reply one"],
        ["user", "again"],
        ["assistant", "reply two"],
      ],
    );
  });

  test("cross-owner read is a 404 (never leaks the messages)", async (t) => {
    let owner = "alice";
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, {
      buildModel: fake.buildModelFn,
      verifyKey: async () => owner,
    });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    owner = "bob";
    const res = await getSession(app, SID);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("absent session is a 409 session_missing (restart)", async (t) => {
    const { app } = await makeApp(t);
    const res = await getSession(app, "never-created-session");
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "session_missing",
      reason: "restart",
    });
  });
});

describe("establish body cap (§5/R6)", () => {
  test("an establish larger than the establish cap -> 413 request_too_large", async (t) => {
    const { app } = await makeApp(t);
    const huge = "x".repeat(26 * 1024 * 1024);
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "user", content: "big" },
          { role: "user", content: huge },
        ],
      }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request_too_large" });
  });

  test("a delta over MAX_REQUEST_BODY_BYTES but under the establish cap is still 413", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "seed" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    // Establish the session first so the single-message request below is a
    // DELTA (F1: against a fresh session a single-message body would be an
    // establish and get the higher cap).
    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const big = "y".repeat(12 * 1024 * 1024); // 12 MiB > 10 MiB delta cap, < 25 MiB establish cap
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m2",
        messages: [{ role: "user", content: big }],
      }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request_too_large" });
  });

  test("a single-message body against a FRESH session gets the establish cap (F1)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "ok" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    // 12 MiB single-message first turn: over the delta cap but under the
    // establish cap → the 413 body-cap gate must NOT fire (it is an establish
    // per F1). It then hits the session byte cap backstop (§4/D7) and surfaces
    // as a 409 session_missing, NOT a 413 — proving the establish cap applied.
    const big = "z".repeat(12 * 1024 * 1024);
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: "fresh-session",
        messageId: "m1",
        messages: [{ role: "user", content: big }],
      }),
    );
    assert.notEqual(res.status, 413, "a fresh single-message establish is not body-capped as a delta");
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "session_missing", reason: "evicted" });
  });
});

describe("managed conversation mode — session_id is required (§5)", () => {
  test("managed + thread_id (no session_id) → 400 invalid_request (the checkpoint path is gone)", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "unused" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });
    const res = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        thread_id: "22222222-3333-4444-5555-666666666666",
        messageId: "m1",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, "invalid_request");
    assert.equal(fake.recordedInputs.length, 0, "no model run for a rejected managed request");
  });
});

describe("DELETE /v1/sessions/:id (§5)", () => {
  test("deletes the caller's session → { status: ok }; read-back reports session_missing", async (t) => {
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, { buildModel: fake.buildModelFn });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    const del = await deleteSession(app, SID);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { status: "ok" });

    const read = await getSession(app, SID);
    assert.equal(read.status, 409);
    assert.deepEqual(await read.json(), { error: "session_missing", reason: "restart" });
  });

  test("cross-owner delete is a 404, never a successful delete", async (t) => {
    let owner = "alice";
    const fake = makeFakeBuildModel([[{ content: "reply" }]]);
    const { app } = await makeApp(t, {
      buildModel: fake.buildModelFn,
      verifyKey: async () => owner,
    });

    const seed = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "m1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    assert.equal(seed.status, 200);
    await seed.text();

    owner = "bob";
    const del = await deleteSession(app, SID);
    assert.equal(del.status, 404);
    assert.deepEqual(await del.json(), { error: "not_found" });

    owner = "alice";
    const read = await getSession(app, SID);
    assert.equal(read.status, 200, "alice's session survives bob's delete");
  });

  test("missing session delete → 404 not_found", async (t) => {
    const { app } = await makeApp(t);
    const del = await deleteSession(app, "never-created-session");
    assert.equal(del.status, 404);
    assert.deepEqual(await del.json(), { error: "not_found" });
  });

  test("owner-scoped: one owner's delete leaves another owner's sessions intact (verify via GET)", async (t) => {
    let owner = "alice";
    const fake = makeFakeBuildModel([[{ content: "a" }], [{ content: "b" }]]);
    const { app } = await makeApp(t, {
      buildModel: fake.buildModelFn,
      verifyKey: async () => owner,
    });
    const sidB = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

    const seedA = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: SID,
        messageId: "mA",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "alice hello" },
        ],
      }),
    );
    assert.equal(seedA.status, 200);
    await seedA.text();

    owner = "bob";
    const seedB = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: sidB,
        messageId: "mB",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "bob hello" },
        ],
      }),
    );
    assert.equal(seedB.status, 200);
    await seedB.text();

    // Alice deletes HER session; bob's is untouched.
    owner = "alice";
    const del = await deleteSession(app, SID);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { status: "ok" });

    owner = "bob";
    const bobRead = await getSession(app, sidB);
    assert.equal(bobRead.status, 200, "bob's session is unaffected");
    const bobBody = (await bobRead.json()) as { sessionId: string };
    assert.equal(bobBody.sessionId, sidB);

    owner = "alice";
    const aliceRead = await getSession(app, SID);
    assert.equal(aliceRead.status, 409, "alice's deleted session is gone");
  });
});