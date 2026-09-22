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
import type { StreamEvent } from "./openai.ts";

import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { requireApiKey, unauthorized } from "../inference.ts";
import { bindPluginTools, mergePluginAndMcpTools } from "../agents/orchestrator.ts";
import { bindMcpServers } from "../agents/mcp.ts";
import { createTrackedExecution, trackModelExecution } from "../agents/execution.ts";
import { isRecord } from "../util.ts";
import { createAgentGraph } from "../agents/graph.ts";
import { ToolExecutor } from "../jobs/runner.ts";
import type {
  JobErrorCode,
  JobToolHandler,
  JobRunner,
  RunJobResult,
} from "../jobs/runner.ts";
import { canRetryTool, getOrCreateTask } from "../credentials/idempotency.ts";
import { inspectManagedTurn } from "../credentials/managed_admission.ts";
import type { ManagedAdmission } from "../credentials/managed_admission.ts";
import type { CredentialPinHandle, CredentialPinStore } from "../credentials/pins.ts";
import { redactForCheckpoint } from "../checkpoints/store.ts";
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
import { createPerOwnerRateLimiter } from "../middleware/rate_limit.ts";
import type {
  PerOwnerRateLimiter,
  RateLimitResult,
} from "../middleware/rate_limit.ts";
import type { Ledger, TaskRow } from "../ledger.ts";
import { SPEC_MAX_LENGTH } from "../ledger.ts";
import { toOpenAiSse } from "./openai.ts";
import { buildModel, ModelBuildError } from "./model.ts";
import type { BuildModelInput } from "./model.ts";
import type { SessionStore, SessionMissingReason } from "../sessions/store.ts";
import type { AppendDeltaResult, ReestablishResult } from "../sessions/store.ts";

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
 *   6. build the model (`transport/model.ts`) + bind the real `ToolExecutor`,
 *      compile the agent graph WITHOUT a checkpointer (the sync path never
 *      reads or writes a checkpoint)
 *   7. `graph.streamEvents(input, { version: "v2", ... })` piped through
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
 * CONVERSATION IDENTITY (plan §5): `thread_id` is replaced by `session_id` on
 * the sync path. A managed request MUST carry `session_id` (see MANAGED SESSION
 * PATH); a non-managed sync request is STATELESS — the client's `messages` are
 * streamed verbatim and no checkpoint is written. `thread_id` survives ONLY as
 * a worker label on the BACKGROUND path (see ASYNC DELEGATION).
 *
 * SYNC VS ASYNC DECISION RULE (Wave C2):
 *   - `body.background === true` -> ASYNC delegation (below).
 *   - `body.background` absent or `false` -> the synchronous SSE stream.
 *   - any other value -> 400 invalid_request (`background must be a boolean`),
 *     so a malformed flag can never silently run synchronously.
 *
 * ASYNC DELEGATION (Wave C2 / stateless-gateway step 8): a background request:
 *   1. resolves the model plugin + validates credentials (shared with sync);
 *   2. requires `jobRunner` + `ledger` + `pins` -> 503
 *      `{ error: "background_unavailable" }` when the async path is not wired;
 *   3. requires an idempotency key in `body.messageId` (see IDEMPOTENCY) ->
 *      400 invalid_request when missing;
 *   4. builds the SNAPSHOT — the request's `messages` converted to LangChain
 *      messages (same as the stateless sync path) — and ships it to the runner
 *      as `input: { messages: snapshot }`. The job runs on this snapshot, never
 *      a live session/checkpoint; the runner persists it as the ledger payload
 *      for crash-resume (ledger v5);
 *   5. validates + PINS the model-plugin credential and every installed
 *      tool-plugin credential in `body.credentials` -> 400 invalid_credentials
 *      on failure, BEFORE any task is admitted;
 *   6. `getOrCreateTask(ledger, { owner, intentKey: messageId, spec })` —
 *      owner-scoped idempotent admission;
 *   7. `jobRunner.runJob({...})` with the pinned credentials (the runner's
 *      `buildModel` seam resolves the model pin) and the snapshot input;
 *   8. maps the `RunJobResult` to HTTP (see JOB ERROR MAPPING).
 *
 * IDEMPOTENCY: the client generates `body.messageId` ONCE per send and reuses
 * it across retries. The ledger's v4 unique (owner, intent_key) index maps
 * (owner, messageId) to exactly ONE task forever, so a retried send never
 * creates a duplicate job. The status-by-key endpoint
 * (`GET /ledger/tasks/by-key/:messageId`) is the client's poll-after-drop
 * surface; this transport reuses it and does NOT duplicate the logic.
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
 *                                 non-streaming plugin; missing/empty messages;
 *                                 managed request with a malformed session_id;
 *                                 session delta whose last message is not a
 *                                 user message (invalid_request_error)
 *   400 invalid_credentials       missing/invalid model-plugin credentials
 *                                 (auth_error, user-fixable)
 *   409 conversation_in_flight    a managed-session turn with this messageId is
 *                                 already running (session dedupe; §4)
 *   409 session_missing           managed-session session_id is gone — client
 *                                 re-establishes under the SAME session_id;
 *                                 reason is the store's "evicted"|"restart"
 *   413 request_too_large         body exceeds the path's cap: establishes are
 *                                 bounded by MAX_ESTABLISH_BODY_BYTES (route
 *                                 bodyLimit), every other request by
 *                                 MAX_REQUEST_BODY_BYTES (post-read check —
 *                                 see ESTABLISH BODY CAP below)
 *   502 inference_unavailable     plugin registry unavailable (NOT_LOADED)
 *   503 background_unavailable    async path not wired (no runner/store)
 *   500 internal                  anything else (server_error; logged)
 * Mid-stream failures never change the HTTP status: the SSE adapter emits one
 * error envelope then [DONE] (§5.2).
 *
 * MANAGED SESSION PATH (stateless gateway, plan §4/§5): the synchronous managed
 * path is SESSION-ONLY. A managed request (`conversation_mode: "managed"`) MUST
 * carry a non-empty `session_id` (400 invalid_request otherwise) and a
 * `messageId`; it dispatches to `handleManagedSessionStream`, where the
 * in-memory `sessionStore` is the only state. It NEVER touches the ledger, the
 * checkpointer, thread locks, or the per-thread context manager. Exactly-once
 * is the store's per-session `outcomes` map.
 *
 *   - ESTABLISH (a full-history body, i.e. more than one message — first turn,
 *     reseed, or the §6 compaction re-base): the request's messages are the
 *     full history. We seed the history WITHOUT the trailing user turn, then
 *     `store.appendDelta(messageId, lastUserMessage)` so the exactly-once
 *     `outcomes[messageId]` anchor is recorded from the very first turn (a
 *     retried/concurrent establish is deduped, and a failed establish rolls
 *     the user turn back). Graph input = the session's accumulated messages;
 *     `x-conversation-state: seeded`. A compaction re-base is an establish even
 *     against a LIVE session — the server REPLACES `messages` (§6), exactly
 *     what a client-trimmed re-base means (F2).
 *   - SINGLE-MESSAGE ESTABLISH (session MISSING + one message, reason
 *     `"restart"`/fresh): the FIRST TURN of a brand-new managed conversation is
 *     a single-message full history, so it establishes (F1) — seeded the same
 *     way (empty seed + `appendDelta` anchor), `x-conversation-state: seeded`.
 *   - DELTA (session live + a single-message body): the request must end with a
 *     single new user message (400 otherwise). `store.appendDelta(...)` appends
 *     it; graph input = the session's accumulated messages (full context,
 *     R12); `x-conversation-state: resumed`.
 *   - MISSING-SESSION DELTA (session missing + a single-message body whose
 *     store reason is `"evicted"`): a delta-shaped request the store cannot
 *     apply -> 409 `session_missing` with the `"evicted"` reason (the §4
 *     eviction signal; the client re-establishes under the SAME session_id
 *     with a full-history establish). A fresh/`"restart"` single-message body
 *     is NOT this case — it establishes (above).
 *   - appendDelta results -> HTTP: resumed/established -> stream (a retry of a
 *     `failed` messageId also returns `resumed` — a clean re-run per plan §4
 *     step 6 — so it streams normally as a resumed turn); already_completed
 *     -> 200 `{ status, sessionId, messageId }` (no
 *     taskId/terminalStatus/threadId per §5; `x-conversation-state: resumed`);
 *     in_progress -> 409
 *     `conversation_in_flight`; session_missing -> 409 `session_missing` with
 *     the store's reason.
 *   - Reply persistence: on stream success the transport captures the final
 *     assistant message (root `on_chain_end`), appends it to the session under
 *     a synthetic `<messageId>:assistant` id (the store's `appendDelta` is the
 *     only appender; the synthetic id can never collide with a client UUID),
 *     then `store.markCompleted(messageId, reply)`. On failure/cancel it calls
 *     `store.markFailed(messageId)` (rolls the user turn back). The append
 *     precedes the stream (exactly-once dedupe must be atomic at append time),
 *     so every PRE-STREAM failure — a model-build error, an MCP bind rejection,
 *     a budget-busy rejection, or a buildStreamResponse construction error —
 *     ALSO rolls the turn back with `markFailed` (exactly once per failed turn)
 *     before its response is returned/rethrown; a half-appended delta is never
 *     left `in_progress` (plan §4 step 6). Both the reply
 *     append and the marks carry the generation captured at append time, so a
 *     mid-turn eviction + re-seed can never stamp the new incarnation (F4);
 *     the reply append is `evictOnOverflow: false`, so an over-cap reply is
 *     dropped rather than evicting the session (F5). An evicted-mid-turn mark
 *     is logged and ignored (client re-establishes).
 *   - Headers: every session-path response sets `x-session-id`; the stream
 *     sets `x-conversation-state: seeded|resumed`. `recreated` is never
 *     emitted on this path.
 *
 * ESTABLISH BODY CAP (§5/R6): vision establishes carry full history + base64
 * images, so the route-level `bodyLimit` is raised to `MAX_ESTABLISH_BODY_BYTES`
 * (25 MiB default). The establish/delta distinction is only visible from the
 * parsed body (content-length is the only pre-read signal), so non-establish
 * requests are re-bounded AFTER reading: a request that is not an establish
 * (no session_id, a single-message session delta, or a single-message body
 * against a tombstoned/`"evicted"` session) whose content-length
 * exceeds `MAX_REQUEST_BODY_BYTES` is rejected post-read with the SAME 413
 * `request_too_large` shape the bodyLimit middleware emits. An establish is
 * signalled by `conversation_mode: "managed"` + `session_id` + more than one
 * message (full history) OR a single-message body against a missing, non-
 * evicted session (the F1 first turn); a re-sent establish body therefore
 * keeps the higher cap even when the session already exists (the
 * already_completed retry).
 */

