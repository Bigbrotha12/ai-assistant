import { Hono } from "hono";
import type { Context } from "hono";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { inferenceLimiter, requireApiKey, unauthorized } from "../inference.ts";
import { bindPluginTools } from "../agents/orchestrator.ts";
import { createAgentGraph } from "../agents/graph.ts";
import { compileGraphWithCheckpointer } from "../agents/compile.ts";
import { ToolExecutor } from "../jobs/runner.ts";
import type {
  JobErrorCode,
  JobRunner,
  RunJobResult,
} from "../jobs/runner.ts";
import type { ThreadLockRegistry } from "../jobs/thread_lock.ts";
import { getOrCreateTask } from "../credentials/idempotency.ts";
import type { CredentialPinStore } from "../credentials/pins.ts";
import { checkpointThreadId } from "../checkpoints/store.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import {
  extractCredentialsFromBody,
  PluginCredentialError,
  validateCredentials,
} from "../plugins/credential.ts";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { PluginStoreError } from "../plugins/store.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isModelPlugin, isToolPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import type { RateLimiterFn, VerifyApiKeyFn } from "../plugins/routes.ts";
import type { Ledger, TaskRow } from "../ledger.ts";
import { toOpenAiSse } from "./openai.ts";
import { buildModel, ModelBuildError } from "./model.ts";
import type { BuildModelInput } from "./model.ts";

