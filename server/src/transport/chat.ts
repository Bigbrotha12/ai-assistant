import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { requireApiKey, unauthorized } from "../inference.ts";
import { bindPluginTools, mergePluginAndMcpTools } from "../agents/orchestrator.ts";
import { bindMcpServers } from "../agents/mcp.ts";
import { createTrackedExecution, trackModelExecution } from "../agents/execution.ts";
import { isRecord } from "../util.ts";
import { createAgentGraph } from "../agents/graph.ts";
import { compileGraphWithCheckpointer } from "../agents/compile.ts";
import { ToolExecutor } from "../jobs/runner.ts";
import type {
  JobErrorCode,
  JobToolHandler,
  JobRunner,
  RunJobResult,
} from "../jobs/runner.ts";
import type { ThreadLockRegistry } from "../jobs/thread_lock.ts";
import { canRetryTool, getOrCreateTask } from "../credentials/idempotency.ts";
import { admitManagedTurn, inspectManagedTurn, prepareManagedTurn } from "../credentials/managed_admission.ts";
import type { ManagedAdmission } from "../credentials/managed_admission.ts";
import type { CredentialPinHandle, CredentialPinStore } from "../credentials/pins.ts";
import {
  checkpointThreadId,
  redactForCheckpoint,
} from "../checkpoints/store.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import {
  credentialFingerprint,
  extractCredentialsFromBody,
  PluginCredentialError,
  validateCredentials,
} from "../plugins/credential.ts";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { PluginStoreError } from "../plugins/store.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isModelPlugin, isToolPlugin, pluginIdSchema } from "../plugins/types.ts";
import { composeAgentPrompt } from "../agents/skills.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import type { Catalogs, ResolvedAgentDef } from "../catalog/index.ts";
import type { ToolCacheKey, ToolResultCache } from "../middleware/cache.ts";
import type { RateLimiterFn, VerifyApiKeyFn } from "../plugins/routes.ts";
import { BudgetExhaustedError, createBudgetManager } from "../middleware/budget.ts";
import { ContextBudgetError } from "../middleware/context.ts";
import type { WarmupManager } from "../middleware/warmup.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type {
  ContextManager,
} from "../middleware/context.ts";
import { createPerOwnerRateLimiter } from "../middleware/rate_limit.ts";
import type {
  PerOwnerRateLimiter,
  RateLimitResult,
} from "../middleware/rate_limit.ts";
import type { Ledger, TaskRow } from "../ledger.ts";
import { toOpenAiSse } from "./openai.ts";
import { buildModel, ModelBuildError } from "./model.ts";
import type { BuildModelInput } from "./model.ts";

const agentSpecCaps = {
  systemPrompt: env.AGENT_SPEC_MAX_SYSTEM_PROMPT,
  skills: env.AGENT_SPEC_MAX_SKILLS,
  mcps: env.AGENT_SPEC_MAX_MCPS,
  tools: env.AGENT_SPEC_MAX_TOOLS,
};

const customAgentSpecSchema = z.object({
  name: z.string().max(100).optional(),
  description: z.string().max(300).optional(),
  systemPrompt: z.string().max(agentSpecCaps.systemPrompt).optional(),
  skills: z.array(pluginIdSchema).max(agentSpecCaps.skills).optional(),
  mcpServers: z.array(z.object({ name: pluginIdSchema }).strict()).max(agentSpecCaps.mcps).optional(),
  tools: z.array(z.object({
    pluginId: pluginIdSchema,
    required: z.boolean().default(false),
  }).strict()).max(agentSpecCaps.tools).optional(),
  modelRef: pluginIdSchema.optional(),
  inference: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().max(200000).optional(),
    visionCapable: z.boolean().default(false),
  }).strict().optional(),
}).strict();

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
 *   2. per-owner token bucket (`rateLimiter`) -> 429 rate_limited + Retry-After
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
 *   429 rate_limited              per-owner rate limiter rejected (rate_limited)
 *   429 busy                      per-user budget pool full — sync path
 *                                 (concurrent-capacity, retryable)
 *   503 busy                      per-user budget queue full — async path
 *                                 (concurrent-capacity, retryable)
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
  /**
   * Conversation context manager (Phase 4, Wave C). Applies deterministic
   * pair-aware truncation to fresh seeds and best-effort post-turn compaction
   * to resumed threads (see middleware/context.ts). Constructed in index.ts
   * with the shared threadLocks + the checkpoint store's checkpointer.
   */
  contextManager?: ContextManager;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
  /**
   * Per-owner rate limiter (Phase 4, Wave A). Returns a structured
   * `{ allowed, retryAfterSeconds }`; a rejection -> `429 { error:
   * "rate_limited" }` + `Retry-After`. Defaults to a per-owner token bucket
   * (60/min, burst 20; `index.ts` wires the INFERENCE_RATE_LIMIT/BURST env).
   * Takes precedence over the legacy `limiter` seam.
   */
  rateLimiter?: PerOwnerRateLimiter;
  /**
   * LEGACY test seam, superseded by `rateLimiter`. Kept so the existing chat
   * tests (`limiter: () => true | false`) keep passing: when present AND
   * `rateLimiter` is absent it is adapted into the per-owner path (a rejected
   * key reports Retry-After = 1s).
   */
  limiter?: RateLimiterFn;
  /**
   * Per-user concurrency budget (Phase 4, Wave A): caps in-flight sync streams
   * + background jobs per owner through one shared pool. Pool full (sync) ->
   * `429 { error: "busy" }` + `Retry-After`; queue full (async) -> `503
   * { error: "busy" }` + `Retry-After`. Defaults to `createBudgetManager()`
   * (2 concurrent, queue 3); `index.ts` wires env BUDGET_MAX_CONCURRENT /
   * BUDGET_QUEUE_MAX.
   */
  budget?: BudgetManager;
  /** Test seam; defaults to the real model builder (transport/model.ts). */
  buildModel?: typeof buildModel;
  /**
   * Test seam for the sync path's tool handler. Defaults to the real
   * `ToolExecutor` (validatedFetch + pinned IPs + trusted hosts). When
   * supplied, the transport still injects each call's per-plugin credentials
   * (H2) so a fake can assert them.
   */
  toolHandler?: JobToolHandler;
  warmups?: WarmupManager;
  /**
   * Shared in-memory tool-result cache (Phase 4, Wave B). Wraps the sync tool
   * handler so a repeated READ-ONLY tool call — same (owner, pluginId,
   * pluginVersion, credentialFingerprint, tool, argsHash) — is served without
   * re-executing the backend. Mutating tools are never cached. The cache
   * stores raw handler output; this transport redacts at serve time with
   * `redactForCheckpoint` (idempotent), the same discipline the runner uses.
   * Construct ONE instance in index.ts and share it with the job runner so a
   * sync stream and a background job dedupe against the same cache.
   */
  toolCache?: ToolResultCache;
  /** Admin-trusted hosts for every outbound `validatedFetch` (model + tools). */
  trustedHosts?: readonly string[];
  /** Agent template catalog (plumbing for Step 6 agent override resolution). */
  catalogs?: Catalogs;
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

type StreamExecution = ReturnType<typeof createStreamExecution>;

function createStreamExecution(requestSignal: AbortSignal) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, requestSignal]);
  const execution = createTrackedExecution(signal);
  return {
    ...execution,
    abort: () => controller.abort(),
  };
}