export type ChatRoutesOptions = {
  registry: PluginRegistry;
  pluginStore: PluginStore;
  /** Optional — required for async delegation (`getOrCreateTask`). */
  ledger?: Ledger;
  /** Optional — the background job runner (Wave C2 async delegation). */
  jobRunner?: JobRunner;
  /**
   * Credential pin store SHARED with the job runner. Async admission pins the
   * model + tool credentials here; the runner reads them by (owner, pluginId).
   */
  pins?: CredentialPinStore;
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
  /**
   * In-memory session store (plan §4, step 1). Required for the managed-session
   * path (`conversation_mode: "managed"` + `session_id`); a managed-session
   * request with no store is a 503 managed_unavailable (never a silent
   * stateless run). Constructed in index.ts and shared with createSessionRoutes.
   */
  sessionStore?: SessionStore;
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

/**
 * Establish-vs-delta body signal (§5/R6, F1/F2): a request is an establish when
 * it is managed, carries `session_id`, and EITHER has more than one message
 * (full history — a first turn, a reseed, or a compaction re-base, which is an
 * establish regardless of session liveness per F2/§6) OR is a SINGLE-message
 * body against a missing, non-tombstoned session (a brand-new conversation's
 * first turn per F1). The single-message case needs the store to distinguish a
 * fresh session (reason `"restart"`) from a tombstoned/`"evicted"` one (409 —
 * stays under the delta cap so the client re-establishes with a full-history
 * body). A single-message body against a live session is a delta and stays
 * under the tighter cap. A re-sent establish body (the already_completed
 * retry) therefore keeps the higher cap even after the session exists.
 */
function isEstablishBody(
  body: Record<string, unknown>,
  sessionStore?: SessionStore,
  owner?: string,
): boolean {
  const managed = body["conversation_mode"] === "managed";
  const sessionId = typeof body["session_id"] === "string" ? body["session_id"].trim() : "";
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  if (!managed || sessionId === "") return false;
  if (messages.length > 1) return true;
  if (messages.length === 1 && sessionStore && owner) {
    return sessionStore.missingReason(owner, sessionId) === "restart";
  }
  return false;
}

/**
 * Wire bytes of a parsed request body for the post-read establish-cap check:
 * Content-Length when the client sent one (the pre-read signal the route
 * cannot act on — see the module doc), else the serialized size (chunked
 * bodies).
 */
function requestBodyBytes(c: Context, body: Record<string, unknown>): number {
  const raw = c.req.raw.headers.get("content-length");
  if (raw !== null && /^[0-9]+$/.test(raw)) return Number(raw);
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

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
  // Raised to the ESTABLISH cap (§5/R6): vision establishes carry full history
  // + base64 images; non-establish requests are re-bounded post-read below.
  routes.use(
    bodyLimit({
      maxSize: env.MAX_ESTABLISH_BODY_BYTES,
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

    // §5/R6 establish body cap: the route bodyLimit above admits up to the
    // establish cap for EVERY request, so non-establish requests (no
    // session_id, or a single-message session delta) are re-bounded here,
    // post-read, with the same 413 `request_too_large` shape. Content-Length is
    // the wire-bytes signal (the only pre-read signal — the establish/delta
    // distinction is only visible from the parsed body); chunked bodies fall
    // back to the serialized size. See ESTABLISH BODY CAP in the module doc.
    if (!isEstablishBody(body, opts.sessionStore, owner) && requestBodyBytes(c, body) > env.MAX_REQUEST_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }

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
 * request's messages/parameters/identity. Shared by the sync and async paths
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
  /** Background-path worker label only (`body.thread_id`, else `messageId`). */
  clientThreadId: string | undefined;
  /**
   * Client-generated session id (plan §5) for the managed-session path. Present
   * exactly when the managed request carried a valid, non-empty `session_id`
   * (REQUIRED for managed turns). Absent for every other request.
   */
  sessionId: string | undefined;
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

  // Managed mode is an explicit, opt-in contract (§5): it REQUIRES a messageId
  // (the idempotency key) and a non-empty `session_id` — the session path is
  // the ONLY sync conversation mode (the legacy `thread_id`/checkpoint path is
  // gone). A managed request is never stateless: a missing session store is a
  // 503, not a silent fallback.
  const conversationMode = body["conversation_mode"];
  let managed = false;
  let managedMessageId: string | undefined;
  let sessionId: string | undefined;
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
    // `session_id` is the managed path's conversation identity (§5) and is
    // REQUIRED: a managed request without it is a 400, never a checkpoint/thread
    // fallback.
    const rawSessionId = typeof body["session_id"] === "string" ? body["session_id"].trim() : "";
    if (rawSessionId === "") {
      return {
        ok: false,
        response: c.json(
          { error: "invalid_request", message: "session_id required for managed conversations" },
          400,
        ),
      };
    }
    sessionId = rawSessionId;
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
      sessionId,
      managed,
      managedMessageId,
      enabledPlugins,
      agentOverride,
    },
  };
}

/**
 * The synchronous streaming path. Builds the agent and streams SSE.
 *
 * Managed requests (`conversation_mode: "managed"` — which REQUIRES `session_id`
 * per resolveChatRequest) dispatch to `handleManagedSessionStream`; every other
 * request is a STATELESS run over the client's `messages` verbatim. Neither
 * branch touches the checkpointer, thread locks, the ledger, or the context
 * manager.
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
  const { managed } = resolved.value;

  // Managed-session path (plan §5): a managed request carries a validated
  // non-empty `session_id` (required in resolveChatRequest) and dispatches to
  // the session store — the ledger, checkpointer, thread locks, and context
  // manager are NOT touched. A managed request with no store is a 503 (never a
  // silent stateless run).
  if (managed) {
    if (!opts.sessionStore) {
      return c.json(
        { error: "managed_unavailable", message: "managed session conversations require the session store" },
        503,
      );
    }
    return handleManagedSessionStream(c, owner, resolved.value, opts, budget);
  }

  const {
    modelPluginId,
    requestModel,
    plugin,
    credentials,
    rawMessages,
    requestParameters,
  } = resolved.value;

  const buildModelFn = opts.buildModel ?? buildModel;
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
    const graph = createAgentGraph({
      model,
      tools,
      systemPrompt: resolved.value.agentOverride?.systemPrompt,
      beforeModelCall: () => {
        execution.signal.throwIfAborted();
        budget.beforeModelCall(owner, "sync");
      },
    });
    const modelId = requestModel ?? plugin.inference.defaultModel;

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
        { messages: toLangChainMessages(rawMessages) },
        { version: "v2" },
        modelId,
        execution,
        reservation.release,
        undefined,
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
 * The stateless managed-session sync path (plan §4/§5). Every managed request
 * (which REQUIRES `session_id`, validated in resolveChatRequest) lands here: the
 * in-memory `sessionStore` is the only conversation state, and the graph is
 * compiled WITHOUT a checkpointer.
 *
 * Establish vs delta is classified by BODY SHAPE (F1/F2/§6), not session
 * liveness alone:
 *   - a FULL-HISTORY body (more than one message) is an ESTABLISH — the
 *     request's `messages` replace the session under `session_id`
 *     (`x-conversation-state: seeded`). This includes the §6 compaction
 *     re-base, which re-establishes under the SAME live session_id.
 *   - a single-message body against a MISSING session is an ESTABLISH when the
 *     store has no tombstone (fresh first turn, `"restart"` reason) and a 409
 *     `session_missing` when the store reports `"evicted"` (F1).
 *   - a single-message body against a LIVE session is a DELTA — appended via
 *     the store's exactly-once `appendDelta` (`x-conversation-state: resumed`);
 *     the graph runs on the session's accumulated messages (full context, R12).
 *
 * The messageId is anchored on every establish (seed WITHOUT the trailing user
 * turn, then `appendDelta` it), so exactly-once dedupe + failure rollback work
 * from the first turn. The generation captured at append time is threaded into
 * finalization so a mid-turn eviction+re-seed cannot stamp the new incarnation.
 *
 * On stream success the final assistant message (captured from the root
 * `on_chain_end`) is appended to the session under a synthetic
 * `<messageId>:assistant` id and the messageId is marked completed; on
 * failure/cancel the messageId is marked failed (the store rolls the appended
 * user turn back). An evicted-mid-turn mark is logged and ignored.
 */
async function handleManagedSessionStream(
  c: Context,
  owner: string,
  resolved: ResolvedChat,
  opts: ChatRoutesOptions,
  budget: BudgetManager,
): Promise<Response> {
  const sessionStore = opts.sessionStore!;
  const sessionId = resolved.sessionId!; // dispatch gate guarantees non-null
  const messageId = resolved.managedMessageId!; // validated in resolveChatRequest
  const { rawMessages } = resolved;

  let state: "seeded" | "resumed";
  let sessionMessages: BaseMessage[];
  // The session incarnation this turn was anchored against (F4): threaded into
  // finalization so a stale turn never writes into a re-seeded session.
  let turnGeneration: number | undefined;
  const messages = toLangChainMessages(rawMessages);
  const existing = sessionStore.getMessages(owner, sessionId);
  if (existing === null) {
    // MISSING SESSION (§5, F1): a multi-message body is an establish. A
    // SINGLE-message body establishes when the store has no tombstone (reason
    // `"restart"` — a brand-new conversation's first turn, or the first turn
    // after a gateway restart); only a tombstoned (`"evicted"`) session keeps
    // the §4 eviction signal (409) so the client re-establishes with a
    // full-history body.
    if (
      messages.length <= 1 &&
      sessionStore.missingReason(owner, sessionId) === "evicted"
    ) {
      return sessionMissingResponse(c, sessionId, "evicted");
    }
    if (lastMessageIsUser(rawMessages) && messages.length > 0) {
      // Anchor the messageId from the very first turn: seed the history
      // WITHOUT the trailing user turn, then append it as a delta so
      // `outcomes[messageId]` is recorded (a concurrent/retried establish is
      // deduped, and a failed establish rolls the user turn back).
      const seeded = await sessionStore.establish(owner, sessionId, messages.slice(0, -1));
      if (seeded.status === "session_missing") {
        return sessionMissingResponse(c, sessionId, seeded.reason);
      }
      const userMsg = lastUserMessage(rawMessages)!;
      const appended = await sessionStore.appendDelta(owner, sessionId, messageId, userMsg);
      if (appended.status !== "resumed") {
        return mapSessionAppend(c, sessionId, messageId, appended);
      }
      turnGeneration = appended.generation;
      // Graph input = the full history we just seeded (equivalent to the
      // store's messages, and immune to a concurrent same-session re-seed).
      sessionMessages = messages;
    } else {
      // No trailing user turn to anchor (protocol edge): plain seed, no dedupe.
      const seeded = await sessionStore.establish(owner, sessionId, messages);
      if (seeded.status === "session_missing") {
        return sessionMissingResponse(c, sessionId, seeded.reason);
      }
      turnGeneration = seeded.generation;
      sessionMessages = messages;
    }
    state = "seeded";
  } else if (messages.length > 1) {
    // LIVE SESSION + FULL HISTORY (F2/§6): classify by BODY SHAPE, not
    // liveness. A multi-message body under the SAME session_id is the client's
    // compaction re-base — `store.reestablish` atomically dedupes the messageId
    // (a retransmitted body short-circuits to already_completed WITHOUT
    // clobbering the session) and, on a fresh turn, REPLACES `messages` (that
    // is exactly what a re-base means) while re-anchoring the messageId. Graph
    // input = the full body; state `seeded`. The `outcomes` anchor survives the
    // re-seed (store).
    if (!lastMessageIsUser(rawMessages)) {
      return c.json(
        { error: "invalid_request", message: "session establish requires a trailing user message" },
        400,
      );
    }
    const reestablished = await sessionStore.reestablish(owner, sessionId, messageId, messages);
    switch (reestablished.status) {
      case "reestablished":
        turnGeneration = reestablished.generation;
        sessionMessages = messages;
        state = "seeded";
        break;
      case "already_completed":
      case "in_progress":
        return mapSessionAppend(c, sessionId, messageId, reestablished);
      case "session_missing":
        return sessionMissingResponse(c, sessionId, reestablished.reason);
    }
  } else {
    // LIVE SESSION + single-message body: a delta append (resumed).
    if (!lastMessageIsUser(rawMessages)) {
      return c.json(
        { error: "invalid_request", message: "session delta requires a single user message" },
        400,
      );
    }
    const userMsg = lastUserMessage(rawMessages)!;
    const appended = await sessionStore.appendDelta(owner, sessionId, messageId, userMsg);
    if (appended.status !== "resumed") {
      return mapSessionAppend(c, sessionId, messageId, appended);
    }
    turnGeneration = appended.generation;
    sessionMessages = sessionStore.getMessages(owner, sessionId) ?? existing;
    state = "resumed";
  }

  // Build the agent exactly like the stateless sync branch: model from the
  // plugin + request, real ToolExecutor (or the test seam), NO checkpointer.
  //
  // EXACTLY-ONCE PRE-STREAM ROLLBACK (plan §4 step 6): the user message was
  // appended and `outcomes[messageId]` set to `in_progress` before this section
  // (dedupe must be atomic at append time), so EVERY failure before the stream
  // reaches the wire must roll the turn back with `markFailed` — a model-build
  // error, an MCP bind rejection, a budget-busy rejection, or a
  // buildStreamResponse construction error. Otherwise the outcome would sit
  // `in_progress` forever and a same-messageId retry would 409
  // conversation_in_flight. The wrapper below guarantees exactly ONE
  // `markFailed` per failed turn: the buildStreamResponse construction catch
  // (below) and the stream-side finalization (`finalizeSessionTurn`) already
  // mark, and they RETURN (or stream) rather than rethrowing into this wrapper,
  // so no path double-marks.
  const buildModelFn = opts.buildModel ?? buildModel;
  const { modelPluginId, requestModel, plugin, credentials, requestParameters } = resolved;
  // The generation captured at append time (in scope on every path that reaches
  // this section — all four append/seed branches above set it) keeps the rollback
  // from stamping a re-seeded incarnation (F4).
  const rollbackTurn = () =>
    sessionStore.markFailed(owner, sessionId, messageId, turnGeneration).catch(() => {});
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
    await rollbackTurn();
    return preStreamError(c, err);
  }

  try {
    const toolHandler =
      opts.toolHandler ??
      new ToolExecutor({
        registry: opts.registry,
        getPinnedIps: opts.pluginStore.getPinnedIps.bind(opts.pluginStore),
        trustedHosts: opts.trustedHosts,
      });
    const toolCredentialsByPlugin = resolved.toolCredentialsByPlugin;
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
    }, resolved.enabledPlugins);
    const mcpBinding = resolved.agentOverride?.mcpServers
      ? await bindMcpServers(resolved.agentOverride.mcpServers, {
          signal: execution.signal,
          trustedHosts: env.MCP_TRUSTED_HOSTS,
        })
      : undefined;
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
      const graph = createAgentGraph({
        model,
        tools,
        systemPrompt: resolved.agentOverride?.systemPrompt,
        beforeModelCall: () => {
          execution.signal.throwIfAborted();
          budget.beforeModelCall(owner, "sync");
        },
      });
      // Deliberately NO checkpointer: sessions are stateless, compiled per
      // request, and the graph input is the session's accumulated messages.
      const modelId = requestModel ?? plugin.inference.defaultModel;

      // The final assistant reply, captured from the root `on_chain_end`.
      let reply: BaseMessage | undefined;

      const reservation = budget.reserveSync(owner);
      if (!reservation.ok) {
        // Budget-busy is a DESIGNED condition under load, not a bug — but the
        // turn is already appended, so roll it back (a same-messageId retry is
        // then a clean re-run once a slot frees).
        await rollbackTurn();
        return busy(c, 429, reservation.retryAfterSeconds);
      }
      try {
        scheduleWarmups(opts, owner, toolCredentialsByPlugin);
        mcpHandedOff = true;
        const stream = buildStreamResponse(
          graph,
          { messages: sessionMessages },
          { version: "v2" },
          modelId,
          execution,
          reservation.release,
          undefined,
          (outcome) =>
            finalizeSessionTurn(sessionStore, owner, sessionId, messageId, outcome, reply, turnGeneration),
          disposeMcp,
          (finalReply) => {
            reply = finalReply;
          },
        );
        stream.headers.set("x-session-id", sessionId);
        stream.headers.set("x-conversation-state", state);
        return stream;
      } catch (err) {
        reservation.release();
        // Construction failure (never reached the wire): mark failed so a retry
        // with the same messageId is a clean re-run (plan §4 step 6) rather than
        // a half-appended turn.
        await rollbackTurn();
        return preStreamError(c, err);
      }
    } finally {
      if (!mcpHandedOff) await disposeMcp();
    }
  } catch (err) {
    // An unexpected pre-stream throw — an MCP bind rejection, or a graph/
    // tool-merging failure — surfaces exactly as an uncaught handler error
    // (Hono 500) but FIRST rolls the appended turn back so the same messageId
    // stays retryable (plan §4 step 6).
    await rollbackTurn();
    throw err;
  }
}