/**
 * OpenAI-compatible `POST /v1/chat/completions` transport (Phase 3, Waves C1/C2).
 *
 * The handler builds a LangChain agent from the installed MODEL plugin +
 * per-request credentials and either:
 *
 *   - SYNCHRONOUS (default): runs the supervisor graph and streams the result
 *     through the SSE adapter (`transport/openai.ts`) as `text/event-stream`.
 *   - ASYNCHRONOUS (`body.background === true`, Wave C2): admits an idempotent
 *     background task, pins the request's credentials, delegates to the
 *     `JobRunner`, and returns a JSON accepted/terminal response. The client
 *     polls `GET /ledger/tasks/by-key/:messageId` for the job's status.
 *
 * FLOW (sync, per request):
 *   1. gateway auth (`verifyKey`) -> 401
 *   2. per-owner token bucket (`limiter`) -> 429
 *   3. parse JSON body -> 400 on invalid JSON / missing model / empty messages
 *   4. resolve the model plugin from `body.model` (see MODEL SELECTION)
 *   5. extract + validate the plugin's credentials from `body.credentials`
 *      (see CREDENTIAL SOURCING) -> 400 invalid_credentials
 *   6. thread handling (see SEED/RESUME) under the shared per-thread lock
 *   7. build the model (`transport/model.ts`) + bind the real `ToolExecutor`,
 *      compile the agent graph over the checkpoint store (or checkpointer-free)
 *   8. `graph.streamEvents(input, { version: "v2", ... })` piped through
 *      `toOpenAiSse` as an SSE response (`text/event-stream`, `no-cache`).
 *
 * MODEL SELECTION: `body.model` is the model-plugin id (the client sends the id
 * it got from `GET /v1/models`). An optional `body.model_plugin` field
 * disambiguates a request that wants to override the provider model name: when
 * `model_plugin` is present, it wins as the plugin id and `body.model` is
 * treated as the provider model override (`requestModel`). Otherwise
 * `body.model` alone is the plugin id and the provider model falls back to the
 * plugin's `defaultModel`.
 *
 * CREDENTIAL SOURCING: the model key comes from the BODY —
 * `body.credentials[modelPluginId].apiKey` — NEVER from the Authorization
 * header. The header is gateway auth only; using it as the provider key would
 * let the gateway's own key leak to the provider and would make per-plugin key
 * rotation impossible. Missing/invalid -> 400 invalid_credentials.
 *
 * SEED/RESUME (conversation identity, plan Phase 3): when `body.thread_id` AND
 * a checkpoint store are both present, the handler maps the thread to an
 * owner-bound key (`checkpointThreadId`) and streams the graph with
 * `{ configurable: { thread_id } }`. The rule:
 *   - NO checkpoint yet for the thread -> SEED: the graph input is the client's
 *     full `messages` (client history creates the checkpoint).
 *   - A checkpoint EXISTS -> RESUME: only the LAST user message is appended
 *     (`{ messages: [lastUserMessage] }`); the client's history is ignored
 *     (checkpointed state is the source of truth). A resume with no user
 *     message degrades to `{ messages: [] }` (the graph re-runs on checkpointed
 *     state). "Has checkpoint" is detected via the CHECKPOINTER's `get`, never
 *     the `thread_owner` metadata row — `touchThread` writes that row before
 *     any checkpoint exists, so it cannot signal "already seeded".
 * When `thread_id` is absent OR no checkpoint store is available (boot
 * degraded, see index.ts), the run is STATELESS: the client's `messages` are
 * used verbatim and no checkpoint is written (documented degradation).
 *
 * SYNC VS ASYNC DECISION RULE (Wave C2):
 *   - `body.background === true` -> ASYNC delegation (below).
 *   - `body.background` absent or `false` -> the synchronous SSE stream.
 *   - any other value -> 400 invalid_request (`background must be a boolean`),
 *     so a malformed flag can never silently run synchronously.
 *
 * ASYNC DELEGATION (Wave C2): a background request:
 *   1. resolves the model plugin + validates credentials (shared with sync);
 *   2. requires `checkpointStore` + `jobRunner` + `ledger` + `pins` -> 503
 *      `{ error: "background_unavailable" }` when the async path is not wired;
 *   3. requires an idempotency key in `body.messageId` (see IDEMPOTENCY) ->
 *      400 invalid_request when missing;
 *   4. maps `thread_id` (or `messageId` when absent) to the owner-bound
 *      checkpoint thread and records it (`touchThread`);
 *   5. validates + PINS the model-plugin credential and every installed
 *      tool-plugin credential in `body.credentials` -> 400 invalid_credentials
 *      on failure, BEFORE any task is admitted;
 *   6. `getOrCreateTask(ledger, { owner, intentKey: messageId, spec })` —
 *      owner-scoped idempotent admission;
 *   7. `jobRunner.runJob({...})` with the pinned credentials (the runner's
 *      `buildModel` seam resolves the model pin) and the seed/resume input;
 *   8. maps the `RunJobResult` to HTTP (see JOB ERROR MAPPING).
 *
 * IDEMPOTENCY: the client generates `body.messageId` ONCE per send and reuses
 * it across retries. The ledger's v4 unique (owner, intent_key) index maps
 * (owner, messageId) to exactly ONE task forever, so a retried send never
 * creates a duplicate job. The status-by-key endpoint
 * (`GET /ledger/tasks/by-key/:messageId`) is the client's poll-after-drop
 * surface; this transport reuses it and does NOT duplicate the logic.
 *
 * THREAD LOCK (Wave C2): the sync stream and the `JobRunner` share a single
 * `ThreadLockRegistry` (constructed in index.ts). The sync handler acquires the
 * thread's mutex BEFORE the seed/resume read and holds it until the SSE stream
 * completes or aborts (released in the stream's finally / cancel), so two
 * concurrent requests on the same thread — or a sync stream racing a background
 * job — serialize instead of clobbering checkpoints. After the stream, a
 * best-effort optimistic re-check compares our final checkpoint id with the
 * thread's current id and LOGS a warning if a writer the mutex cannot see
 * (a second process sharing the DB) moved it; full re-evaluation is deferred
 * for the streaming path (the runner's `invoke` path retains it), because the
 * stream is already on the wire. The gateway is single-process (AGENTS.md), so
 * the mutex is the primary protection.
 *
 * JOB ERROR MAPPING (Wave C2; `JobErrorCode` -> HTTP):
 *   credentials_expired  -> 401 { error: "credentials_expired", message }
 *   task_conflict        -> 409 { error: "task_conflict", message }
 *   tool_retry_forbidden -> 409 { error: "tool_retry_forbidden", message }
 *   plugin_unavailable   -> 502 { error: "plugin_unavailable", message }
 *   job_failed           -> 500 { error: "job_failed", message }
 * The `message` is the runner's already-redacted error text.
 *
 * ERROR MAPPING (pre-stream; flat `{"error": <code>}` for consistency with the
 * sibling plugin/checkpoint surfaces — the wire-spec §5.1 categories are noted):
 *   401 unauthorized              no/invalid gateway key (auth_error)
 *   429 rate_limited              per-owner limiter rejected (rate_limited)
 *   400 invalid_request           invalid JSON; missing/unknown/non-model/
 *                                 non-streaming plugin; missing/empty messages
 *                                 (invalid_request_error)
 *   400 invalid_credentials       missing/invalid model-plugin credentials
 *                                 (auth_error, user-fixable)
 *   502 inference_unavailable     plugin registry unavailable (NOT_LOADED)
 *   503 background_unavailable    async path not wired (no runner/store)
 *   500 internal                  anything else (server_error; logged)
 * Mid-stream failures never change the HTTP status: the SSE adapter emits one
 * error envelope then [DONE] (§5.2).
 */

