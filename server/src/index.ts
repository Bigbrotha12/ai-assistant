import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import * as authModule from "./auth/index.ts";
import { runWithAccountDeletionRequest } from "./auth/account_deletion.ts";
import { CredentialPinStore } from "./credentials/pins.ts";
import { env } from "./config/env.ts";
import { createHealthRoutes } from "./observability/health.ts";
import { createAuthCheckRoutes, requireApiKey } from "./auth/request_auth.ts";
import { createSentinelRoutes } from "./sentinel/routes.ts";
import { createSentinelService } from "./sentinel/service.ts";
import { buildSentinelSemanticOptions } from "./sentinel/semantic_wiring.ts";
import { policyForMode } from "./sentinel/policy.ts";
import { createJobRunner, JobError, ToolExecutor } from "./jobs/runner.ts";
import type { JobRunner } from "./jobs/runner.ts";
import { createLedgerRoutes, ledger } from "./ledger/routes.ts";
import { createSseHub } from "./notify/sse_hub.ts";
import { createSseNotificationHook } from "./notify/sse_hook.ts";
import { createSseNotifyRoutes } from "./notify/sse_routes.ts";
import { createPluginWiring } from "./plugins/index.ts";
import { createPluginRoutes } from "./plugins/routes.ts";
import { createResetPasswordRoutes } from "./auth/reset_password.ts";
import {
  createApiKeyEmailVerificationGate,
  createVerifyEmailRoutes,
  createSendVerificationRateLimit,
  getSendVerificationRateLimitGate,
} from "./auth/verify_email.ts";
import { createModelsRoutes } from "./transport/models.ts";
import { createAgentsRoutes } from "./transport/agents.ts";
import { createSkillsRoutes } from "./transport/skills.ts";
import { createMcpRoutes } from "./transport/mcps.ts";
import { createChatRoutes } from "./transport/chat.ts";
import type { JobModelRequestConfig } from "./transport/chat.ts";
import { createSessionStore } from "./sessions/store.ts";
import { createSessionRoutes } from "./sessions/routes.ts";
import { buildModel } from "./transport/model.ts";
import { createBudgetManager } from "./managers/budget.ts";
import { createPerOwnerRateLimiter } from "./managers/rate_limit.ts";
import { createToolResultCache } from "./managers/cache.ts";
import { createWarmupManager } from "./managers/warmup.ts";
import { buildPipelineForChannel } from "./tools/channel.ts";
import { loadCatalogs } from "./catalog/index.ts";
import type { Catalogs } from "./catalog/index.ts";

// SINGLE-REPLICA ASSUMPTION (deliberate deployment choice): the composition root
// wires process-local deletion state, the RAM-only session store, per-process
// tool-cache, budget, and rate-limit state, runner pin/controller registries,
// the in-memory SSE notify registry, and the file-backed ledger store.
// These require **exactly one gateway
// replica; no overlapping rolling deployments**. A second or overlapping
// process can miss a deletion tombstone, admit work that raced deletion, lose
// session state, or route a job completion to the wrong replica's notify
// streams. There is no in-process
// way to detect the
// real replica count; an environment flag cannot assert it, so ops must enforce
// the Deployment and rollout. Multi-replica deletion coordination is a
// separate distributed-coordination project.
const auth = authModule.auth;
const sendVerificationRateLimitGate = getSendVerificationRateLimitGate();
const apiKeyEmailVerificationGate = createApiKeyEmailVerificationGate({
  getSession: (headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    }),
  getUserById: authModule.getUserById,
});

const app = new Hono();
let stopping = false;

app.use(async (c, next) => {
  if (stopping) return c.json({ error: "shutting_down" }, 503);
  await next();
});