/**
 * Persist a session turn's terminal state from the stream's honest outcome
 * (the `onOutcome` hook of `buildStreamResponse`):
 *   - succeeded -> append the assistant reply under a synthetic
 *     `<messageId>:assistant` id (the store's only appender is `appendDelta`;
 *     the suffix can never collide with a client-generated UUID) so the read-
 *     back `GET /v1/sessions/:id` includes it, then mark the messageId
 *     completed;
 *   - failed/cancelled -> mark the messageId failed (the store rolls the
 *     appended user turn back; §4 step 6).
 * `generation` is the session incarnation captured when the turn's user message
 * was appended. Both the reply append (via `expectedGeneration`) and the marks
 * no-op against a re-seeded session — an evicted-then-reseeded session must not
 * receive the stale reply or be stamped by the stale turn (F4). The reply
 * append is `evictOnOverflow: false`: an over-cap reply is dropped rather than
 * evicting the session (the client cannot control reply size, F5). An
 * evicted-mid-turn mark is logged and ignored — the client re-establishes
 * under the same session_id (§5). Never throws into the stream.
 */
async function finalizeSessionTurn(
  sessionStore: SessionStore,
  owner: string,
  sessionId: string,
  messageId: string,
  outcome: "succeeded" | "failed" | "cancelled",
  reply: BaseMessage | undefined,
  generation?: number,
): Promise<void> {
  if (outcome === "succeeded") {
    const finalReply = reply ?? new AIMessage({ content: "" });
    const replyAppend = await sessionStore.appendDelta(
      owner,
      sessionId,
      `${messageId}:assistant`,
      finalReply,
      { expectedGeneration: generation, evictOnOverflow: false },
    );
    if (
      replyAppend.status === "session_missing" ||
      replyAppend.status === "generation_changed"
    ) {
      console.warn(
        `chat: session ${sessionId} evicted/replaced mid-turn; completed outcome dropped`,
      );
      return;
    }
    await sessionStore.markCompleted(owner, sessionId, `${messageId}:assistant`, finalReply, generation);
    const completed = await sessionStore.markCompleted(owner, sessionId, messageId, finalReply, generation);
    if (completed.evicted) {
      console.warn(`chat: session ${sessionId} evicted mid-turn; completed outcome dropped`);
    }
  } else {
    const failed = await sessionStore.markFailed(owner, sessionId, messageId, generation);
    if (failed.evicted) {
      console.warn(`chat: session ${sessionId} evicted mid-turn; failure outcome dropped`);
    }
  }
}