export type ChatRoutesOptions = {
  registry: PluginRegistry;
  pluginStore: PluginStore;
  /** Optional — when absent (boot failed), every run is stateless. */
  checkpointStore?: CheckpointStore;
  /** Optional — required for async delegation (`getOrCreateTask`). */
  ledger?: Ledger;
  /** Optional — the background job runner (Wave C2 async delegation). */
  jobRunner?: JobRunner;
  /**
   * Credential pin store SHARED with the job runner. Async admission pins the
   * model + tool credentials here; the runner reads them by (owner, pluginId).
   */
  pins?: CredentialPinStore;
  /**
   * Per-thread lock registry SHARED with the job runner. When present, sync
   * streams serialize against every other writer on the same checkpoint thread.
   */
  threadLocks?: ThreadLockRegistry;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
  /** Test seam; defaults to the per-owner `inferenceLimiter` token bucket. */
  limiter?: RateLimiterFn;
  /** Test seam; defaults to the real model builder (transport/model.ts). */
  buildModel?: typeof buildModel;
  /** Admin-trusted hosts for every outbound `validatedFetch` (model + tools). */
  trustedHosts?: readonly string[];
};

/**
 * The request config the transport hands to `JobRunner.runJob` as
 * `modelRequestConfig`, and that the runner's `buildModel` seam receives.
 *
 * It carries the OWNER (so the seam can resolve the owner-scoped model pin the
 * transport minted at admission) plus the provider model/parameter overrides.
 * It deliberately carries NO credential values — the pin store is the only
 * credential channel for admitted background jobs.
 */
export type JobModelRequestConfig = {
  /** Owner whose pinned model credential to resolve. */
  owner: string;
  /** Provider model override (`body.model` when `model_plugin` is set). */
  requestModel?: string;
  /** Request parameter overrides (temperature/max_tokens/top_p). */
  requestParameters?: Record<string, unknown>;
};

type StreamOptions = { version: "v2"; configurable?: Record<string, unknown> };

/** The compiled agent graph the sync path streams (createAgentGraph's type). */
type AgentGraph = ReturnType<typeof createAgentGraph>;

export function createChatRoutes(opts: ChatRoutesOptions): Hono {
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const limiter = opts.limiter ?? inferenceLimiter;

  const routes = new Hono();

  routes.post("/chat/completions", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    if (!limiter(owner)) return c.json({ error: "rate_limited" }, 429);

    const body = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: "invalid_request" }, 400);

    // Wave C2 sync-vs-async decision (see the module doc): only an explicit
    // boolean `true` selects the async path; `false`/absent is the C1 stream,
    // and any other value is rejected rather than silently running sync.
    const background = body["background"];
    if (background !== undefined && background !== false) {
      if (background !== true) {
        return c.json(
          { error: "invalid_request", message: "background must be a boolean" },
          400,
        );
      }
      return handleBackground(c, owner, body, opts);
    }
    return handleSyncStream(c, owner, body, opts);
  });

  return routes;
}

/**
 * Resolve + validate the model plugin and its credentials, and normalize the
 * request's messages/parameters/thread id. Shared by the sync and async paths
 * so the two never diverge on selection, credential sourcing, or validation.
 */