app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
// Resend gate: per-address ≥60s limiter for `POST
// /api/auth/send-verification-email` (better-auth's global rate limit is not
// per-address). MUST be registered before the catch-all below so it wraps the
// better-auth handler — Hono runs matched handlers in registration order and
// the catch-all never calls next().
app.use(
  "/api/auth/send-verification-email",
  createSendVerificationRateLimit(sendVerificationRateLimitGate),
);
app.use("/api/auth/api-key/create", apiKeyEmailVerificationGate);
app.use("/api/auth/api-key/list", apiKeyEmailVerificationGate);
app.use("/api/auth/delete-user", (c, next) => {
  if (c.req.method !== "POST") return next();
  return runWithAccountDeletionRequest(() => next());
});
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/v1", createAuthCheckRoutes());

// Password-reset completion page — the emailed link targets `GET
// /reset-password?token=…`, not better-auth's /api/auth callback redirect
// (the app has no deep-link handling). Mounted OUTSIDE the /api/auth namespace
// so the page is only ever served by this Hono app.
app.route("/", createResetPasswordRoutes());
// Email-verification completion page — same pattern: the emailed link
// targets `GET /verify-email?token=…`; the page fetches better-auth's
// `GET /api/auth/verify-email` wire route from JS.
app.route("/", createVerifyEmailRoutes());

// No checkpoint DB is ever opened. Remove any checkpoints.db left behind by
// earlier deployments so abandoned conversation data does not linger at rest
// (goal: no long-term user content on disk). Best-effort, never fatal.
for (const base of ["./data/checkpoints.db"]) {
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        console.warn(`Gateway: removed legacy checkpoint file ${path}`);
      }
    } catch (err) {
      console.warn(`Gateway: could not remove legacy checkpoint file ${path}: ${(err as Error).message}`);
    }
  }
}

// In-memory, owner-scoped SSE registry for job-completion notifications: the
// job runner broadcasts through it (`sse_hook.ts`) and `/v1/notify/events`
// opens one stream per connected client. Process-local by design (see the
// single-replica contract above); a job completing on another replica could not
// reach a stream held here.
const sseHub = createSseHub();
// Mounted at the exclusive `/v1/notify`, NOT the shared `/v1` root: the router's
// wildcard owner gate would otherwise leak onto every sibling.
app.route("/v1/notify", createSseNotifyRoutes({ hub: sseHub }));

const { registry: pluginRegistry, store: pluginStore } = createPluginWiring();
await pluginStore.load();

// The Sentinel semantic (Kev-4B) stage is a boot dependency of the plugin
// registry/store, so it is wired AFTER the store loads (the decision plugin is
// not resolvable before that) and BEFORE any request is accepted. A disabled
// stage builds no client and makes no calls; an enabled-but-unavailable stage
// fails open (the shared options object carries an evaluator that reports the
// stage unavailable) so the gateway still starts and the check and shadow paths
// both fall back to L1. ONE options object is shared by the service's shadow
// reporter and its `check()` path, so they use the same client and cache.
const sentinelSemantic = buildSentinelSemanticOptions({
  enabled: env.SENTINEL_SEMANTIC_ENABLED,
  pluginId: env.SENTINEL_SEMANTIC_PLUGIN_ID,
  threshold: env.SENTINEL_SEMANTIC_THRESHOLD,
  contextAware: env.SENTINEL_SEMANTIC_CONTEXT_AWARE,
  timeoutMs: env.SENTINEL_SEMANTIC_TIMEOUT_MS,
  trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
  registry: pluginRegistry,
  pluginStore,
});
const sentinelService = createSentinelService({
  ledger,
  policy: policyForMode(env.SENTINEL_POLICY_MODE ?? "advisory"),
  semantic: sentinelSemantic,
});
const sentinelShadowReporter = sentinelService.shadow;
app.route(
  "/v1",
  createSentinelRoutes({
    ledger,
    service: sentinelService,
    verifyKey: requireApiKey,
    policyMode: env.SENTINEL_POLICY_MODE,
    maxBodyBytes: env.SENTINEL_MAX_BODY_BYTES,
    rateLimiter: createPerOwnerRateLimiter({
      ratePerMinute: env.SENTINEL_RATE_LIMIT,
      burst: env.SENTINEL_RATE_BURST,
    }),
  }),
);