/**
 * 409 `session_missing` (plan §5): the session_id is gone — the client must
 * re-establish under the SAME session_id (not mint a new one). `reason` is the
 * store's tombstone-backed `"evicted" | "restart"`.
 */
function sessionMissingResponse(c: Context, sessionId: string, reason: SessionMissingReason): Response {
  const res = c.json({ error: "session_missing", reason }, 409);
  res.headers.set("x-session-id", sessionId);
  return res;
}

/**
 * Map a non-`resumed` `appendDelta` result to HTTP on the managed-session path:
 *   - already_completed -> 200 `{ status, sessionId, messageId }` (NO taskId,
 *     terminalStatus, or threadId per §5) with BOTH `x-session-id` and
 *     `x-conversation-state: resumed` (F3 — the client requires
 *     `x-conversation-state` on every managed 2xx); the reply is read back via
 *     `GET /v1/sessions/:id`;
 *   - in_progress -> 409 `conversation_in_flight` (a concurrent turn with the
 *     same messageId is already running);
 *   - session_missing -> 409 `session_missing` with the store's reason.
 * `generation_changed` is unreachable on the user-append path (the expected-
 * generation guard is only passed by `finalizeSessionTurn`, which handles it
 * itself); it is mapped defensively as a logged 500 invariant guard.
 * A `failed` outcome is NOT mapped here: `appendDelta` treats it as a clean
 * re-run (plan §4 step 6) and returns `resumed`, so the retry streams normally.
 */