type ResolvedChat = {
  modelPluginId: string;
  requestModel: string | undefined;
  plugin: ModelPluginDefinition;
  credentials: Record<string, string>;
  rawMessages: unknown[];
  requestParameters: Record<string, unknown>;
  clientThreadId: string | undefined;
};

function resolveChatRequest(
  c: Context,
  body: Record<string, unknown>,
  registry: PluginRegistry,
): { ok: true; value: ResolvedChat } | { ok: false; response: Response } {
  const selection = resolveModelSelection(body);
  if (!selection) return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
  const { modelPluginId, requestModel } = selection;

  let plugin: ModelPluginDefinition;
  try {
    const resolved = registry.requirePlugin(modelPluginId);
    if (!isModelPlugin(resolved) || !resolved.inference.supportsStreaming) {
      return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
    }
    plugin = resolved;
  } catch (err) {
    if (err instanceof PluginRegistryError) {
      return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
    }
    if (err instanceof PluginStoreError && err.code === "NOT_LOADED") {
      return { ok: false, response: c.json({ error: "inference_unavailable" }, 502) };
    }
    return { ok: false, response: c.json({ error: "internal" }, 500) };
  }

  let credentials: Record<string, string>;
  try {
    const input = extractCredentialsFromBody(body, modelPluginId, plugin.credentials);
    credentials = validateCredentials(plugin.credentials, input, modelPluginId);
  } catch (err) {
    if (err instanceof PluginCredentialError) {
      return { ok: false, response: c.json({ error: "invalid_credentials" }, 400) };
    }
    return { ok: false, response: c.json({ error: "internal" }, 500) };
  }

  const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
  if (rawMessages.length === 0) {
    return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
  }

  // Legacy-field tolerance: `chat_template_kwargs` / `enable_thinking` are
  // simply ignored; `temperature` / `max_tokens` / `top_p` are forwarded as
  // parameter overrides so an older client's tuning still applies.
  const requestParameters: Record<string, unknown> = {};
  if (typeof body["temperature"] === "number") requestParameters["temperature"] = body["temperature"];
  if (typeof body["max_tokens"] === "number") requestParameters["maxTokens"] = body["max_tokens"];
  if (typeof body["top_p"] === "number") requestParameters["topP"] = body["top_p"];

  const clientThreadId =
    typeof body["thread_id"] === "string" && body["thread_id"].trim() !== ""
      ? body["thread_id"]
      : undefined;

  return {
    ok: true,
    value: {
      modelPluginId,
      requestModel,
      plugin,
      credentials,
      rawMessages,
      requestParameters,
      clientThreadId,
    },
  };
}

/**
 * The C1 synchronous streaming path. Builds the agent and streams SSE. When a
 * shared thread lock + checkpoint store are present, the seed/resume read and
 * the whole stream run under the thread's mutex (Wave C2).
 */