// Load catalogs (skills, mcps, agent templates) from CONFIG_DIR
const configDir = env.CONFIG_DIR;
const catalogs: Catalogs = await loadCatalogs(configDir, pluginStore);
// Hot-reload on live plugins.json edits (fs.watch via the registry, wired in
// production too so config changes apply without a restart). The registry
// debounces, ignores the store's own atomic saves (self-write snapshot guard),
// and reports failures via onError — never crashing the process; a bad
// hand-edit simply leaves the last known-good config in force.
pluginRegistry.watch({
  onError: (err) => {
    console.error("plugin registry: store hot-reload failed:", err);
  },
});
app.route("/v1", createPluginRoutes({ registry: pluginRegistry, store: pluginStore }));

// `GET /v1/models` serves the installed MODEL plugins (incl. `visionCapable`)
// from the registry; the single `/v1/models` owner. Never leaks plugin
// endpoints/baseUrls (see transport/models.ts).
app.route("/v1", createModelsRoutes({ registry: pluginRegistry }));

// `GET /v1/agents` lists installed agent plugins. Same security contract as
// /v1/models — never leaks systemPrompt/skills content/endpoints.
app.route("/v1", createAgentsRoutes({ registry: pluginRegistry, catalogs }));

// `GET /v1/skills` and `GET /v1/mcps` list catalog entries with content
// redacted — never leaks skill content or MCP urls/headers.
app.route("/v1", createSkillsRoutes({ catalogs, verifyKey: requireApiKey }));
app.route("/v1", createMcpRoutes({ catalogs, verifyKey: requireApiKey }));