function mapSessionAppend(
  c: Context,
  sessionId: string,
  messageId: string,
  result:
    | Exclude<AppendDeltaResult, { status: "resumed" }>
    | Exclude<ReestablishResult, { status: "reestablished" }>,
): Response {
  switch (result.status) {
    case "already_completed": {
      const res = c.json({ status: "already_completed", sessionId, messageId }, 200);
      res.headers.set("x-session-id", sessionId);
      res.headers.set("x-conversation-state", "resumed");
      return res;
    }
    case "in_progress": {
      const res = c.json({ error: "conversation_in_flight", sessionId, messageId }, 409);
      res.headers.set("x-session-id", sessionId);
      return res;
    }
    case "session_missing":
      return sessionMissingResponse(c, sessionId, result.reason);
    case "generation_changed":
      // Invariant guard only: user appends never pass `expectedGeneration`
      // (that is finalizeSessionTurn's reply-append path, which handles this
      // itself). If it ever fires, the session was re-seeded under a live turn.
      console.warn(`chat: session ${sessionId} re-seeded mid-append; turn not anchored`);
      return c.json({ error: "internal" }, 500);
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
 * Background-path helper: `managedDuplicateResponse` maps an
 * `inspectManagedTurn` duplicate of an ADMITTED background task (running ->
 * `conversation_in_flight`, terminal -> `already_completed`, wrong worker ->
 * `message_thread_conflict`).
 */
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
  const { jobRunner, ledger, pins } = opts;
  // The async path needs the runner, an owner-scoped ledger to admit against,
  // and the shared pin store. No checkpoint store — jobs run on a
  // self-contained snapshot (ledger v5 payload).
  if (!jobRunner || !ledger || !pins) {
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

  // A background request without `thread_id` runs under a worker label keyed
  // by its messageId (deterministic per send); the runner stores the label in
  // the ledger `worker` column at admission.
  const clientThread = clientThreadId ?? messageId;

  // Idempotent retry (Wave C2 IDEMPOTENCY): a request whose (owner, messageId)
  // already has a ledger task is a re-submit of an admitted job, NOT a fresh
  // snapshot. De-dupe BEFORE admission: a running task -> 409
  // `conversation_in_flight`, a terminal task -> 200 `already_completed`
  // (via `inspectManagedTurn` / `managedDuplicateResponse`). A queued task
  // falls through — the runner owns the claim race (in_flight vs. claim).
  const existing = ledger.getTaskByIntentKey(owner, messageId);
  if (existing) {
    const duplicate = inspectManagedTurn(existing, clientThread);
    if (duplicate) return managedDuplicateResponse(c, duplicate);
  }

  // The job's SNAPSHOT: the request's `messages` converted to LangChain the
  // same way the stateless sync path does. The job runs on THIS snapshot
  // (never a live session/checkpoint); the runner persists it as the ledger
  // payload for crash-resume and `resumeStuckJobs` re-runs from it.
  const snapshot = toLangChainMessages(rawMessages);

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
  // so a queue-full 503 leaves no phantom task row. A queued admission parks
  // in the owner's bounded FIFO queue and waits (up to the budget's waitMs)
  // for a free slot; the pool is shared with sync streams. Releasing after
  // `runJob` returns (ANY result) mirrors the M1 pin-release pattern: a
  // non-claimed duplicate (in_flight / already_terminal) must not hold a
  // reservation either.
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
      // (`resumeStuckJobs`) resumes under the same worker label instead of
      // re-deriving one from the intent key.
      worker: clientThread,
    });
  } catch (err) {
    console.error("chat: background task admission failed", err);
    releasePins();
    reservation.release();
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
      systemPrompt: resolved.value.agentOverride?.systemPrompt,
      mcpServers: resolved.value.agentOverride?.mcpServers,
      pinHandles,
      input: { messages: snapshot },
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
 * — the value the client must echo back as `thread_id`. The runner's
 * `result.threadId` is now the same raw client label (there is no checkpoint
 * thread to hash it into anymore); it is kept for the result type's shape, and
 * this mapping uses the caller-provided public label directly.
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

/** True when the client's LAST message on a session turn is a `user` message.
 *  The managed-session path requires a delta to end with a single user turn. */
function lastMessageIsUser(messages: unknown[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return isRecord(last) && last["role"] === "user";
}

/**
 * Build the SSE `Response`. `onRelease` is called exactly once when the stream
 * completes, errors, or is cancelled. The post-stream `onAfterStream` hook is
 * best-effort and never fails the stream. `onReply` receives the final
 * assistant `BaseMessage` from the root `on_chain_end` (the managed-session
 * path persists it as the turn's reply).
 */
function buildStreamResponse(
  graph: AgentGraph,
  input: Record<string, unknown>,
  streamOptions: StreamOptions,
  modelId: string,
  execution: StreamExecution,
  onRelease?: () => void,
  onAfterStream?: () => void | Promise<void>,
  onOutcome?: (outcome: "succeeded" | "failed" | "cancelled") => void | Promise<void>,
  disposeMcp?: () => Promise<void>,
  onReply?: (reply: BaseMessage) => void,
): Response {
  const events = graph.streamEvents(input, { ...streamOptions, signal: execution.signal });
  // `replyComplete` latches once the root `on_chain_end` has produced the final
  // assistant message (`captureAssistantReply` fires `onReply` at that point,
  // which precedes [DONE]). It lets the outcome decision treat a client abort
  // AFTER the full reply was emitted to the wire as `succeeded` instead of
  // `cancelled` — a delivered reply must not be rolled back (F4).
  let replyComplete = false;
  const eventSource = onReply
    ? captureAssistantReply(events, (finalReply) => {
        replyComplete = true;
        onReply(finalReply);
      })
    : events;
  let streamFailed = false;
  const sse = toOpenAiSse(eventSource, {
    modelId,
    onOutcome: (outcome) => {
      if (outcome === "failed") streamFailed = true;
    },
  });
  const encoder = new TextEncoder();
  let cancelled = false;
  let finalized = false;
  const finalize = async () => {
    // Report the stream's honest terminal state exactly once: a mid-stream
    // SSE error frame marks `failed`, a client cancellation / abort marks
    // `cancelled`, anything else that ran to completion is `succeeded`. A
    // client abort AFTER the full reply was already emitted (F4 —
    // `replyComplete`; the root `on_chain_end` preceded the abort) is treated
    // as `succeeded`: the reply was delivered to the wire, so the managed path
    // must not roll back a delivered reply. Only an abort BEFORE a clean
    // terminal is `cancelled` (rolls back). The outcome callback may return a
    // promise (the managed-session path persists the turn's terminal outcome
    // before the stream terminates) and is awaited so a read-back immediately
    // after `[DONE]` is consistent; a throwing callback never fails an
    // already-terminated stream.
    if (finalized) return;
    finalized = true;
    let outcome: "succeeded" | "failed" | "cancelled";
    if (streamFailed) {
      outcome = "failed";
    } else if (replyComplete && (cancelled || execution.signal.aborted)) {
      outcome = "succeeded";
    } else if (cancelled || execution.signal.aborted) {
      outcome = "cancelled";
    } else {
      outcome = "succeeded";
    }
    try {
      await onOutcome?.(outcome);
    } catch (err) {
      console.warn("chat: outcome callback failed", err);
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
          await finalize();
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
          await finalize();
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
 * Peek the root `on_chain_end` of a `streamEvents` iterable and hand the final
 * assistant `BaseMessage` (the turn's reply) to `onReply`, then pass every
 * event through untouched. The managed-session path uses it to persist the
 * reply for `store.markCompleted` / `GET /v1/sessions/:id`. The final state's
 * last AIMessage is the assistant's turn output (tool-calling included).
 */
async function* captureAssistantReply(
  events: AsyncIterable<StreamEvent>,
  onReply: (reply: BaseMessage) => void,
): AsyncGenerator<StreamEvent> {
  let rootRunId: string | null = null;
  for await (const event of events) {
    if (rootRunId === null && event.event === "on_chain_start") rootRunId = event.run_id;
    if (rootRunId !== null && event.event === "on_chain_end" && event.run_id === rootRunId) {
      const output = isRecord(event.data) ? event.data["output"] : undefined;
      const messages = isRecord(output) ? output["messages"] : undefined;
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message instanceof AIMessage) {
            onReply(message);
            break;
          }
          if (isRecord(message) && message["type"] === "ai") {
            onReply(new AIMessage(message["content"] as string));
            break;
          }
        }
      }
    }
    yield event;
  }
}

/** Short human-readable intent for the ledger spec (last user message text).
 *  Capped at SPEC_MAX_LENGTH (D4) — the label is non-sensitive, never a
 *  content store. */
function intentSpec(rawMessages: unknown[]): string {
  const lastUser = lastUserMessage(rawMessages);
  const content = lastUser?.content;
  if (typeof content === "string" && content.trim() !== "") {
    const trimmed = content.trim();
    return trimmed.length > SPEC_MAX_LENGTH
      ? trimmed.slice(0, SPEC_MAX_LENGTH)
      : trimmed;
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