async function handleSyncStream(
  c: Context,
  owner: string,
  body: Record<string, unknown>,
  opts: ChatRoutesOptions,
): Promise<Response> {
  const resolved = resolveChatRequest(c, body, opts.registry);
  if (!resolved.ok) return resolved.response;
  const {
    modelPluginId,
    requestModel,
    plugin,
    credentials,
    rawMessages,
    requestParameters,
    clientThreadId,
  } = resolved.value;

  const buildModelFn = opts.buildModel ?? buildModel;
  const checkpointStore = opts.checkpointStore;
  const threadId =
    clientThreadId !== undefined && checkpointStore
      ? checkpointThreadId(owner, clientThreadId)
      : undefined;

  // Build the agent: model from the plugin + request, real ToolExecutor
  // (validatedFetch + pinned IPs + trusted hosts), compiled over the
  // checkpoint store when available.
  let model;
  try {
    model = buildModelFn({
      registry: opts.registry,
      pluginStore: opts.pluginStore,
      modelPluginId,
      requestModel,
      requestParameters,
      credentials,
      trustedHosts: opts.trustedHosts,
    } satisfies BuildModelInput);
  } catch (err) {
    return preStreamError(c, err);
  }

  const toolHandler = new ToolExecutor({
    registry: opts.registry,
    getPinnedIps: opts.pluginStore.getPinnedIps.bind(opts.pluginStore),
    trustedHosts: opts.trustedHosts,
  });
  const tools = bindPluginTools(opts.registry, toolHandler);
  const base = createAgentGraph({ model, tools });
  const graph = checkpointStore
    ? compileGraphWithCheckpointer(base, checkpointStore.checkpointer)
    : base;
  const modelId = requestModel ?? plugin.inference.defaultModel;

  const lock = opts.threadLocks;
  const lockable =
    threadId !== undefined && checkpointStore !== undefined && lock !== undefined;

  if (lockable) {
    // Acquire BEFORE the seed/resume read so the decision is made atomically
    // with the stream; released when the stream completes or is cancelled.
    const release = await lock.acquire(threadId);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    try {
      const { input, streamOptions } = await computeThreadInput(
        checkpointStore,
        owner,
        threadId,
        rawMessages,
      );
      return buildStreamResponse(
        graph,
        input,
        streamOptions,
        modelId,
        releaseOnce,
        () => verifyCheckpointUnmoved(checkpointStore, threadId, graph),
      );
    } catch (err) {
      releaseOnce();
      console.error("chat: locked stream setup failed", err);
      return c.json({ error: "internal" }, 500);
    }
  }

  // Stateless, or no shared lock wired (existing C1 behavior): no per-thread
  // serialization beyond the checkpointer itself.
  let input: Record<string, unknown>;
  let streamOptions: StreamOptions;
  if (threadId !== undefined && checkpointStore) {
    const computed = await computeThreadInput(
      checkpointStore,
      owner,
      threadId,
      rawMessages,
    );
    input = computed.input;
    streamOptions = computed.streamOptions;
  } else {
    input = { messages: toLangChainMessages(rawMessages) };
    streamOptions = { version: "v2" };
  }
  return buildStreamResponse(graph, input, streamOptions, modelId);
}

/**
 * Wave C2 async delegation. See the module doc (ASYNC DELEGATION) for the
 * step-by-step contract and IDEMPOTENCY for the `messageId` key.
 */
async function handleBackground(
  c: Context,
  owner: string,
  body: Record<string, unknown>,
  opts: ChatRoutesOptions,
): Promise<Response> {
  const { checkpointStore, jobRunner, ledger, pins } = opts;
  // The async path needs the runner, an owner-scoped ledger to admit against,
  // a checkpointer for the job thread, and the shared pin store.
  if (!checkpointStore || !jobRunner || !ledger || !pins) {
    return c.json({ error: "background_unavailable" }, 503);
  }

  const resolved = resolveChatRequest(c, body, opts.registry);
  if (!resolved.ok) return resolved.response;
  const {
    modelPluginId,
    requestModel,
    credentials,
    rawMessages,
    requestParameters,
    clientThreadId,
  } = resolved.value;

  // Idempotency key: the client generates `messageId` once per send and reuses
  // it across retries. Missing -> 400 before any admission/pinning.
  const messageId =
    typeof body["messageId"] === "string" ? body["messageId"].trim() : "";
  if (messageId === "") {
    return c.json(
      {
        error: "invalid_request",
        message: "messageId required for background requests",
      },
      400,
    );
  }

  // A background request without `thread_id` runs on a thread keyed by its
  // messageId (deterministic per send); the runner recomputes the same hash.
  const clientThread = clientThreadId ?? messageId;
  const threadId = checkpointThreadId(owner, clientThread);
  checkpointStore.touchThread(owner, threadId);

  // Validate + pin tool credentials first (atomic: all-or-nothing), then the
  // model credential. Any validation failure -> 400 before admission, and no
  // pin is left behind.
  const pinnedTools = pinToolPlugins(c, body, opts.registry, pins, owner);
  if (!pinnedTools.ok) return pinnedTools.response;
  const toolPlugins = pinnedTools.toolPlugins;
  pins.pin(owner, modelPluginId, credentials);

  const releasePins = (): void => {
    pins.release(owner, modelPluginId);
    for (const pluginId of toolPlugins) pins.release(owner, pluginId);
  };

  let task: TaskRow;
  try {
    task = await getOrCreateTask(ledger, {
      owner,
      intentKey: messageId,
      spec: intentSpec(rawMessages),
    });
  } catch (err) {
    console.error("chat: background task admission failed", err);
    releasePins();
    return c.json({ error: "internal" }, 500);
  }

  // Seed/resume input (mirrors the sync path): a fresh thread gets the client's
  // full history; an existing checkpoint gets only the last user message.
  let input: Record<string, unknown>;
  try {
    const checkpoint = await checkpointStore.checkpointer.get({
      configurable: { thread_id: threadId },
    });
    if (checkpoint) {
      const lastUser = lastUserMessage(rawMessages);
      input = { messages: lastUser ? [lastUser] : [] };
    } else {
      input = { messages: toLangChainMessages(rawMessages) };
    }
  } catch (err) {
    console.error("chat: background checkpoint probe failed", err);
    releasePins();
    return c.json({ error: "internal" }, 500);
  }

  let result: RunJobResult;
  try {
    result = await jobRunner.runJob({
      owner,
      intentKey: messageId,
      spec: task.spec,
      clientThreadId: clientThread,
      toolPlugins,
      modelPluginId,
      modelRequestConfig: {
        owner,
        requestModel,
        requestParameters,
      } satisfies JobModelRequestConfig,
      input,
    });
  } catch (err) {
    console.error("chat: background runJob threw", err);
    // The runner releases pins in its own finally for the claimed path; a
    // throw before claim (ledger edge) leaves them — release here as a safety
    // net so an unexpected throw never leaks pins until the next sweep.
    releasePins();
    return c.json({ error: "internal" }, 500);
  }

  return mapRunJobResult(c, result);
}