// ONE in-memory tool-result cache shared by the sync transport and every
// background job so the same read-only tool call is never executed twice
// across either path.
const toolCache = createToolResultCache();
const chatBudget = createBudgetManager({
  maxConcurrentPerUser: env.BUDGET_MAX_CONCURRENT,
  queueMaxPerUser: env.BUDGET_QUEUE_MAX,
  maxModelCallsPerWindow: env.BUDGET_MODEL_CALL_LIMIT,
  modelCallWindowMs: env.BUDGET_MODEL_CALL_WINDOW_MS,
});
// Tool-pipeline construction is a composition-root concern. ONE
// sync-shaped engine (`serialize → cache → budget → execution`) is shared by
// the sync transport's plugin and MCP bindings AND by warmup; it is stateless
// between dispatches (per-call data rides `ToolCall`/`ToolCallScope`). The
// job-shaped engine cannot be a root singleton — its `fence` interceptor closes
// over the per-job `assertActive` — so the root supplies the factory to the
// runner below. The channel→interceptor mapping lives in
// `buildPipelineForChannel` (tools/channel.ts).
const syncToolPipeline = buildPipelineForChannel("sync-managed", {
  budget: chatBudget,
  cache: toolCache,
});
const warmupExecutor = new ToolExecutor({
  registry: pluginRegistry,
  getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
  trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
});
const warmups = createWarmupManager({
  enabled: env.WARMUP_ENABLED,
  maxConcurrent: env.WARMUP_MAX_CONCURRENT,
  timeoutMs: env.WARMUP_TIMEOUT_MS,
  registry: pluginRegistry,
  cache: toolCache,
  budget: chatBudget,
  pipeline: syncToolPipeline,
  createHandler: ({ signal }) => ({
    execute: (pluginId, toolName, args, credentials) =>
      warmupExecutor.execute(pluginId, toolName, args, credentials, signal),
  }),
});
let jobRunner: JobRunner | undefined;
let jobPins: CredentialPinStore | undefined;
// The composition root owns the SHARED credential
// dependency — the in-memory pin store — but NOT the two providers. Both are
// inherently per-invocation and are constructed by their consumers:
//   - `RequestBodyCredentialResolver` per REQUEST in `transport/chat.ts`
//     (it closes over that request's validated body maps); and
//   - `PinStoreCredentialResolver` per JOB in `jobs/runner.ts`
//     (it closes over the admitted pin handles + running-fence guard).
// Neither can be a root singleton: a shared one would either hold one
// request's credentials for another's turn or lose the per-job handle/fence.
try {
  jobPins = new CredentialPinStore();
  jobRunner = createJobRunner({
    ledger,
    shadowReporter: sentinelShadowReporter,
    registry: pluginRegistry,
    pins: jobPins,
    getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
    // The executor's call-time validatedFetch re-resolution must apply
    // the SAME trusted-hosts policy the pins were computed under, or an
    // admin-trusted internal plugin backend (`*.local`, RFC1918) would be
    // rejected as DNS_REBINDING on every tool call.
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    // Job-completion notifications fan out to the owner's open SSE streams
    // (`/v1/notify/events`); a no-op when the owner has none.
    notification: createSseNotificationHook(sseHub),
    // The shared in-memory tool-result cache so a repeated
    // read-only tool call is never executed twice across sync and async.
    toolCache,
    budget: chatBudget,
    // The job-channel engine is built here (from the same shared
    // deps) but instantiated per job by the runner, because `fence` closes over
    // the per-job `assertActive`. The channel→interceptor mapping still lives
    // in `buildPipelineForChannel`.
    createToolPipeline: (assertActive) =>
      buildPipelineForChannel("job", {
        ledger,
        budget: chatBudget,
        cache: toolCache,
        assertActive,
      }),
    // Periodic credential-pin GC. In-memory pins are released by the
    // runner's finally / the transport's non-claimed-path releases, but a
    // crash between admission and claim could still leak one; a periodic
    // sweep bounds that window instead of relying on the release paths alone.
    sweepIntervalMs: 60_000,
    buildModel: (modelPluginId, requestConfig, context) => {
      context.signal.throwIfAborted();
      context.assertActive();
      const cfg = requestConfig as JobModelRequestConfig | undefined;
      if (!context.credentials) {
        throw new JobError(
          "credentials_expired",
          "no scoped model credentials available for background model builds",
        );
      }
      return buildModel({
        registry: pluginRegistry,
        pluginStore,
        modelPluginId,
        requestModel: cfg?.requestModel,
        requestParameters: cfg?.requestParameters,
        credentials: context.credentials,
        trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
      });
    },
  });
  // Restart-loss startup pass: `ledger.reconcileOrphans()` (ledger/routes.ts)
  // already marked orphans `stuck`; resumeStuckJobs re-runs them from their
  // stored snapshot payload when pins can be re-established, else fails them
  // cleanly (no vault yet → credentials_expired).
  await jobRunner.resumeStuckJobs();
} catch (err) {
  jobRunner?.dispose();
  jobRunner = undefined;
  jobPins = undefined;
  console.warn("jobs: JobRunner unavailable; background jobs disabled:", err);
}

app.route("/ledger", createLedgerRoutes(ledger, { jobRunner }));