/** The compiled agent graph the sync path streams (createAgentGraph's type). */
type AgentGraph = ReturnType<typeof createAgentGraph>;

export function createChatRoutes(opts: ChatRoutesOptions): Hono {
  const verifyKey = opts.verifyKey ?? requireApiKey;
  // Phase 4 Wave A: the per-owner rate limiter replaces the old boolean gate.
  // The legacy `limiter` seam is preserved for existing tests; an explicit
  // `rateLimiter` wins, otherwise `limiter` is adapted into the per-owner
  // path, otherwise a default per-owner bucket (60/min, burst 20) is built.
  let rateLimiter: PerOwnerRateLimiter;
  if (opts.rateLimiter) {
    rateLimiter = opts.rateLimiter;
  } else if (opts.limiter) {
    const legacy = opts.limiter;
    rateLimiter = {
      check(owner: string): RateLimitResult {
        return { allowed: legacy(owner), retryAfterSeconds: 1 };
      },
    };
  } else {
    rateLimiter = createPerOwnerRateLimiter();
  }
  const budget = opts.budget ?? createBudgetManager();

  const routes = new Hono();

  // Bounds the request body BEFORE it is buffered by `c.req.json()`. An
  // oversized POST (no Content-Length, chunked) would otherwise stall the
  // event loop and inflate memory for every user. 413 request_too_large.
  routes.use(
    bodyLimit({
      maxSize: env.MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );

  routes.post("/chat/completions", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const rate = rateLimiter.check(owner);
    if (!rate.allowed) {
      const res = c.json({ error: "rate_limited" }, 429);
      res.headers.set("retry-after", String(rate.retryAfterSeconds));
      return res;
    }

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
      return handleBackground(c, owner, body, opts, budget);
    }
    return handleSyncStream(c, owner, body, opts, budget);
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
  /** Per-tool-plugin validated credentials from `body.credentials` (H2). */
  toolCredentialsByPlugin: Record<string, Record<string, string>>;
  rawMessages: unknown[];
  requestParameters: Record<string, unknown>;
  clientThreadId: string | undefined;
  managed: boolean;
  managedMessageId: string | undefined;
  enabledPlugins: string[] | undefined;
  agentOverride?: {
    systemPrompt: string;
    toolGrants?: { pluginId: string; required: boolean }[];
    inference?: { temperature?: number; maxTokens?: number; visionCapable?: boolean };
    mcpServers?: { name: string; url: string; headers?: Record<string, string> }[];
  };
};

/**
 * Extract + validate a model plugin's credentials from the request body. The
 * sync and async paths, and the post-agent-override re-resolution, all share
 * this so credential sourcing never diverges. Model plugins also let the
 * non-secret `baseUrlEntry` routing field through (it selects a base-URL
 * instance from the plugin's allowlisted `baseUrls`); it rides the validated
 * credentials so buildModel can resolve it against the allowlist.
 */
function resolveModelCredentials(
  c: Context,
  body: Record<string, unknown>,
  modelPluginId: string,
  plugin: ModelPluginDefinition,
): { ok: true; credentials: Record<string, string> } | { ok: false; response: Response } {
  try {
    const input = extractCredentialsFromBody(body, modelPluginId, plugin.credentials, {
      isModel: true,
    });
    const credentials = validateCredentials(plugin.credentials, input, modelPluginId, {
      isModel: true,
    });
    return { ok: true, credentials };
  } catch (err) {
    if (err instanceof PluginCredentialError) {
      return { ok: false, response: c.json({ error: "invalid_credentials" }, 400) };
    }
    return { ok: false, response: c.json({ error: "internal" }, 500) };
  }
}

export function resolveChatRequest(
  c: Context,
  body: Record<string, unknown>,
  registry: PluginRegistry,
  catalogs: Catalogs,
): { ok: true; value: ResolvedChat } | { ok: false; response: Response } {
  const selection = resolveModelSelection(body);
  if (!selection) return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
  let { modelPluginId, requestModel } = selection;

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

  const resolvedCredentials = resolveModelCredentials(c, body, modelPluginId, plugin);
  if (!resolvedCredentials.ok) return resolvedCredentials;
  let credentials = resolvedCredentials.credentials;

  // H2: extract + validate every TOOL plugin credential the request carries.
  // Missing credentials for a tool plugin do NOT fail the request — the model
  // may never call that tool — so only what is supplied is validated, and only
  // what passes is forwarded to the sync ToolExecutor. An explicitly supplied
  // but invalid value (e.g. a whitespace-only required key) is rejected the
  // same way as the async path's `pinToolPlugins`.
  let toolCredentialsByPlugin: Record<string, Record<string, string>>;
  try {
    toolCredentialsByPlugin = collectToolCredentials(body, registry);
  } catch (err) {
    if (err instanceof PluginCredentialError) {
      return { ok: false, response: c.json({ error: "invalid_credentials" }, 400) };
    }
    return { ok: false, response: c.json({ error: "internal" }, 500) };
  }

  const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];

  // Managed mode is an explicit, opt-in contract (Phase 5 remediation). It
  // requires a messageId (the idempotency key), MAY carry thread_id, and
  // always requires a checkpoint store: a managed run is never stateless, so
  // a degraded boot is a 503, not a silent stateless fallback.
  const conversationMode = body["conversation_mode"];
  let managed = false;
  let managedMessageId: string | undefined;
  if (conversationMode !== undefined) {
    if (conversationMode !== "managed") {
      return {
        ok: false,
        response: c.json(
          { error: "invalid_request", message: "conversation_mode must be 'managed'" },
          400,
        ),
      };
    }
    managed = true;
    const rawMessageId = typeof body["messageId"] === "string" ? body["messageId"].trim() : "";
    if (rawMessageId === "") {
      return {
        ok: false,
        response: c.json(
          { error: "invalid_request", message: "messageId required for managed conversations" },
          400,
        ),
      };
    }
    managedMessageId = rawMessageId;
  }
  if (rawMessages.length === 0) {
    return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
  }

  // L7: reject roles outside the wire contract instead of silently converting
  // them to zero LangChain messages (an unknown role must be a 400, not a
  // degenerate empty run). Non-record entries are equally unusable.
  for (const raw of rawMessages) {
    if (!isRecord(raw)) {
      return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
    }
    const role = raw["role"];
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return { ok: false, response: c.json({ error: "invalid_request" }, 400) };
    }
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

  // Per-user tool selection (explicit opt-in). `enabled_plugins` present ->
  // bind ONLY the listed installed tool plugins; absent -> legacy behavior
  // (every installed tool plugin is bound). Credentials for an enabled plugin
  // that happen to be missing do NOT disable it (the model may never call the
  // tool; an explicitly invalid value is still a 400 below).
  let enabledPlugins: string[] | undefined;
  const rawEnabled = body["enabled_plugins"];
  if (rawEnabled !== undefined) {
    if (
      !Array.isArray(rawEnabled) ||
      rawEnabled.some((id) => typeof id !== "string" || id.trim() === "")
    ) {
      return {
        ok: false,
        response: c.json(
          { error: "invalid_request", message: "enabled_plugins must be an array of plugin ids" },
          400,
        ),
      };
    }
    enabledPlugins = [...new Set(rawEnabled.map((id) => String(id).trim()))];
  }

  // Agent resolution: body.agent = string (template id) | object (custom spec)
  let agentOverride: ResolvedChat["agentOverride"] = undefined;
  const rawAgent = body["agent"];
  if (rawAgent !== undefined) {
    let resolvedAgentDef: ResolvedAgentDef;

    if (typeof rawAgent === "string") {
      // Template reference
      const templateId = rawAgent.trim();
      if (templateId === "") {
        return { ok: false, response: c.json({ error: "invalid_request", message: "agent template id must not be empty" }, 400) };
      }
      const template = catalogs.agents.find(a => a.id === templateId);
      if (!template) {
        return { ok: false, response: c.json({ error: "invalid_request", message: `template_not_found: ${templateId}` }, 400) };
      }
      resolvedAgentDef = template;
    } else if (typeof rawAgent === "object" && rawAgent !== null && !Array.isArray(rawAgent)) {
      // Custom spec — validate with strict schema
      const parseResult = customAgentSpecSchema.safeParse(rawAgent);
      if (!parseResult.success) {
        return { ok: false, response: c.json({ error: "invalid_request", message: `invalid agent spec: ${parseResult.error.issues.map(i => i.message).join("; ")}` }, 400) };
      }
      const spec = parseResult.data;

      // Resolve skills: ids → content from catalog
      const resolvedSkills: { id: string; title: string; content: string }[] = [];
      for (const skillId of spec.skills ?? []) {
        const entry = catalogs.skills.find(s => s.id === skillId);
        if (entry) {
          resolvedSkills.push({ id: entry.id, title: entry.title, content: entry.content });
        } else {
          logger.warn(`[chat] custom agent: skill '${skillId}' not found in catalog; skipping`);
        }
      }

      // Resolve MCP servers: names → url/headers from catalog
      const resolvedMcp: { name: string; url: string; headers?: Record<string, string> }[] = [];
      for (const mcpRef of spec.mcpServers ?? []) {
        const entry = catalogs.mcps.find(m => m.name === mcpRef.name);
        if (entry) {
          resolvedMcp.push({ name: entry.name, url: entry.url, headers: entry.headers });
        } else {
          logger.warn(`[chat] custom agent: MCP server '${mcpRef.name}' not found in catalog; skipping`);
        }
      }

      // Resolve tools: validate installed + credentials
      let resolvedTools: { pluginId: string; required: boolean }[] | undefined;
      if (spec.tools !== undefined) {
        resolvedTools = [];
        for (const grant of spec.tools) {
          try {
            const plugin = registry.requirePlugin(grant.pluginId);
            if (!isToolPlugin(plugin)) {
              if (grant.required) {
                return { ok: false, response: c.json({ error: "invalid_credentials", message: `tool '${grant.pluginId}' is not a tool plugin` }, 400) };
              }
              logger.warn(`[chat] custom agent: '${grant.pluginId}' is not a tool plugin; skipping`);
              continue;
            }
            resolvedTools.push(grant);
          } catch (e) {
            if (e instanceof PluginRegistryError || e instanceof PluginStoreError) {
              if (grant.required) {
                return { ok: false, response: c.json({ error: "invalid_credentials", message: `tool '${grant.pluginId}' not installed or unavailable` }, 400) };
              }
              logger.warn(`[chat] custom agent: tool '${grant.pluginId}' not installed; skipping`);
              continue;
            }
            throw e;
          }
        }
      }

      resolvedAgentDef = {
        id: spec.modelRef ?? "custom",
        name: spec.name ?? "Custom Agent",
        description: spec.description ?? "",
        systemPrompt: spec.systemPrompt,
        skills: resolvedSkills,
        mcpServers: resolvedMcp,
        tools: resolvedTools,
        modelRef: spec.modelRef,
        inference: spec.inference,
      };
    } else {
      return { ok: false, response: c.json({ error: "invalid_request", message: "agent must be a string (template id) or an object (custom spec)" }, 400) };
    }

    // Override model if agent has modelRef
    if (resolvedAgentDef.modelRef) {
      modelPluginId = resolvedAgentDef.modelRef;
      requestModel = undefined;
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

      // Re-resolve credentials for the new model plugin
      const reResolved = resolveModelCredentials(c, body, modelPluginId, plugin);
      if (!reResolved.ok) return reResolved;
      credentials = reResolved.credentials;
    }

    // Merge inference overrides
    if (resolvedAgentDef.inference) {
      if (resolvedAgentDef.inference.temperature !== undefined) {
        requestParameters["temperature"] = resolvedAgentDef.inference.temperature;
      }
      if (resolvedAgentDef.inference.maxTokens !== undefined) {
        requestParameters["maxTokens"] = resolvedAgentDef.inference.maxTokens;
      }
      if (resolvedAgentDef.inference.visionCapable !== undefined) {
        requestParameters["visionCapable"] = resolvedAgentDef.inference.visionCapable;
      }
    }

    // Tool scoping: agent grants override enabledPlugins exclusively
    if (resolvedAgentDef.tools && resolvedAgentDef.tools.length > 0) {
      enabledPlugins = [...new Set(resolvedAgentDef.tools.map((t) => t.pluginId))];

      // Validate required tool grants have credentials
      for (const grant of resolvedAgentDef.tools) {
        if (!grant.required) continue;
        const plugin = registry.requirePlugin(grant.pluginId);
        if (!isToolPlugin(plugin)) continue;
        const spec = plugin.credentials;
        if (spec?.apiKey?.required) {
          const input = extractCredentialsFromBody(body, grant.pluginId, spec, { isModel: false });
          try {
            validateCredentials(spec, input, grant.pluginId, { isModel: false });
          } catch {
            return { ok: false, response: c.json({
              error: "invalid_credentials",
              message: `required tool '${grant.pluginId}' is missing credentials`,
            }, 400) };
          }
        }
      }
    } else if (resolvedAgentDef.tools !== undefined) {
      // Empty tools array = no tool plugins allowed (explicit exclusion)
      enabledPlugins = [];
    }
    // If tools is absent/undefined on the spec (or for template without tools),
    // do NOT override enabledPlugins (keep user's selections)

    // Compose system prompt
    const systemPrompt = composeAgentPrompt(
      resolvedAgentDef.systemPrompt ?? "",
      resolvedAgentDef.skills,
      env.AGENT_SKILL_BUDGET_TOKENS,
    );

    agentOverride = {
      systemPrompt,
      toolGrants: resolvedAgentDef.tools,
      inference: resolvedAgentDef.inference,
      mcpServers: resolvedAgentDef.mcpServers,
    };
  }

  return {
    ok: true,
    value: {
      modelPluginId,
      requestModel,
      plugin,
      credentials,
      toolCredentialsByPlugin,
      rawMessages,
      requestParameters,
      clientThreadId,
      managed,
      managedMessageId,
      enabledPlugins,
      agentOverride,
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
  budget: BudgetManager,
): Promise<Response> {
  const resolved = resolveChatRequest(c, body, opts.registry, opts.catalogs ?? { skills: [], mcps: [], agents: [] });
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
  const { managed, managedMessageId } = resolved.value;
  // Managed mode is fail-closed: without a checkpoint store there is no
  // durable conversation to seed or resume, so the request is a 503 rather
  // than a silent stateless run.
  if (managed && (!checkpointStore || !opts.ledger || !opts.threadLocks)) {
    return c.json(
      { error: "managed_unavailable", message: "managed conversations require the checkpoint store" },
      503,
    );
  }
  // Effective client thread id: managed mode generates a public UUID when the
  // client did not supply one, so the response can always name the thread.
  let managedTask: TaskRow | undefined;
  if (managed) {
    const existing = opts.ledger!.getTaskByIntentKey(owner, managedMessageId!);
    const publicId = existing?.worker ?? clientThreadId;
    if (publicId && checkpointStore!.isDeleted?.(checkpointThreadId(owner, publicId))) {
      return deletedThreadResponse(c, publicId);
    }
    managedTask = await prepareManagedTurn(opts.ledger!, {
      owner, messageId: managedMessageId!, spec: intentSpec(rawMessages), clientThreadId,
    });
    const duplicate = inspectManagedTurn(managedTask, clientThreadId);
    if (duplicate) return managedDuplicateResponse(c, duplicate);
  }
  const effectiveClientThreadId = managedTask?.worker ?? clientThreadId;
  const threadId =
    effectiveClientThreadId !== undefined && checkpointStore
      ? checkpointThreadId(owner, effectiveClientThreadId)
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

  const toolHandler =
    opts.toolHandler ??
    new ToolExecutor({
      registry: opts.registry,
      getPinnedIps: opts.pluginStore.getPinnedIps.bind(opts.pluginStore),
      trustedHosts: opts.trustedHosts,
    });
  // H2: inject each tool call's per-plugin credentials (mirrors the async
  // path's `bindJobTools` threading) so a tool backend that requires auth
  // receives the client's key on the SYNC path too.
  const toolCredentialsByPlugin = resolved.value.toolCredentialsByPlugin;
  // Phase 4, Wave B: wrap the sync handler with the shared tool-result cache.
  // Resolution failures degrade to a direct (uncached) execute — the cache is
  // the tolerant fast path, never an error source on the stream.
  const cachedHandler = withToolResultCache({
    registry: opts.registry,
    owner,
    cache: opts.toolCache,
    handler: toolHandler,
  });
  const execution = createStreamExecution(c.req.raw.signal);
  trackModelExecution(model, execution);
  const pluginTools = bindPluginTools(opts.registry, {
    async execute(pluginId, toolName, args) {
      execution.signal.throwIfAborted();
      return execution.track(async () => {
        const result = await cachedHandler.execute(
          pluginId,
          toolName,
          args,
          toolCredentialsByPlugin[pluginId],
          execution.signal,
        );
        execution.signal.throwIfAborted();
        return result;
      });
    },
  }, resolved.value.enabledPlugins);
  const mcpBinding = resolved.value.agentOverride?.mcpServers
    ? await bindMcpServers(resolved.value.agentOverride.mcpServers, {
        signal: execution.signal,
        trustedHosts: env.MCP_TRUSTED_HOSTS,
      })
    : undefined;
  // The MCP binding owns live SSE connections + pinned Agents until the stream
  // takes ownership (buildStreamResponse) or this function exits. Every early
  // return between here and stream handoff MUST dispose it: a rejected request
  // would otherwise leak one connection + pinned Agent per retry (a replayed
  // duplicate messageId leaks one per 409). Ownership transfers to the SSE
  // stream right before buildStreamResponse; the `finally` disposes anything
  // not handed off.
  let mcpHandedOff = false;
  let mcpDisposed = false;
  const disposeMcp = async (): Promise<void> => {
    if (!mcpBinding || mcpDisposed) return;
    mcpDisposed = true;
    try {
      await mcpBinding.dispose();
    } catch (err) {
      console.warn("chat: MCP binding dispose failed", err);
    }
  };
  try {
    const mcpTools = mcpBinding?.tools ?? [];
    const tools = mergePluginAndMcpTools(pluginTools, mcpTools, "[chat]");
    const base = createAgentGraph({
      model,
      tools,
      systemPrompt: resolved.value.agentOverride?.systemPrompt,
      prepareMessages: opts.contextManager?.prepareMessages,
      beforeModelCall: () => {
        execution.signal.throwIfAborted();
        budget.beforeModelCall(owner, "sync");
      },
    });
  // H1: compile with the checkpointer ONLY for a threaded (checkpointed) run.
  // A stateless run (no `thread_id`) streams WITHOUT `configurable.thread_id`;
  // running that through a checkpointer would throw `Missing "thread_id"` on
  // the first super-step write and surface as a server_error after partial
  // content — exactly the crash a normally-configured gateway (checkpoints
  // enabled) hit for every stateless request.
  const graph =
    threadId !== undefined && checkpointStore
      ? compileGraphWithCheckpointer(base, checkpointStore.checkpointer)
      : base;
  const modelId = requestModel ?? plugin.inference.defaultModel;

  const lock = opts.threadLocks;
  const lockable =
    threadId !== undefined && checkpointStore !== undefined && lock !== undefined;

  if (lockable) {
    // Managed mode: admit the turn against the shared ledger BEFORE the
    // seed/resume read, so a retried (owner, messageId) can never run twice.
    // The admission happens INSIDE the thread lock, so two concurrent sends
    // on the same thread serialize before either reads the checkpoint.
    let managedAdmission: ManagedAdmission | undefined;
    let stopHeartbeat: (() => void) | undefined;
    // Phase 4 Wave A: the per-user budget slot is reserved AFTER the thread
    // lock is acquired. Reserving before the acquire would let a request
    // parked on a busy thread (a long stream or a hung tool backend) hold a
    // budget slot while waiting, so one slow thread could starve every other
    // thread for the owner. A full pool still rejects with 429 — just after
    // the (bounded) lock wait instead of before it.
    const release = await lock.acquire(threadId);
    const reservation = budget.reserveSync(owner);
    if (!reservation.ok) {
      release();
      return busy(c, 429, reservation.retryAfterSeconds);
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      stopHeartbeat?.();
      release();
      reservation.release();
    };
    try {
      execution.signal.throwIfAborted();
      if (managedTask) {
        if (checkpointStore.isDeleted?.(threadId)) {
          releaseOnce();
          return deletedThreadResponse(c, effectiveClientThreadId!);
        }
        const duplicate = inspectManagedTurn(opts.ledger!.getTask(managedTask.id, owner)!, clientThreadId);
        if (duplicate) {
          releaseOnce();
          return managedDuplicateResponse(c, duplicate);
        }
      }
      const { input, streamOptions, state } = await computeThreadInput(
        checkpointStore,
        threadId,
        rawMessages,
        opts.contextManager,
      );
      checkpointStore.touchThread(
        owner,
        threadId,
        null,
        managed ? effectiveClientThreadId! : undefined,
      );      // Wave C: alongside the existing post-stream checkpoint-diagnostics
      // check, run best-effort compaction when a context manager is wired.
      // verifyCheckpointUnmoved runs inline (it catches internally); the
      // compaction call is a sibling — both run INSIDE the held lock (before
      // releaseOnce in the stream's finally), so the lockHeld: true flag
      // prevents the compactor from re-acquiring (AsyncMutex is not reentrant).
      const afterStream = async (): Promise<void> => {
        await verifyCheckpointUnmoved(checkpointStore, threadId, graph);
        await opts.contextManager?.maybeCompactAfterStream({
          owner,
          clientThreadId: clientThreadId!,
          threadId,
          graph,
          lockHeld: true,
        });
      };
      execution.signal.throwIfAborted();
      if (managedTask) {
        const admission = admitManagedTurn(opts.ledger!, managedTask);
        if (admission.kind !== "admitted") {
          releaseOnce();
          return managedDuplicateResponse(c, admission);
        }
        managedAdmission = admission;
        stopHeartbeat = opts.ledger!.startHeartbeat(admission.task.id, owner, admission.task.fence_token, {
          onError: () => execution.abort(),
        }).stop;
      }
      execution.signal.throwIfAborted();
      scheduleWarmups(opts, owner, toolCredentialsByPlugin);
      mcpHandedOff = true;
      const stream = buildStreamResponse(
        graph,
        input,
        streamOptions,
        modelId,
        execution,
        releaseOnce,
        afterStream,
        managedAdmission ? (outcome) => {
          opts.ledger!.completeTask(managedAdmission!.task.id, owner, outcome, managedAdmission!.task.fence_token);
        } : undefined,
        disposeMcp,
      );
      if (managed) {
        stream.headers.set("x-thread-id", effectiveClientThreadId!);
        stream.headers.set(
          "x-conversation-state",
          state === "resumed" ? "resumed" : state === "recreated" ? "recreated" : "seeded",
        );
      }
      return stream;
    } catch (err) {
      releaseOnce();
      if (isResumeConflict(err)) {
        return c.json({ error: "resume_conflict", message: "resume with a user message only" }, 409);
      }
      if (isReseedRequired(err)) {
        return c.json({ error: "reseed_required", reason: "checkpoint_missing", threadId }, 409);
      }
      return preStreamError(c, err);
    }
  }

  // Managed mode REQUIRES the serialized path (dedupe + seed/resume under the
  // shared lock). Without thread locks the run cannot honor the contract, so
  // it is a 503 — never a silent lock-free managed run.
  if (managed) {
    return c.json(
      { error: "managed_unavailable", message: "managed conversations require the shared thread locks" },
      503,
    );
  }

  // Stateless, or no shared lock wired (existing C1 behavior): no per-thread
  // serialization beyond the checkpointer itself.
  let input: Record<string, unknown>;
  let streamOptions: StreamOptions;
  let afterStream: (() => Promise<void>) | undefined;
  if (threadId !== undefined && checkpointStore) {
    try {
      const computed = await computeThreadInput(
        checkpointStore,
        threadId,
        rawMessages,
        opts.contextManager,
      );
      input = computed.input;
      streamOptions = computed.streamOptions;
    } catch (err) {
      if (isResumeConflict(err)) {
        return c.json({ error: "resume_conflict", message: "resume with a user message only" }, 409);
      }
      if (isReseedRequired(err)) {
        return c.json({ error: "reseed_required", reason: "checkpoint_missing", threadId }, 409);
      }
      return preStreamError(c, err);
    }
    checkpointStore.touchThread(owner, threadId);
    // Phase 4 Wave C: wire compaction onto the non-lockable threaded branch.
    // No ThreadLockRegistry is available here, so maybeCompactAfterStream
    // acquires the thread lock internally (if threadLocks is present via the
    // context manager) or runs lock-free.
    afterStream = (): Promise<void> =>
      opts.contextManager?.maybeCompactAfterStream({
        owner,
        clientThreadId: clientThreadId!,
        threadId,
        graph,
      }) ?? Promise.resolve();
  } else {
    // Stateless (no thread_id or no checkpoint store): apply pair-aware
    // truncation to a fresh seed so an oversized client history never
    // overflows the model context. Truncation is pure (no checkpointer).
    try {
      const msgs = toLangChainMessages(rawMessages);
      input = { messages: opts.contextManager?.truncateSeed(msgs) ?? msgs };
      streamOptions = { version: "v2" };
    } catch (err) {
      return preStreamError(c, err);
    }
  }
  // Phase 4 Wave A: reserve the per-user slot at stream admission — after
  // every pre-stream validation, so a rejected request never holds a slot —
  // and release it on stream end / client cancel (via buildStreamResponse's
  // `onRelease`). The reserve/release wrapper releases BEFORE rethrowing if
  // stream construction throws, so a construction failure can never leak a
  // reservation.
  const reservation = budget.reserveSync(owner);
  if (!reservation.ok) {
    return busy(c, 429, reservation.retryAfterSeconds);
  }
  try {
    scheduleWarmups(opts, owner, toolCredentialsByPlugin);
    mcpHandedOff = true;
    return buildStreamResponse(
      graph,
      input,
      streamOptions,
      modelId,
      execution,
      reservation.release,
      afterStream,
      undefined,
      disposeMcp,
    );
  } catch (err) {
    reservation.release();
    throw err;
  }
  } finally {
    if (!mcpHandedOff) await disposeMcp();
  }
}

/**
 * Phase 4, Wave B (sync seam): wrap a `ToolCallHandler` with the shared
 * in-memory tool-result cache. A READ-ONLY tool call whose
 * `(owner, pluginId, pluginVersion, credentialFingerprint, tool, argsHash)`
 * matches a live cache entry is served WITHOUT re-executing the backend;
 * every other call executes and (for read-only tools) is cached. Mutating
 * tools — gated by `canRetryTool`, the same predicate that guards checkpoint
 * resume — always execute and are never cached.
 *
 * The wrapper is deliberately tolerant: when the plugin/tool cannot be
 * resolved (plugin uninstalled mid-stream, unknown tool name) the call
 * executes directly and is not cached — the cache never throws into the SSE
 * stream. Plugin resolution is memoized PER REQUEST (one handler per stream),
 * so the registry is not re-read for every tool invocation.
 *
 * The cache stores the RAW handler output; both hits and misses are redacted
 * here with `redactForCheckpoint` (idempotent) before the result reaches the
 * graph, matching the async runner's discipline.
 */
function withToolResultCache(opts: {
  registry: PluginRegistry;
  owner: string;
  cache?: ToolResultCache;
  handler: JobToolHandler;
}): JobToolHandler {
  const { registry, owner, cache, handler } = opts;
  if (!cache) return handler;

  type ToolCallMeta = { readOnly: boolean; version: string };
  // Per-request memo: pluginId + toolName -> meta, or null when unresolvable.
  const resolved = new Map<string, ToolCallMeta | null>();

  return {
    async execute(pluginId, toolName, args, credentials?, signal?) {
      signal?.throwIfAborted();
      const lookup = `${pluginId}\u0000${toolName}`;
      let meta: ToolCallMeta | null | undefined = resolved.get(lookup);
      if (meta === undefined) {
        meta = null;
        try {
          const plugin = registry.requirePlugin(pluginId);
          if (isToolPlugin(plugin)) {
            const toolDef = plugin.tools.find((t) => t.name === toolName);
            if (toolDef) meta = { readOnly: toolDef.readOnly, version: plugin.version };
          }
        } catch {
          meta = null; // unresolvable -> execute directly, never cache
        }
        resolved.set(lookup, meta);
      }
      const direct = () => handler.execute(pluginId, toolName, args, credentials, signal);
      if (meta === null || !canRetryTool({ readOnly: meta.readOnly })) {
        return direct();
      }
      const key: ToolCacheKey = {
        owner,
        pluginId,
        pluginVersion: meta.version,
        credentialFingerprint: credentialFingerprint((credentials ?? {}) as Record<string, string>),
        tool: toolName,
        argsHash: cache.argsHash(args),
      };
      const hit = cache.get(key);
      if (hit !== undefined) return redactForCheckpoint(hit);
      const result = String(await direct());
      signal?.throwIfAborted();
      cache.set(key, result);
      return redactForCheckpoint(result);
    },
  };
}

/**
 * Wrap a managed stream's lifecycle against the ledger: the admission is
 * claimed synchronously, so the transport (not the runner) completes the task
 * on stream success and fails it on stream error/cancel, using the fence
 * token the claim minted. A cancelled stream completes the task `cancelled`
 * (a later retry with the SAME messageId is a clean already_terminal, not a
 * stuck-resume); an errored stream completes it `failed`. A mid-stream SSE
 * error envelope does NOT abort the HTTP 200, so the ledger follows the
 * stream's honest terminal state.
 */
function deletedThreadResponse(c: Context, threadId: string): Response {
  c.header("x-conversation-state", "reseed_required");
  c.header("cache-control", "no-store");
  return c.json({ error: "reseed_required", reason: "thread_deleted", threadId }, 409);
}

function managedDuplicateResponse(c: Context, admission: ManagedAdmission): Response {
  const { task } = admission;
  if (task.worker) c.header("x-thread-id", task.worker);
  c.header("x-conversation-state", "resumed");
  const identity = { taskId: task.id, threadId: task.worker };
  if (admission.kind === "thread_conflict") {
    return c.json({ error: "message_thread_conflict", ...identity }, 409);
  }
  if (admission.kind === "in_flight") {
    return c.json({ error: "conversation_in_flight", ...identity }, 409);
  }
  return c.json({ status: "already_completed", terminalStatus: task.status, ...identity }, 200);
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
  budget: BudgetManager,
): Promise<Response> {
  const { checkpointStore, jobRunner, ledger, pins } = opts;
  // The async path needs the runner, an owner-scoped ledger to admit against,
  // a checkpointer for the job thread, and the shared pin store.
  if (!checkpointStore || !jobRunner || !ledger || !pins) {
    return c.json({ error: "background_unavailable" }, 503);
  }

  const resolved = resolveChatRequest(c, body, opts.registry, opts.catalogs ?? { skills: [], mcps: [], agents: [] });
  if (!resolved.ok) return resolved.response;
  const {
    modelPluginId,
    requestModel,
    credentials,
    rawMessages,
    requestParameters,
    clientThreadId,
    managed,
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

  // A background send to a deleted thread must fail cleanly with
  // `reseed_required` (mirroring the sync managed path) — never a silent 500
  // when the runner's deferred `touchThread` throws `thread_deleted` mid-job.
  if (checkpointStore.isDeleted?.(threadId)) {
    return deletedThreadResponse(c, clientThread);
  }

  // Snapshot whether this thread was ALREADY known (owner->thread mapping row
  // present) BEFORE this request admits/touches it. The admission-time
  // `touchThread` (below) makes the thread "known" to EVERY later reader, so
  // without this snapshot the job's own deferred `inputFactory` would see a
  // mapping row it just created and mis-report `reseed_required` for a fresh
  // seed. The snapshot is threaded into `computeThreadInput` (which re-reads
  // the CHECKPOINTER live in every case).
  const knownBefore = (await checkpointStore.getThread(threadId)) !== undefined;

  // Idempotent retry (Wave C2 IDEMPOTENCY): a request whose (owner, messageId)
  // already has a ledger task is a re-submit of an admitted job, NOT a fresh
  // seed. De-dupe BEFORE the seed/resume gate: a running task -> 409
  // `conversation_in_flight`, a terminal task -> 200 `already_completed`
  // (mirrors the sync managed path via `inspectManagedTurn` /
  // `managedDuplicateResponse`). A queued task falls through — the runner owns
  // the claim race (in_flight vs. claim) — but its known-mapping/no-checkpoint
  // state must not trip the `reseed_required` gate either (see below).
  const existing = ledger.getTaskByIntentKey(owner, messageId);
  if (existing) {
    const duplicate = inspectManagedTurn(existing, clientThread);
    if (duplicate) return managedDuplicateResponse(c, duplicate);
  }

  // Seed/resume input (mirrors the sync path): a fresh thread gets the client's
  // full history; an existing checkpoint gets only the last user message. M3:
  // a RESUME whose last client message is NOT a user message is a conflict
  // (returning `{ messages: [] }` would re-run the checkpointed state and
  // re-execute a pending tool call), so it is rejected 409 BEFORE any pin or
  // admission — a conflict leaves nothing behind. L5: `touchThread` is
  // deferred until after every validation so a rejected request never writes a
  // phantom thread_owner row.
  try {
    await computeThreadInput(checkpointStore, threadId, rawMessages, opts.contextManager, knownBefore);
  } catch (err) {
    if (isResumeConflict(err)) {
      return c.json({ error: "resume_conflict", message: "resume with a user message only" }, 409);
    }
    // A retry of an admitted (queued/stuck) task legitimately has a mapping
    // row (written by the first admit) with no checkpoint yet — the runner
    // claims/terminates it, so `reseed_required` does not apply here.
    if (isReseedRequired(err)) {
      if (!existing) {
        return c.json({ error: "reseed_required", reason: "checkpoint_missing", threadId }, 409);
      }
    } else {
      return preStreamError(c, err);
    }
  }

  // Validate + pin tool credentials first (atomic: all-or-nothing), then the
  // model credential. Any validation failure -> 400 before admission, and no
  // pin is left behind. `enabled_plugins` (when present) limits BOTH the
  // pinned set and the bound tool set to the selected plugins.
  const pinnedTools = pinToolPlugins(c, body, opts.registry, pins, owner, resolved.value.enabledPlugins);
  if (!pinnedTools.ok) return pinnedTools.response;
  const toolPlugins = pinnedTools.toolPlugins;
  const pinHandles = pinnedTools.pinHandles;
  pinHandles[modelPluginId] = pins.pin(owner, modelPluginId, credentials).handle;

  const releasePins = (): void => {
    for (const [pluginId, handle] of Object.entries(pinHandles)) {
      pins.release(owner, pluginId, handle);
    }
  };

  // Phase 4 Wave A, budget: reserve the per-user slot BEFORE ledger admission
  // and thread marking, so a queue-full 503 leaves no phantom task row or
  // thread_owner row (L5). A queued admission parks in the owner's bounded
  // FIFO queue and waits (up to the budget's waitMs) for a free slot; the pool
  // is shared with sync streams. Releasing after `runJob` returns (ANY result)
  // mirrors the M1 pin-release pattern: a non-claimed duplicate
  // (in_flight / already_terminal) must not hold a reservation either.
  const reservation = await budget.reserveAsync(owner);
  if (!reservation.ok) {
    releasePins();
    return busy(c, 503, reservation.retryAfterSeconds);
  }

  let task: TaskRow;
  try {
    task = await getOrCreateTask(ledger, {
      owner,
      intentKey: messageId,
      spec: intentSpec(rawMessages),
      // M2: persist the RAW client thread id so a restart-loss replay
      // (`resumeStuckJobs`) can resume on the SAME checkpoint thread the
      // original job used instead of re-hashing the intent key onto a
      // different one.
      worker: clientThread,
    });
  } catch (err) {
    console.error("chat: background task admission failed", err);
    releasePins();
    reservation.release();
    return c.json({ error: "internal" }, 500);
  }

  // L5: the owner->thread mapping is recorded only once the job actually runs,
  // inside the inputFactory (RIGHT before the graph invoke, under the thread
  // lock the runner holds). Recording it here at admission would make the
  // thread "known" to every concurrent writer BEFORE any checkpoint exists, so
  // a sync request racing the parked job on the same thread would be rejected
  // as `reseed_required` (a mapping row must never signal "already seeded" —
  // see the module doc). The public id is recorded on managed requests so the
  // thread is listable/recoverable via /v1/threads; a legacy (stateless-
  // threaded) background request keeps a null mapping and stays safely
  // invisible to the public surface.
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
      systemPrompt: resolved.value.agentOverride?.systemPrompt,
      mcpServers: resolved.value.agentOverride?.mcpServers,
      pinHandles,
      inputFactory: async ({ threadId: lockedThreadId, signal }) => {
        signal.throwIfAborted();
        const computed = await computeThreadInput(
          checkpointStore, lockedThreadId, rawMessages, opts.contextManager, knownBefore,
        );
        signal.throwIfAborted();
        checkpointStore.touchThread(owner, lockedThreadId, null, managed ? clientThread : undefined);
        return computed.input;
      },
    });
  } catch (err) {
    console.error("chat: background runJob threw", err);
    // The runner releases pins in its own finally for the claimed path; a
    // throw before claim (ledger edge) leaves them — release here as a safety
    // net so an unexpected throw never leaks pins until the next sweep.
    releasePins();
    reservation.release();
    return c.json({ error: "internal" }, 500);
  }

  if (result.status === "in_flight" || result.status === "already_terminal") releasePins();
  reservation.release();
  if (result.status === "succeeded") {
    scheduleWarmups(opts, owner, resolved.value.toolCredentialsByPlugin);
  }

  return mapRunJobResult(c, result, clientThread);
}

/**
 * Validate + collect every TOOL plugin credential the request supplies (H2).
 * Missing credentials for a tool plugin do NOT fail — the model may never call
 * that tool — so only what the client explicitly provided is validated, and
 * only what passes is returned. Credentials for ids that are not installed
 * tool plugins (e.g. the selected model plugin, or a plugin this gateway does
 * not have) are ignored. An explicitly supplied but INVALID value throws
 * `PluginCredentialError` (a rejected value, unlike a missing one, is a real
 * 400). Shared by `resolveChatRequest` (sync) and `pinToolPlugins` (async) so
 * the two paths never diverge on what is accepted.
 */
function collectToolCredentials(
  body: Record<string, unknown>,
  registry: PluginRegistry,
): Record<string, Record<string, string>> {
  const credentialsField = isRecord(body["credentials"]) ? body["credentials"] : {};
  const validated: Record<string, Record<string, string>> = {};
  for (const pluginId of Object.keys(credentialsField)) {
    let plugin;
    try {
      plugin = registry.requirePlugin(pluginId);
    } catch {
      continue; // unknown / not installed — nothing to validate
    }
    if (!isToolPlugin(plugin)) continue; // model-plugin keys are not tool creds
    const input = extractCredentialsFromBody(body, pluginId, plugin.credentials);
    validated[pluginId] = validateCredentials(plugin.credentials, input, pluginId);
  }
  return validated;
}

/**
 * Validate and PIN every installed TOOL plugin named in `body.credentials`.
 * Validation is all-or-nothing: nothing is pinned until every entry validates,
 * so a rejected request leaves no pin behind.
 */
function pinToolPlugins(
  c: Context,
  body: Record<string, unknown>,
  registry: PluginRegistry,
  pins: CredentialPinStore,
  owner: string,
  enabledPlugins?: readonly string[],
): { ok: true; toolPlugins: string[]; pinHandles: Record<string, CredentialPinHandle> } | { ok: false; response: Response } {
  let validated: Record<string, Record<string, string>>;
  try {
    validated = collectToolCredentials(body, registry);
  } catch (err) {
    if (err instanceof PluginCredentialError) {
      return { ok: false, response: c.json({ error: "invalid_credentials" }, 400) };
    }
    return { ok: false, response: c.json({ error: "internal" }, 500) };
  }
  const selected = enabledPlugins === undefined
    ? Object.keys(validated)
    : Object.keys(validated).filter((pluginId) => enabledPlugins.includes(pluginId));
  const pinHandles: Record<string, CredentialPinHandle> = {};
  for (const pluginId of selected) {
    pinHandles[pluginId] = pins.pin(owner, pluginId, validated[pluginId]!).handle;
  }
  return { ok: true, toolPlugins: selected, pinHandles };
}

/** `JobErrorCode` -> HTTP status for a failed background job. */
const JOB_ERROR_HTTP_STATUS: Record<JobErrorCode, 400 | 401 | 409 | 429 | 502 | 500> = {
  budget_exhausted: 429,
  context_length_exceeded: 400,
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
 *
 * `publicThreadId` is the RAW client thread handle (`clientThreadId ?? messageId`)
 * — the value the client must echo back as `thread_id` to resume. The runner's
 * internal `result.threadId` is the owner-bound hash (`checkpointThreadId`) and
 * would be re-hashed into a different thread on resume, silently orphaning the
 * conversation.
 */
function mapRunJobResult(c: Context, result: RunJobResult, publicThreadId: string): Response {
  switch (result.status) {
    case "in_flight":
      return c.json(
        { status: "accepted", taskId: result.taskId, threadId: publicThreadId },
        202,
      );
    case "succeeded":
      return c.json(
        { status: "succeeded", taskId: result.taskId, threadId: publicThreadId },
        200,
      );
    case "already_terminal":
      return c.json(
        {
          status: result.terminalStatus,
          taskId: result.taskId,
          threadId: publicThreadId,
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

/** Raised when a resumed thread's LAST client message is not a user message. */
class ResumeConflictError extends Error {
  constructor() {
    super("resume requires the last message to be a user message");
    this.name = "ResumeConflictError";
  }
}

function isResumeConflict(err: unknown): boolean {
  return err instanceof ResumeConflictError;
}

/**
 * Raised when a KNOWN thread (owner->thread mapping row present) has no
 * checkpoint AND the client is carrying no prior history to re-seed from.
 * A fresh checkpoint cannot be minted silently without losing prior context,
 * so this forces the explicit `reseed_required` round-trip (409).
 */
class ReseedRequiredError extends Error {
  constructor() {
    super("known thread has no checkpoint and no client history to re-seed from");
    this.name = "ReseedRequiredError";
  }
}

function isReseedRequired(err: unknown): boolean {
  return err instanceof ReseedRequiredError;
}

/**
 * True when the client's LAST message on a resumed thread is a `user` message.
 * A resume whose last message is an assistant/tool message cannot be seeded
 * with a user turn (M3) — see `computeThreadInput`.
 */
function lastMessageIsUser(messages: unknown[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return isRecord(last) && last["role"] === "user";
}

/**
 * True when the client is carrying prior conversation context (more than the
 * single current user turn). Distinguishes a `recreated` re-seed (the client
 * has history to restore) from a `reseed_required` round-trip (no history to
 * restore — a silent fresh checkpoint would drop prior context).
 */
function hasClientHistory(rawMessages: unknown[]): boolean {
  return rawMessages.length > 1;
}

/**
 * The seed/resume input for a thread: a fresh thread gets the client's full
 * history; an existing checkpoint gets ONLY the last user message. Callers
 * record the owner->thread mapping (`touchThread`) AFTER validation so a
 * rejected request leaves no phantom thread_owner row (L5).
 *
 * M3: when a checkpoint EXISTS and the client's last message is NOT a user
 * message, the resume cannot be seeded (returning `{ messages: [] }` would
 * re-run the checkpointed state and re-execute a pending tool call). That is a
 * `ResumeConflictError` (409) rather than silent mis-seeding.
 *
 * No-checkpoint states: a fresh thread (no owner->thread mapping row) seeds
 * from the client's full history ("seeded"). A KNOWN thread whose checkpoint
 * is gone is a recreation: with prior client history it re-seeds ("recreated");
 * without it it must not silently mint an empty checkpoint, so it throws
 * `ReseedRequiredError` (409 "reseed_required") for an explicit round-trip.
 */
async function computeThreadInput(
  checkpointStore: CheckpointStore,
  threadId: string,
  rawMessages: unknown[],
  contextManager?: ContextManager,
  knownBefore?: boolean,
): Promise<{ input: Record<string, unknown>; streamOptions: StreamOptions; state: "seeded" | "resumed" | "recreated" }> {
  const checkpoint = await checkpointStore.checkpointer.get({
    configurable: { thread_id: threadId },
  });
  if (checkpoint) {
    if (!lastMessageIsUser(rawMessages)) {
      throw new ResumeConflictError();
    }
    const lastUser = lastUserMessage(rawMessages);
    return {
      input: { messages: lastUser ? [lastUser] : [] },
      streamOptions: { version: "v2", configurable: { thread_id: threadId } },
      state: "resumed",
    };
  }
  // No checkpoint. A KNOWN thread (owner->thread mapping row present) whose
  // checkpoint is gone is NOT a brand-new seed: it is a recreation. When the
  // client is carrying prior history we re-seed from it (state "recreated");
  // when it is not, we must not silently mint a fresh empty checkpoint, so we
  // force the explicit reseed round-trip (409 "reseed_required") — never
  // silent context loss. A brand-new thread (no mapping row) seeds fresh.
  // Apply pair-aware truncation (contextManager.truncateSeed) so an oversized
  // seed never overflows the model context even when post-turn compaction
  // cannot run (deterministic fallback per the approved plan, Layer 2).
  const msgs = toLangChainMessages(rawMessages);
  const truncated = contextManager?.truncateSeed(msgs) ?? msgs;
  // A caller that admits the thread AFTER validation supplies its pre-admission
  // snapshot (`knownBefore`) so the owner->thread mapping row it writes via
  // `touchThread` cannot retroactively flip this request into a "known thread"
  // (and thus a false `reseed_required`). Only a `true` snapshot short-circuits
  // the live read: a `false` snapshot (mapping absent at admission) falls
  // through to the live read, since a concurrent same-thread writer may have
  // created the mapping row by the time this runs (making the thread known).
  const known = knownBefore === true ? true : await checkpointStore.getThread(threadId);
  if (known) {
    if (!hasClientHistory(rawMessages)) {
      throw new ReseedRequiredError();
    }
    return {
      input: { messages: truncated },
      streamOptions: { version: "v2", configurable: { thread_id: threadId } },
      state: "recreated",
    };
  }
  return {
    input: { messages: truncated },
    streamOptions: { version: "v2", configurable: { thread_id: threadId } },
    state: "seeded",
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
  execution: StreamExecution,
  onRelease?: () => void,
  onAfterStream?: () => void | Promise<void>,
  onOutcome?: (outcome: "succeeded" | "failed" | "cancelled") => void,
  disposeMcp?: () => Promise<void>,
): Response {
  const events = graph.streamEvents(input, { ...streamOptions, signal: execution.signal });
  let streamFailed = false;
  const sse = toOpenAiSse(events, {
    modelId,
    onOutcome: (outcome) => {
      if (outcome === "failed") streamFailed = true;
    },
  });
  const encoder = new TextEncoder();
  let cancelled = false;
  let finalized = false;
  const finalize = () => {
    // Report the stream's honest terminal state exactly once: a mid-stream
    // SSE error frame marks `failed`, a client cancellation / abort marks
    // `cancelled`, anything else that ran to completion is `succeeded`.
    if (finalized) return;
    finalized = true;
    if (cancelled || execution.signal.aborted) {
      onOutcome?.("cancelled");
    } else if (streamFailed) {
      onOutcome?.("failed");
    } else {
      onOutcome?.("succeeded");
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      return (async () => {
        let errored = false;
        try {
          for await (const frame of sse) {
            if (!cancelled && !execution.signal.aborted) controller.enqueue(encoder.encode(frame));
          }
          await execution.settle();
          finalize();
          if (!execution.signal.aborted && onAfterStream) {
            try {
              await onAfterStream();
            } catch {
              console.warn("chat: post-stream checkpoint check failed");
            }
          }
        } catch (err) {
          if (!cancelled && !execution.signal.aborted) {
            errored = true;
            controller.error(err);
          }
        } finally {
          execution.abort();
          await execution.settle();
          finalize();
          onRelease?.();
          // A rejected MCP close must never skip the stream's own termination
          // (truncated/hung SSE on the client).
          try {
            await disposeMcp?.();
          } catch (err) {
            console.warn("chat: MCP binding dispose failed", err);
          }
          if (!cancelled && !errored) controller.close();
        }
      })();
    },
    cancel() {
      cancelled = true;
      execution.abort();
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

/**
 * Phase 4 Wave A budget rejection: `429 { error: "busy" }` (sync — the user's
 * concurrency pool is full) or `503 { error: "busy" }` (async — the background
 * queue is full), always with a `Retry-After` header so the client knows when
 * to retry. Deliberately DISTINCT from `rate_limited`: budget exhaustion is a
 * concurrent-capacity signal, not a token-bucket signal.
 */
function scheduleWarmups(
  opts: ChatRoutesOptions,
  owner: string,
  credentialsByPlugin: Record<string, Record<string, string>>,
): void {
  if (!opts.warmups) return;
  try {
    // Warmable tools are declared in the plugin manifest (`warmupTools`) — the
    // installed set drives what gets pre-warmed instead of a hardcoded list.
    for (const plugin of opts.registry.listInstalledPlugins()) {
      if (!isToolPlugin(plugin)) continue;
      const credentials = credentialsByPlugin[plugin.id];
      if (!credentials) continue;
      for (const toolName of plugin.warmupTools ?? []) {
        const tool = plugin.tools.find((candidate) => candidate.name === toolName);
        if (!tool?.readOnly || tool.inputSchema.required?.length) continue;
        const admission = opts.warmups.schedule({ owner, pluginId: plugin.id, tool: toolName, args: {}, credentials: { ...credentials } });
        if (admission.ok) void admission.done.catch(() => {});
      }
    }
  } catch {
    console.warn("chat: warmup scheduling skipped");
  }
}

function busy(c: Context, status: 429 | 503, retryAfterSeconds: number): Response {
  const res = c.json({ error: "busy" }, status);
  res.headers.set("retry-after", String(retryAfterSeconds));
  return res;
}

/** Pre-stream failures return JSON per §5.1 (never SSE). */
function preStreamError(c: Context, err: unknown): Response {
  if (err instanceof ContextBudgetError) {
    return c.json({ error: err.code, message: err.message }, 400);
  }
  if (err instanceof BudgetExhaustedError) {
    const response = c.json({ error: err.code, message: err.message }, 429);
    response.headers.set("retry-after", String(err.retryAfterSeconds));
    return response;
  }
  if (err instanceof ModelBuildError) {
    if (err.code === "missing_credentials") {
      return c.json({ error: "invalid_credentials" }, 400);
    }
    if (err.code === "unsupported") {
      // A non-streaming model plugin is actionable config, not a malformed
      // request — surface it distinctly instead of folding into invalid_request.
      return c.json({ error: "unsupported", message: err.message }, 400);
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