/**
 * Validate and PIN every installed TOOL plugin named in `body.credentials`.
 * Validation is all-or-nothing: nothing is pinned until every entry validates,
 * so a rejected request leaves no pin behind. Credentials for ids that are not
 * installed tool plugins (e.g. the selected model plugin, or a plugin the
 * client sent but this gateway does not have) are ignored — the job pins only
 * what it can use.
 */
function pinToolPlugins(
  c: Context,
  body: Record<string, unknown>,
  registry: PluginRegistry,
  pins: CredentialPinStore,
  owner: string,
): { ok: true; toolPlugins: string[] } | { ok: false; response: Response } {
  const credentialsField = isRecord(body["credentials"]) ? body["credentials"] : {};
  const validated: Array<{ pluginId: string; credentials: Record<string, string> }> = [];
  for (const pluginId of Object.keys(credentialsField)) {
    let plugin;
    try {
      plugin = registry.requirePlugin(pluginId);
    } catch {
      continue; // unknown / not installed — nothing to pin
    }
    if (!isToolPlugin(plugin)) continue; // model-plugin keys are not tool pins
    try {
      const input = extractCredentialsFromBody(body, pluginId, plugin.credentials);
      validated.push({
        pluginId,
        credentials: validateCredentials(plugin.credentials, input, pluginId),
      });
    } catch (err) {
      if (err instanceof PluginCredentialError) {
        return { ok: false, response: c.json({ error: "invalid_credentials" }, 400) };
      }
      return { ok: false, response: c.json({ error: "internal" }, 500) };
    }
  }
  for (const entry of validated) {
    pins.pin(owner, entry.pluginId, entry.credentials);
  }
  return { ok: true, toolPlugins: validated.map((entry) => entry.pluginId) };
}

/** `JobErrorCode` -> HTTP status for a failed background job. */
const JOB_ERROR_HTTP_STATUS: Record<JobErrorCode, 401 | 409 | 502 | 500> = {
  credentials_expired: 401,
  task_conflict: 409,
  tool_retry_forbidden: 409,
  plugin_unavailable: 502,
  job_failed: 500,
};

/**
 * Map a `RunJobResult` to the async HTTP response:
 *   - `in_flight` (a concurrent duplicate is running) -> 202 accepted;
 *   - `succeeded` -> 200 { status: "succeeded" };
 *   - `already_terminal` -> 200 { status: <terminalStatus> };
 *   - `failed` -> the JobErrorCode HTTP status with the redacted message.
 */
