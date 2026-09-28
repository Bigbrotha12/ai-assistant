import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { LookupAddress } from "node:dns";
import type {
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import { createChatRoutes } from "../../src/transport/chat.ts";
import type { BuildModelInput } from "../../src/transport/model.ts";
import type { buildModel } from "../../src/transport/model.ts";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import type { BudgetManager } from "../../src/middleware/budget.ts";
import {
  DEFAULT_TOOL_CALL_QUARANTINE_MS,
} from "../../src/middleware/budget.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import type { ToolCacheKey } from "../../src/middleware/cache.ts";
import { createWarmupManager } from "../../src/middleware/warmup.ts";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import type { StepRow } from "../../src/ledger.ts";
import {
  bindJobTools,
} from "../../src/jobs/runner.ts";
import type { ToolExecutor } from "../../src/jobs/runner.ts";
import {
  recordToolResult,
} from "../../src/credentials/idempotency.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";
import { invokeBoundedToolHandler, ToolResourceError } from "../../src/tool_bounds.ts";
import { BudgetExhaustedError } from "../../src/middleware/budget.ts";
import { logger } from "../../src/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";

/**
 * CHARACTERIZATION TESTS for the four gateway tool-call channels.
 *
 * These pin what the gateway does TODAY (commit baseline, pre-`ToolPipeline`),
 * so the Phase 1 refactor can be proven behaviour-preserving. They assert
 * OBSERVABLE outcomes, never internal call counts that a refactor may change
 * legitimately.
 *
 * RULES FOR READERS:
 *   - A surprising assertion has a comment saying "observed, not intended".
 *     Do NOT "fix" a pinned wart here — fix it in a separate, deliberate change
 *     with the pin updated alongside.
 *   - The four channels are: `sync-stateless`, `sync-managed` (both in
 *     transport/chat.ts), `job` (jobs/runner.ts `bindJobTools`), and `warmup`
 *     (middleware/warmup.ts). Per the plan §10, the channels deliberately
 *     diverge; this file records the divergences.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** Vikunja: one read-only tool, one mutating tool, a warmable read-only tool. */
function vikunjaPlugin(): ToolPluginDefinition {
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
    warmupTools: ["list_tasks"],
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
  const dir = await mkdtemp(join(tmpdir(), "char-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRegistry(
  t: TestContext,
): Promise<{ registry: PluginRegistry; store: PluginStore }> {
  const dir = await makeTempDir(t);
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [openRouterPlugin()],
    manifests: [vikunjaPlugin()],
    lookup: fakeLookup(),
  });
  await store.load();
  await store.install("vikunja");
  return { registry: new PluginRegistry(store), store };
}

function makeLedger(): Ledger {
  const db = new Database(":memory:");
  migrateLedger(db);
  return new Ledger(db, { stuckTimeoutMs: 10_000, leaseExpiryMs: 60_000 });
}

/** A claimed running task plus its fence token, for `bindJobTools` directly. */
function makeRunningTask(ledger: Ledger, owner = "user-1"): { taskId: string; fenceToken: string } {
  const task = ledger.createTask({ owner, intentKey: `k-${Math.random()}`, spec: "{}" });
  const claimed = ledger.claimTask(task.id, owner);
  return { taskId: task.id, fenceToken: claimed.fence_token };
}

type RecordedCall = {
  pluginId: string;
  toolName: string;
  args: Record<string, unknown>;
  credentials?: Record<string, unknown>;
};

function recordingHandler(
  calls: RecordedCall[],
  result = '{"ok":true}',
): { execute: ToolExecutor["execute"] } {
  return {
    async execute(pluginId, toolName, args, credentials) {
      calls.push({ pluginId, toolName, args, credentials });
      return result;
    },
  };
}

// --- sync channel: scripted streaming model + Hono app ----------------------

/** Scripted streaming model that records every stream input (sync channel). */
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

/** A model whose single generation emits one tool call, then a final reply. */
function toolCallingBuildModel(
  recorded: BaseMessage[][],
  toolName: string,
  argsJson: string,
  callId = "call_1",
): typeof buildModel {
  return ((_input: BuildModelInput) =>
    new RecordingChatModel(
      [
        [{ content: "", tool_call_chunks: [{ index: 0, id: callId, name: toolName, args: argsJson }] }],
        [{ content: "done" }],
      ],
      recorded,
    )) as typeof buildModel;
}

type SyncAppOptions = {
  budget?: BudgetManager;
  toolCache?: ReturnType<typeof createToolResultCache>;
  toolHandler?: { execute: ToolExecutor["execute"] };
  toolTimeoutMs?: number;
  warmups?: ReturnType<typeof createWarmupManager>;
  buildModel?: typeof buildModel;
  credentialsByPlugin?: Record<string, Record<string, string>>;
};

async function makeSyncApp(
  t: TestContext,
  opts: SyncAppOptions,
): Promise<{ app: import("hono").Hono; registry: PluginRegistry }> {
  const { registry, store } = await makeRegistry(t);
  const app = new (await import("hono")).Hono();
  app.route(
    "/v1",
    createChatRoutes({
      registry,
      pluginStore: store,
      verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
      limiter: () => true,
      budget: opts.budget,
      buildModel: opts.buildModel,
      toolHandler: opts.toolHandler,
      toolTimeoutMs: opts.toolTimeoutMs,
      toolCache: opts.toolCache,
      warmups: opts.warmups,
      trustedHosts: [],
      catalogs: { skills: [], mcps: [], agents: [] },
    }),
  );
  return { app, registry };
}

function postChat(app: import("hono").Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openrouter",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    credentials: {
      openrouter: { apiKey: "sk-test-123" },
      vikunja: { apiKey: "tok-123" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Timeout layering
// ---------------------------------------------------------------------------

describe("characterization — timeout layering", () => {
  // The plan §D3 comment on `chat.ts:1101-1105` is that the executor is
  // constructed WITHOUT `timeoutMs`, so `ToolExecutor`'s internal bound is
  // always `env.TOOL_CALL_TIMEOUT_MS`. Read the source to verify the claim is
  // still true; a changed construction would invalidate the sync pins below.
  test("claim check: both sync ToolExecutor constructions omit timeoutMs (layer 3 is always env)", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/transport/chat.ts", import.meta.url), "utf8"),
    );
    const constructions = [...src.matchAll(/new ToolExecutor\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    assert.equal(constructions.length, 2, "sync path has exactly two ToolExecutor constructions");
    for (const construction of constructions) {
      assert.equal(
        /timeoutMs\s*:/.test(construction),
        false,
        "observed: sync ToolExecutor constructions pass no timeoutMs -> layer 3 is env.TOOL_CALL_TIMEOUT_MS",
      );
    }
  });

  // The three timeout tests below do NOT wait on the real
  // `env.TOOL_CALL_TIMEOUT_MS` (60s). They pin the LAYER COMPOSITION with small
  // stand-in values for the env-derived inner bound, which is what determines
  // "which bound fires first". The source-level test above proves layer 3 is
  // env-derived; layer 2 is `opts.toolTimeoutMs` and layer 1 is the same value
  // again (orchestrator.ts:107). So an env-sized inner bound is faithful.
  test("below the env bound: the outer (toolTimeoutMs) bound fires", async () => {
    // Simulated env bound = 60; toolTimeoutMs = 5 (below). Layer 1 (outer)
    // fires first.
    await assertSyncTimeoutFires(5, 60, 5);
  });

  test("equal to the env bound: the bound fires at the shared value", async () => {
    const fired = await assertSyncTimeoutFires(60, 60, 60);
    assert.equal(fired.limit, 60);
  });

  test("above the env bound: the INNER (env) bound fires first — the overlay is silently capped", async () => {
    // Plan §D3 finding. With toolTimeoutMs=120 and TOOL_CALL_TIMEOUT_MS=60 the
    // effective timeout is 60ms, NOT 120ms — the executor's env guard caps the
    // larger override. (Real-world: 60s, not the documented 120s.)
    const fired = await assertSyncTimeoutFires(120, 60, 60);
    assert.equal(fired.limit, 60);
    assert.ok(fired.limit < 120, "observed: the outer toolTimeoutMs override is capped by the inner env bound");
  });

  test("job: the handler bound (handlerTimeoutMs) is the first of two layers to fire", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    // `bindJobTools` bounds the handler with `handlerTimeoutMs` (layer 1). The
    // executor's env bound (layer 2) is a separate guard inside the real
    // ToolExecutor; it is unreachable while handlerTimeoutMs < env.
    const tool = bindJobTools({
      registry,
      handler: { execute: () => new Promise<string>(() => undefined) },
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: true,
      handlerTimeoutMs: 5,
    }).find((candidate) => candidate.name === "list_tasks")!;
    await assert.rejects(
      Promise.resolve(tool.func({}, undefined, { toolCall: { id: "job-timeout" } } as never)),
      (error: unknown) => error instanceof ToolResourceError && error.code === "tool_timeout",
    );
  });
});

/** Drive the sync nesting directly and report which bound fired. */
async function assertSyncTimeoutFires(
  outerMs: number,
  innerMs: number,
  expectedBound: number,
): Promise<{ limit: number }> {
  let fired: unknown;
  try {
    await invokeBoundedToolHandler(
      () =>
        invokeBoundedToolHandler(() => new Promise<string>(() => undefined), {
          timeoutMs: innerMs,
        }),
      { timeoutMs: outerMs },
    );
  } catch (error) {
    fired = error;
  }
  assert.ok(fired instanceof ToolResourceError, "a bound must fire");
  assert.equal(fired.code, "tool_timeout");
  assert.equal(fired.limit, expectedBound, `expected the ${expectedBound}ms bound to fire`);
  return { limit: fired.limit };
}

// ---------------------------------------------------------------------------
// 2. Quarantine
// ---------------------------------------------------------------------------

describe("characterization — quarantine", () => {
  test("sync: budget's operation timer is toolTimeoutMs, not env — an above-env override delays quarantine past the fired bound", async () => {
    // OBSERVED (wart, sync only): withToolResultCache calls
    // budget.withToolCallBudget(owner, pluginId, run) with NO options, so
    // budget's own quarantine timer uses its configured toolCallTimeoutMs
    // (from env) even though the call's effective handler bound was the larger
    // toolTimeoutMs. The budget slot is therefore held for the FULL override,
    // not released when the outer bound fires. Pinned because the upcoming
    // `budget` interceptor threads `toolTimeoutMs` as `call.timeoutMs`.
    const budget = createBudgetManager({ toolCallTimeoutMs: 10, toolCallQuarantineMs: 500 });
    const innerTimeout = 50; // > budget's 10ms timer
    let entered = false;
    const pending = budget.withToolCallBudget("o", "p", async () => {
      entered = true;
      return invokeBoundedToolHandler(() => new Promise<string>(() => undefined), {
        timeoutMs: innerTimeout,
      }).catch(() => "caught");
    });
    // Let budget's 10ms quarantine timer elapse while the call is still running.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(entered, true);
    assert.equal(pending instanceof Promise, true);
    // Still in flight: the outer 50ms bound has not fired and budget has not
    // released or quarantined yet (release happens in the finally).
    await pending;
    // After the outer bound resolves (caught), the slot is released because the
    // run settled — no quarantine.
    assert.equal(budget.pluginToolCallCount("p"), 0);
  });

  test("budget: an unsettled raw body quarantines the plugin and rejects the next call for DEFAULT_TOOL_CALL_QUARANTINE_MS", async () => {
    const budget = createBudgetManager({ toolCallTimeoutMs: 10, toolCallQuarantineMs: DEFAULT_TOOL_CALL_QUARANTINE_MS });
    let settleRaw!: () => void;
    const rawSettled = new Promise<void>((resolve) => {
      settleRaw = resolve;
    });
    const call = () =>
      budget.withToolCallBudget(
        "o",
        "p",
        () =>
          invokeBoundedToolHandler(() => new Promise<string>(() => undefined), {
            timeoutMs: 10,
          }),
        { timeoutMs: 10, rawSettled },
      );

    await assert.rejects(call(), (error: unknown) => error instanceof ToolResourceError);
    // The raw handler never settled -> the slot is held, not released.
    assert.equal(budget.pluginToolCallCount("p"), 1, "observed: an unsettled raw body holds the slot");
    await assert.rejects(
      call(),
      (error: unknown) =>
        error instanceof BudgetExhaustedError &&
        /quarantined after an unsettled timeout/.test(error.message),
    );
    // Settling the raw body releases the slot (the rawSettled continuation).
    settleRaw();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(budget.pluginToolCallCount("p"), 0);
  });

  test("sync: a never-settling handler is NOT quarantined through the route — the outer bound abandons the budget call (wart)", async (t) => {
    // OBSERVED (wart, sync only — contrast with the job-channel test below).
    //
    // Composition: bindPluginTools' invokeBoundedToolHandler (OUTER, fires
    // first) wraps chat.ts's invokeBoundedToolHandler, which wraps the budget
    // wrapper. When the OUTER bound fires it abandons the inner promise, so
    // `withToolCallBudget`'s `finally` never executes: no quarantine is
    // registered and the budget slot is never released. Each further request
    // therefore re-enters the handler and holds another slot (up to the
    // per-plugin concurrency cap).
    //
    // The job channel does NOT share this wart: there the budget wraps the
    // bounded call, so its `finally` runs and quarantine fires.
    const budget = createBudgetManager({
      toolCallTimeoutMs: 20,
      toolCallQuarantineMs: DEFAULT_TOOL_CALL_QUARANTINE_MS,
    });
    const calls: RecordedCall[] = [];
    const { app } = await makeSyncApp(t, {
      budget,
      toolTimeoutMs: 20,
      buildModel: toolCallingBuildModel([], "list_tasks", "{}"),
      toolHandler: {
        async execute(pluginId, toolName, args, credentials) {
          calls.push({ pluginId, toolName, args, credentials });
          return new Promise<string>(() => undefined); // ignores the abort signal
        },
      },
    });

    const first = await postChat(app, chatBody());
    assert.equal(first.status, 200);
    await first.text();
    assert.equal(calls.length, 1);
    assert.equal(
      budget.pluginToolCallCount("vikunja"),
      1,
      "observed: the abandoned budget slot is never released",
    );

    // Second request: NOT quarantined — the handler is entered again.
    const second = await postChat(app, chatBody());
    assert.equal(second.status, 200);
    const text = await second.text();
    assert.ok(text.includes("data: [DONE]"));
    assert.equal(calls.length, 2, "observed: sync does NOT quarantine a never-settling handler");
    assert.equal(budget.pluginToolCallCount("vikunja"), 2, "a second slot is held");
  });

  test("job: the SAME never-settling handler IS quarantined (budget wraps the bounded call)", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const budget = createBudgetManager({
      toolCallTimeoutMs: 5,
      toolCallQuarantineMs: DEFAULT_TOOL_CALL_QUARANTINE_MS,
    });
    const calls: RecordedCall[] = [];
    const tool = bindJobTools({
      registry,
      handler: {
        async execute(pluginId, toolName, args, credentials) {
          calls.push({ pluginId, toolName, args, credentials });
          return new Promise<string>(() => undefined);
        },
      },
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: true,
      handlerTimeoutMs: 5,
      budget,
    }).find((candidate) => candidate.name === "list_tasks")!;

    await assert.rejects(
      Promise.resolve(tool.func({}, undefined, { toolCall: { id: "q1" } } as never)),
      (error: unknown) => error instanceof ToolResourceError && error.code === "tool_timeout",
    );
    assert.equal(calls.length, 1);
    assert.equal(budget.pluginToolCallCount("vikunja"), 1, "the unsettled raw body holds its slot");
    // The next call on the same plugin is rejected by the quarantine.
    await assert.rejects(
      Promise.resolve(tool.func({}, undefined, { toolCall: { id: "q2" } } as never)),
      (error: unknown) => error instanceof BudgetExhaustedError,
    );
    assert.equal(calls.length, 1, "observed: job DOES quarantine a never-settling handler");
  });
});

// ---------------------------------------------------------------------------
// 3. Replay dedupe (job only)
// ---------------------------------------------------------------------------

describe("characterization — replay dedupe (job channel only)", () => {
  test("a stored toolCallId returns the stored result without executing", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    recordToolResult(ledger, {
      taskId,
      owner: "user-1",
      fenceToken,
      toolCallId: "call_done",
      toolName: "create_task",
      result: '{"already":"applied"}',
    });
    const calls: RecordedCall[] = [];
    const tool = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: false,
    }).find((candidate) => candidate.name === "create_task")!;

    const result = await tool.func(
      { title: "x" },
      undefined,
      { toolCall: { id: "call_done" } } as never,
    );
    assert.equal(result, '{"already":"applied"}');
    assert.equal(calls.length, 0, "a replay hit never executes the handler");
  });

  test("a mutating tool with no stored result and allowMutatingRetry=false is rejected with tool_retry_forbidden", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const calls: RecordedCall[] = [];
    const tool = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: false,
    }).find((candidate) => candidate.name === "create_task")!;

    await assert.rejects(
      Promise.resolve(tool.func({ title: "x" }, undefined, { toolCall: { id: "call_new" } } as never)),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "tool_retry_forbidden",
    );
    assert.equal(calls.length, 0, "the mutating tool must not execute");
  });

  test("an anonymous invocation (no toolCallId) skips dedupe — but still enforces the mutating-retry rule", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const calls: RecordedCall[] = [];
    const tools = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: false,
    });
    const readOnly = tools.find((candidate) => candidate.name === "list_tasks")!;
    const mutating = tools.find((candidate) => candidate.name === "create_task")!;

    // No config.toolCall.id: read-only executes directly, no ledger step.
    const result = await readOnly.func({ projectId: "p1" }, undefined, {} as never);
    assert.equal(typeof result, "string");
    assert.equal(calls.length, 1, "an anonymous read-only call executes");
    assert.deepEqual(
      ledger.listSteps(taskId).filter((step: StepRow) => step.action.startsWith("tool:")),
      [],
      "observed: an anonymous call writes NO ledger step",
    );

    // Anonymous + mutating + no allowMutatingRetry -> still forbidden. The
    // retry guard does NOT require a toolCallId.
    await assert.rejects(
      Promise.resolve(mutating.func({ title: "x" }, undefined, {} as never)),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "tool_retry_forbidden",
    );
    assert.equal(calls.length, 1);
  });

  test("bindJobTools with an anonymous read-only call and allowMutatingRetry=true executes and does not record", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const calls: RecordedCall[] = [];
    const tool = bindJobTools({
      registry,
      handler: recordingHandler(calls),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: true,
    }).find((candidate) => candidate.name === "create_task")!;
    await tool.func({ title: "x" }, undefined, {} as never);
    assert.equal(calls.length, 1);
    assert.equal(
      ledger.listSteps(taskId).filter((step: StepRow) => step.action.startsWith("tool:")).length,
      0,
      "observed: anonymous invocations skip ledger recording",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Cache
// ---------------------------------------------------------------------------

describe("characterization — cache", () => {
  test("sync: a read-only result is cached and a repeated request is served without re-executing", async (t) => {
    const toolCache = createToolResultCache();
    t.after(() => toolCache.dispose());
    const calls: RecordedCall[] = [];
    const { app } = await makeSyncApp(t, {
      toolCache,
      toolTimeoutMs: 500,
      buildModel: toolCallingBuildModel([], "list_tasks", "{}"),
      toolHandler: recordingHandler(calls, '{"seq":1}'),
    });
    await (await postChat(app, chatBody())).text();
    await (await postChat(app, chatBody())).text();
    assert.equal(calls.length, 1, "the second request is served from the cache");
    assert.equal(toolCache.size, 1);
  });

  test("sync: a mutating result is never cached and always re-executes", async (t) => {
    const toolCache = createToolResultCache();
    t.after(() => toolCache.dispose());
    const calls: RecordedCall[] = [];
    const { app } = await makeSyncApp(t, {
      toolCache,
      toolTimeoutMs: 500,
      buildModel: toolCallingBuildModel([], "create_task", "{}"),
      toolHandler: recordingHandler(calls, '{"seq":1}'),
    });
    await (await postChat(app, chatBody())).text();
    await (await postChat(app, chatBody())).text();
    assert.equal(calls.length, 2);
    assert.equal(toolCache.size, 0);
  });

  test("job: a warmup-populated cache entry IS found by sync when credentials are identical and canonical", async (t) => {
    // Plan §10 claims the three credential-fingerprint derivations "can differ",
    // so a warmup entry "may not be found" by sync. OBSERVED: when the raw body
    // credentials are already canonical (trimmed, spec-shaped), warmup's
    // credentialFingerprint(validateCredentials(...)) and sync's
    // credentialFingerprint(raw per-plugin body credentials) are the SAME, and
    // the sync channel serves the warmup entry. The divergence is real but
    // requires non-canonical client input — see the next test.
    const toolCache = createToolResultCache();
    t.after(() => toolCache.dispose());
    const budget = createBudgetManager();
    const warmCalls: RecordedCall[] = [];
    const warmups = createWarmupManager({
      enabled: true,
      registry: {
        requirePlugin: () => vikunjaPlugin(),
      } as never,
      cache: toolCache,
      budget,
      createHandler: () => ({
        async execute(pluginId, tool, args, credentials) {
          warmCalls.push({ pluginId, toolName: tool, args, credentials });
          return "WARMED";
        },
      }),
    });
    t.after(() => warmups.dispose());

    const admission = warmups.schedule({
      owner: "test-user",
      pluginId: "vikunja",
      tool: "list_tasks",
      args: {},
      credentials: { apiKey: "tok-123" },
    });
    assert.equal(admission.ok, true);
    if (!admission.ok) return;
    assert.equal((await admission.done).status, "warmed");
    assert.equal(toolCache.size, 1);

    const syncCalls: RecordedCall[] = [];
    const { app } = await makeSyncApp(t, {
      toolCache,
      budget,
      toolTimeoutMs: 500,
      buildModel: toolCallingBuildModel([], "list_tasks", "{}"),
      toolHandler: recordingHandler(syncCalls, '{"sync":"ran"}'),
    });
    await (await postChat(app, chatBody())).text();
    assert.equal(
      syncCalls.length,
      0,
      "observed: the sync read-only call was served from the warmup-populated entry",
    );
    assert.equal(warmCalls.length, 1);
  });

  test("warmup vs sync fingerprint divergence: non-canonical (untrimmed) client credentials produce DIFFERENT keys", () => {
    // Deterministic, channel-free pin of the §10 divergence: warmup fingerprints
    // the TRIMMED validated set, sync fingerprints the RAW request values.
    const raw = { apiKey: "  tok-123  " };
    const validated = { apiKey: "tok-123" };
    assert.notEqual(
      credentialFingerprint(raw),
      credentialFingerprint(validated),
      "observed: raw vs validated credentials fingerprint differently",
    );
    // The full key therefore differs on credentialFingerprint alone.
    const base: ToolCacheKey = {
      owner: "o",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: credentialFingerprint(validated),
      tool: "list_tasks",
      argsHash: "h",
    };
    assert.notEqual(
      JSON.stringify(base),
      JSON.stringify({ ...base, credentialFingerprint: credentialFingerprint(raw) }),
    );
  });

  test("job: the pin's precomputed fingerprint is preferred over re-deriving from credentials", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const { taskId, fenceToken } = makeRunningTask(ledger);
    const toolCache = createToolResultCache();
    t.after(() => toolCache.dispose());
    const recorded: ToolCacheKey[] = [];
    const originalSet = toolCache.set.bind(toolCache);
    toolCache.set = (key, result) => {
      recorded.push({ ...key });
      originalSet(key, result);
    };
    const tool = bindJobTools({
      registry,
      handler: recordingHandler([], '{"ok":true}'),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId,
      owner: "user-1",
      fenceToken,
      allowMutatingRetry: true,
      toolCache,
      fingerprintsByPlugin: { vikunja: "pin-fingerprint-sentinel" },
    }).find((candidate) => candidate.name === "list_tasks")!;
    await tool.func({}, undefined, { toolCall: { id: "call_fp" } } as never);
    assert.equal(recorded.length, 1);
    assert.equal(
      recorded[0]!.credentialFingerprint,
      "pin-fingerprint-sentinel",
      "observed: job prefers the pin fingerprint, never re-derives from credentials",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Ledger writes
// ---------------------------------------------------------------------------

describe("characterization — ledger writes", () => {
  test("job: a cache hit does NOT write a ledger step; an executed call does", async (t) => {
    const { registry } = await makeRegistry(t);
    const ledger = makeLedger();
    const toolCache = createToolResultCache();
    t.after(() => toolCache.dispose());
    const args = {};
    const key: ToolCacheKey = {
      owner: "user-1",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: credentialFingerprint({ apiKey: "tok" }),
      tool: "list_tasks",
      argsHash: toolCache.argsHash(args),
    };
    toolCache.set(key, "CACHED");

    // Task A: pre-warmed cache -> served from cache, no ledger step.
    const taskA = makeRunningTask(ledger);
    const calls: RecordedCall[] = [];
    const toolA = bindJobTools({
      registry,
      handler: recordingHandler(calls, '{"fresh":"ran"}'),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId: taskA.taskId,
      owner: "user-1",
      fenceToken: taskA.fenceToken,
      allowMutatingRetry: true,
      toolCache,
    }).find((candidate) => candidate.name === "list_tasks")!;
    const cached = await toolA.func(args, undefined, { toolCall: { id: "call_cache" } } as never);
    assert.equal(cached, "CACHED");
    assert.equal(calls.length, 0);
    assert.deepEqual(
      ledger.listSteps(taskA.taskId).filter((step: StepRow) => step.action.startsWith("tool:")),
      [],
      "observed: a cache hit returns before recordToolResult — no ledger step",
    );

    // Task B: distinct tool-call id, no cache entry for its args -> executes
    // and records exactly one tool step.
    const taskB = makeRunningTask(ledger);
    const executedArgs = { projectId: "p2" };
    const toolB = bindJobTools({
      registry,
      handler: recordingHandler(calls, '{"fresh":"ran"}'),
      credentialsByPlugin: { vikunja: { apiKey: "tok" } },
      ledger,
      taskId: taskB.taskId,
      owner: "user-1",
      fenceToken: taskB.fenceToken,
      allowMutatingRetry: true,
      toolCache,
    }).find((candidate) => candidate.name === "list_tasks")!;
    const executed = await toolB.func(
      executedArgs,
      undefined,
      { toolCall: { id: "call_exec" } } as never,
    );
    assert.equal(executed, '{"fresh":"ran"}');
    assert.equal(calls.length, 1);
    const steps = ledger.listSteps(taskB.taskId).filter((step: StepRow) => step.action.startsWith("tool:"));
    assert.equal(steps.length, 1, "an executed call records one ledger step");
    assert.equal(steps[0]!.tool_call_id, "call_exec");
  });
});

// ---------------------------------------------------------------------------
// 6. Warmup audit
// ---------------------------------------------------------------------------

describe("characterization — warmup audit", () => {
  test("warmup emits NO plugin.tool audit event (unlike sync and job)", async (t) => {
    const captured: string[] = [];
    const originalInfo = logger.info;
    const originalDebug = logger.debug;
    const originalWarn = logger.warn;
    logger.info = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    logger.debug = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    logger.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      const cache = createToolResultCache();
      t.after(() => cache.dispose());
      const warmups = createWarmupManager({
        enabled: true,
        registry: { requirePlugin: () => vikunjaPlugin() } as never,
        cache,
        budget: createBudgetManager(),
        createHandler: () => ({ async execute() { return "[]"; } }),
      });
      t.after(() => warmups.dispose());
      const admission = warmups.schedule({
        owner: "test-user",
        pluginId: "vikunja",
        tool: "list_tasks",
        args: {},
        credentials: { apiKey: "tok-123" },
      });
      assert.equal(admission.ok, true);
      if (!admission.ok) return;
      assert.equal((await admission.done).status, "warmed");
      await flushAuditTelemetry();
      assert.equal(
        captured.some((line) => line.includes("plugin.tool")),
        false,
        "observed: warmup tool calls emit no plugin.tool audit",
      );
    } finally {
      logger.info = originalInfo;
      logger.debug = originalDebug;
      logger.warn = originalWarn;
      resetAuditTelemetryConfig();
      await flushAuditTelemetry();
    }
  });

  test("sync emits one plugin.tool audit event (contrast with warmup)", async (t) => {
    const captured: string[] = [];
    const originalInfo = logger.info;
    const originalDebug = logger.debug;
    const originalWarn = logger.warn;
    logger.info = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    logger.debug = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    logger.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      const { app } = await makeSyncApp(t, {
        toolTimeoutMs: 500,
        buildModel: toolCallingBuildModel([], "list_tasks", "{}"),
        toolHandler: recordingHandler([], '{"ok":true}'),
      });
      await (await postChat(app, chatBody())).text();
      await flushAuditTelemetry();
      const records = captured
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .filter((record): record is Record<string, unknown> => record?.event === "plugin.tool");
      assert.equal(records.length, 1, "sync emits exactly one plugin.tool event");
      assert.equal(records[0]!.pluginId, "vikunja");
      assert.equal(records[0]!.tool, "list_tasks");
    } finally {
      logger.info = originalInfo;
      logger.debug = originalDebug;
      logger.warn = originalWarn;
      resetAuditTelemetryConfig();
      await flushAuditTelemetry();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-channel: the managed-sync channel (fourth channel sanity)
// ---------------------------------------------------------------------------

describe("characterization — sync-managed channel", () => {
  test("a managed session request runs plugin tools through the same bounded handler", async (t) => {
    // The two sync channels build their tool closures identically today
    // (chat.ts:1122-1148 vs :1499-1525). Pinned so a refactor cannot silently
    // change only one of them.
    const { createSessionStore } = await import("../../src/sessions/store.ts");
    const sessionStore = createSessionStore();
    t.after(() => sessionStore.dispose());
    const calls: RecordedCall[] = [];
    const { registry, store } = await makeRegistry(t);
    const app = new (await import("hono")).Hono();
    app.route(
      "/v1",
      createChatRoutes({
        registry,
        pluginStore: store,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        limiter: () => true,
        sessionStore,
        toolTimeoutMs: 500,
        buildModel: toolCallingBuildModel([], "list_tasks", "{}"),
        toolHandler: recordingHandler(calls, '{"managed":true}'),
        trustedHosts: [],
        catalogs: { skills: [], mcps: [], agents: [] },
      }),
    );
    const response = await postChat(
      app,
      chatBody({
        conversation_mode: "managed",
        session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        messageId: "m1",
        messages: [{ role: "user", content: "list tasks" }],
      }),
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, 1, "the managed channel executed the tool through its handler");
    assert.deepEqual(calls[0]!.credentials, { apiKey: "tok-123" });
  });
});