// `POST /v1/chat/completions` is the LangChain transport
// (`src/transport/chat.ts`) — model built from the MODEL plugin + per-request
// credentials, agent graph streamed via the SSE adapter (sync), or admitted as
// an idempotent background job (async, `background: true`). The sync path is
// session-only; the async path runs on a self-contained message snapshot the
// runner persists as the ledger payload (no checkpoint store involved). If
// runner wiring failed, async delegation returns 503 background_unavailable.
//
// Per-owner gates: the rate limiter reuses the
// existing INFERENCE_RATE_LIMIT / INFERENCE_RATE_BURST knobs as PER-OWNER
// values (the bucket key is the authenticated user id, not the API key), and
// the budget caps concurrent in-flight chat operations per owner.
const chatRateLimiter = createPerOwnerRateLimiter({
  ratePerMinute: env.INFERENCE_RATE_LIMIT,
  burst: env.INFERENCE_RATE_BURST,
});
// In-memory, evictable session cache: a mirror of a client-owned conversation,
// keyed (owner, session_id). Always created —
// RAM-only, no boot dependencies. Served read-back via `createSessionRoutes`
// (GET/DELETE /v1/sessions/:id) and written by the sync transport's
// managed-session path.
const sessionStore = createSessionStore();
authModule.configureAccountDeletionRuntime?.({
  // FIRST (DEFENSIVE_PATTERNS §4): close the owner's notification streams
  // before aborting/purging, so a late job completion stays silent.
  closeOwner: (owner) => sseHub.closeOwner(owner),
  abortOwner: (owner) => jobRunner?.abortOwner(owner),
  deleteSessionsForOwner: (owner) => sessionStore.deleteSessionsForOwner(owner),
  invalidateForUser: (owner) => toolCache.invalidateForUser(owner),
  releaseOwner: (owner) => jobPins?.releaseOwner(owner),
});
app.route("/v1", createSessionRoutes({ store: sessionStore, verifyKey: requireApiKey }));
app.route(
  "/v1",
  createChatRoutes({
    registry: pluginRegistry,
    pluginStore,
    catalogs,
    sessionStore,
    shadowReporter: sentinelShadowReporter,
    ledger,
    jobRunner,
    pins: jobPins,
    toolCache,
    // The ONE sync-shaped engine, shared with warmup above.
    toolPipeline: syncToolPipeline,
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    rateLimiter: chatRateLimiter,
    budget: chatBudget,
    warmups,
  }),
);


// Unauthenticated probe for k8s liveness/readiness (200 when
// both DB checks pass, 503 `degraded` otherwise). The probes themselves are
// OUT-OF-REPO — the copy-paste k3s patch ships at deploy/k8s/health-probes.yaml
// and is applied by ops, not this repo's CI.
app.route("/", createHealthRoutes());

app.get("/", (c) =>
  c.json({
    name: "ai-assistant-gateway",
    auth: "/api/auth",
    inference: "/v1/chat/completions",
    ledger: "/ledger",
    sessions: "/v1/sessions",
    health: "/health",
  }),
);

// Last-resort error handler: any exception that reaches the top of the Hono
// stack (i.e. outside better-auth, which intercepts its own /api/auth errors)
// returns a JSON body instead of an empty/bare 5xx so clients never see a
// cryptic `HTTP 500` with no payload. Never leaks internal messages.
app.onError((err, c) => {
  console.error(`gateway error on ${c.req.path}:`, err);
  return c.json(
    { message: "internal server error", code: "INTERNAL_SERVER_ERROR" },
    500,
  );
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  console.log(`ai-assistant gateway listening on ${host}:${info.port}`);
});
const SENTINEL_SHADOW_FLUSH_TIMEOUT_MS = 2_000;
const cleanup = (name: string, dispose: () => void) => {
  try {
    dispose();
  } catch {
    console.error(`gateway: ${name} cleanup failed`);
  }
};
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  // Stop accepting new requests first; the `stopping` middleware 503s anything
  // new while in-flight requests drain. Bound the drain so a long-lived SSE
  // stream can't hang shutdown forever.
  const serverClosed = new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 5_000).unref?.();
  });
  cleanup("sse hub", () => sseHub.dispose());
  cleanup("warmups", () => warmups.dispose());
  cleanup("jobs", () => jobRunner?.dispose());
  cleanup("session store", () => sessionStore.dispose());
  cleanup("plugin watcher", () => pluginRegistry.disposeWatch());
  cleanup("tool cache", () => toolCache.dispose());
  await serverClosed;
  // Drain queued shadow reports before closing the ledger, but never let a stuck report block shutdown.
  let shadowFlushTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sentinelShadowReporter.flush(),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, SENTINEL_SHADOW_FLUSH_TIMEOUT_MS);
        shadowFlushTimeout = timeout;
        timeout.unref?.();
      }),
    ]);
  } catch (err) {
    console.error("gateway: sentinel shadow report flush failed", err);
  } finally {
    if (shadowFlushTimeout !== undefined) clearTimeout(shadowFlushTimeout);
  }
  // Close the ledger DB once no request can touch it anymore.
  cleanup("ledger", () => ledger.close());
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);