function mapRunJobResult(c: Context, result: RunJobResult): Response {
  switch (result.status) {
    case "in_flight":
      return c.json(
        { status: "accepted", taskId: result.taskId, threadId: result.threadId },
        202,
      );
    case "succeeded":
      return c.json(
        { status: "succeeded", taskId: result.taskId, threadId: result.threadId },
        200,
      );
    case "already_terminal":
      return c.json(
        {
          status: result.terminalStatus,
          taskId: result.taskId,
          threadId: result.threadId,
        },
        200,
      );
    case "failed":
      return c.json(
        { error: result.code, message: result.error },
        JOB_ERROR_HTTP_STATUS[result.code],
      );
  }
}

/**
 * The seed/resume input for a thread: a fresh thread gets the client's full
 * history; an existing checkpoint gets ONLY the last user message. Also records
 * the owner->thread mapping (`touchThread`). Shared by the sync (under lock)
 * and async paths.
 */
async function computeThreadInput(
  checkpointStore: CheckpointStore,
  owner: string,
  threadId: string,
  rawMessages: unknown[],
): Promise<{ input: Record<string, unknown>; streamOptions: StreamOptions }> {
  const checkpoint = await checkpointStore.checkpointer.get({
    configurable: { thread_id: threadId },
  });
  checkpointStore.touchThread(owner, threadId);
  if (checkpoint) {
    const lastUser = lastUserMessage(rawMessages);
    return {
      input: { messages: lastUser ? [lastUser] : [] },
      streamOptions: { version: "v2", configurable: { thread_id: threadId } },
    };
  }
  return {
    input: { messages: toLangChainMessages(rawMessages) },
    streamOptions: { version: "v2", configurable: { thread_id: threadId } },
  };
}

/**
 * Build the SSE `Response`. `onRelease` (the thread-lock release) is called
 * exactly once when the stream completes, errors, or is cancelled. The
 * post-stream `onAfterStream` hook is best-effort and never fails the stream.
 */
function buildStreamResponse(
  graph: AgentGraph,
  input: Record<string, unknown>,
  streamOptions: StreamOptions,
  modelId: string,
  onRelease?: () => void,
  onAfterStream?: () => void | Promise<void>,
): Response {
  const events = graph.streamEvents(input, streamOptions);
  const sse = toOpenAiSse(events, { modelId });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of sse) {
          controller.enqueue(encoder.encode(frame));
        }
        if (onAfterStream) {
          try {
            await onAfterStream();
          } catch (err) {
            console.warn("chat: post-stream checkpoint check failed", err);
          }
        }
      } catch (err) {
        console.error("chat: SSE stream error", err);
        controller.error(err);
      } finally {
        onRelease?.();
        controller.close();
      }
    },
    cancel() {
      onRelease?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

/**
 * Best-effort post-stream optimistic check (Wave C2). The shared thread mutex
 * already prevents in-process interleaving; this catches a writer the mutex
 * cannot see (a second process sharing the checkpoint DB) and LOGS it. The
 * stream is already on the wire, so re-evaluation is deferred for the
 * streaming path (the runner's `invoke` path retains full re-evaluation).
 */
async function verifyCheckpointUnmoved(
  checkpointStore: CheckpointStore,
  threadId: string,
  graph: AgentGraph,
): Promise<void> {
  try {
    const state = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as
      | { config?: { configurable?: { checkpoint_id?: unknown } } }
      | undefined;
    const ownId = state?.config?.configurable?.checkpoint_id;
    const current = await checkpointStore.checkpointer.get({
      configurable: { thread_id: threadId },
    });
    if (
      typeof ownId === "string" &&
      current !== undefined &&
      current !== null &&
      typeof current.id === "string" &&
      ownId !== current.id
    ) {
      console.warn(
        `chat: thread ${threadId}: checkpoint advanced past our stream's write ` +
          `(${ownId} -> ${current.id}); another writer interleaved ` +
          "(in-process writers are serialized by the shared thread lock)",
      );
    }
  } catch {
    // Best-effort; never fail a completed stream over the diagnostic check.
  }
}

/** Short human-readable intent for the ledger spec (last user message text). */
function intentSpec(rawMessages: unknown[]): string {
  const lastUser = lastUserMessage(rawMessages);
  const content = lastUser?.content;
  if (typeof content === "string" && content.trim() !== "") {
    const trimmed = content.trim();
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return "background chat request";
}

/** Pre-stream failures return JSON per §5.1 (never SSE). */
function preStreamError(c: Context, err: unknown): Response {
  if (err instanceof ModelBuildError) {
    if (err.code === "missing_credentials") {
      return c.json({ error: "invalid_credentials" }, 400);
    }
    return c.json({ error: "invalid_request" }, 400);
  }
  console.error("chat: unexpected pre-stream error", err);
  return c.json({ error: "internal" }, 500);
}

type ModelSelection = { modelPluginId: string; requestModel: string | undefined };

/**
 * Resolve the plugin id + optional provider-model override from the body. See
 * the module doc (MODEL SELECTION): `model` is the plugin id; an explicit
 * `model_plugin` lets `model` double as the provider model override. Returns
 * null when neither id is present.
 */
function resolveModelSelection(body: Record<string, unknown>): ModelSelection | null {
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  const modelPlugin =
    typeof body["model_plugin"] === "string" ? body["model_plugin"].trim() : "";
  const modelPluginId = modelPlugin !== "" ? modelPlugin : model;
  if (modelPluginId === "") return null;
  const requestModel = model !== "" && model !== modelPluginId ? model : undefined;
  return { modelPluginId, requestModel };
}

/**
 * Translate OpenAI chat messages into LangChain messages (Phase 3 wave C1).
 * Roles: system -> SystemMessage, user -> HumanMessage, assistant -> AIMessage
 * (with `tool_calls` normalized from the OpenAI shape), tool/function ->
 * ToolMessage (a missing `tool_call_id` gets a stable synthetic id so a
 * legacy `function`-role result never fails construction).
 */
export function toLangChainMessages(messages: unknown[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = raw["role"];
    const content = raw["content"] as string | unknown;
    const toolCallId =
      typeof raw["tool_call_id"] === "string" ? raw["tool_call_id"] : undefined;
    switch (role) {
      case "system":
        out.push(new SystemMessage(content as string));
        break;
      case "user":
        out.push(new HumanMessage(content as string));
        break;
      case "assistant": {
        const toolCalls = normalizeToolCalls(raw["tool_calls"]);
        // Note: `tool_call_id` on assistant messages is informational (LangChain
        // v1's AIMessageFields does not accept it); the graph only needs the
        // content + tool_calls for context.
        out.push(
          new AIMessage({
            content: content as string,
            ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
          }),
        );
        break;
      }
      case "tool":
      case "function":
        out.push(
          new ToolMessage({
            content: content as string,
            tool_call_id: toolCallId ?? `tool_call_${out.length}`,
          }),
        );
        break;
      default:
        break;
    }
  }
  return out;
}

/** The LAST `user` message, for resume mode. */
function lastUserMessage(messages: unknown[]): HumanMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i];
    if (isRecord(raw) && raw["role"] === "user") {
      return new HumanMessage(raw["content"] as string);
    }
  }
  return null;
}

/**
 * Normalize OpenAI-style `tool_calls` (`[{id, type, function:{name,
 * arguments}}]`) to LangChain `{id, name, args, type:"tool_call"}`. Arguments
 * are decoded from the raw-JSON string when possible. `undefined` when absent
 * or empty (an assistant message without tool calls).
 */
function normalizeToolCalls(
  raw: unknown,
): Array<{ id: string; name: string; args: Record<string, any>; type: "tool_call" }> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry, i) => {
    const e = isRecord(entry) ? entry : {};
    const fn = isRecord(e["function"]) ? e["function"] : {};
    const name =
      typeof fn["name"] === "string" && fn["name"] !== ""
        ? fn["name"]
        : typeof e["name"] === "string"
          ? e["name"]
          : "";
    const args = parseToolArgs(fn["arguments"] ?? e["args"]);
    const id = typeof e["id"] === "string" && e["id"] !== "" ? e["id"] : `call_${i}`;
    return { id, name, args, type: "tool_call" as const };
  });
}

/** Decode raw-JSON tool arguments; LangChain wants an object (never a string). */
function parseToolArgs(args: unknown): Record<string, any> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return (args as Record<string, any>) ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}