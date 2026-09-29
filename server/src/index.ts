import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import * as authModule from "./auth.ts";
import { runWithAccountDeletionRequest } from "./account_deletion.ts";
import { CredentialPinStore } from "./credentials/pins.ts";
import { env } from "./env.ts";
import { createHealthRoutes } from "./health.ts";
import { inferenceRoutes, requireApiKey } from "./api_key.ts";
import { createSentinelRoutes } from "./sentinel/routes.ts";
import { createSentinelService } from "./sentinel/service.ts";
import { policyForMode } from "./sentinel/policy.ts";
import { createJobRunner, JobError, ToolExecutor } from "./jobs/runner.ts";
import type { JobRunner } from "./jobs/runner.ts";
import { createLedgerRoutes, ledger } from "./ledger.routes.ts";
import { createNtfyNotificationHook, notifyEgressConfigWarning } from "./notify/hook.ts";
import { createNotifyRoutes } from "./notify/routes.ts";
import { NotifyStore } from "./notify/store.ts";
import { createPluginWiring } from "./plugins/index.ts";
import { createPluginRoutes } from "./plugins/routes.ts";
import { createResetPasswordRoutes } from "./reset_password.ts";
import {
  createApiKeyEmailVerificationGate,
  createVerifyEmailRoutes,
  createSendVerificationRateLimit,
  getSendVerificationRateLimitGate,
} from "./verify_email.ts";
import { createModelsRoutes } from "./transport/models.ts";
import { createAgentsRoutes } from "./transport/agents.ts";
import { createSkillsRoutes } from "./transport/skills.ts";
import { createMcpRoutes } from "./transport/mcps.ts";
import { createChatRoutes } from "./transport/chat.ts";
import type { JobModelRequestConfig } from "./transport/chat.ts";
import { createSessionStore } from "./sessions/store.ts";
import { createSessionRoutes } from "./sessions/routes.ts";
import { buildModel } from "./transport/model.ts";
import { createBudgetManager } from "./middleware/budget.ts";
import { createPerOwnerRateLimiter } from "./middleware/rate_limit.ts";
import { createToolResultCache } from "./middleware/cache.ts";
import { createWarmupManager } from "./middleware/warmup.ts";
import { buildPipelineForChannel } from "./tools/channel.ts";
import { loadCatalogs } from "./catalog/index.ts";
import type { Catalogs } from "./catalog/index.ts";

// SINGLE-REPLICA ASSUMPTION (deliberate deployment choice): the composition root
// wires process-local deletion state, the RAM-only session store, per-process
// tool-cache, budget, and rate-limit state, runner pin/controller registries,
// and file-backed notify/ledger stores. These require **exactly one gateway
// replica; no overlapping rolling deployments**. A second or overlapping
// process can miss a deletion tombstone, admit work that raced deletion, lose
// session state, or overwrite a stale notify snapshot. There is no in-process
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
// C2 resend gate: per-address ≥60s limiter for `POST
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
app.route("/v1", inferenceRoutes);
const sentinelService = createSentinelService({
  ledger,
  policy: policyForMode(env.SENTINEL_POLICY_MODE ?? "advisory"),
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

// Password-reset completion page — the emailed link targets `GET
// /reset-password?token=…`, not better-auth's /api/auth callback redirect
// (the app has no deep-link handling). Mounted OUTSIDE the /api/auth namespace
// so the page is only ever served by this Hono app.
app.route("/", createResetPasswordRoutes());
// Email-verification completion page (C2) — same pattern: the emailed link
// targets `GET /verify-email?token=…`; the page fetches better-auth's
// `GET /api/auth/verify-email` wire route from JS.
app.route("/", createVerifyEmailRoutes());

// D8 (stateless-gateway): the SQLCipher checkpoint store is gone — no
// checkpoint DB is ever opened. Remove any checkpoints.db left behind by
// older deployments so abandoned conversation data does not linger at rest
// (goal: no long-term user content on disk). Best-effort, never fatal.
for (const base of ["./data/checkpoints.db"]) {
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        console.warn(`Gateway: removed legacy checkpoint file ${path} (D8 stateless cutover)`);
      }
    } catch (err) {
      console.warn(`Gateway: could not remove legacy checkpoint file ${path}: ${(err as Error).message}`);
    }
  }
}

// ntfy push-notification provisioning (plan §Notifications): the topic +
// access token are encrypted at rest with the NOTIFY_STORE_KEY secret; the
// NOTIFY_BASE_URL env var (empty = disabled) gates the push hook. The store
// lazy-loads, so a corrupt notify file degrades provision 500s rather than
// taking down the gateway.
const notifyStore = new NotifyStore({ key: env.NOTIFY_STORE_KEY });
authModule.configureAccountDeletionNotifyStore?.(notifyStore);
app.route("/api/notify", createNotifyRoutes({ store: notifyStore }));

const { registry: pluginRegistry, store: pluginStore } = createPluginWiring();
await pluginStore.load();
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

// Phase 3, Wave B: `GET /v1/models` now serves the installed MODEL plugins
// (incl. `visionCapable`) from the registry instead of proxying INFERENCE_URL.
// The old proxy handler was removed from inferenceRoutes (above), so this is
// the single `/v1/models` owner — no duplicate-path shadowing regardless of
// mount order. Never leaks plugin endpoints/baseUrls (see transport/models.ts).
app.route("/v1", createModelsRoutes({ registry: pluginRegistry }));

// Wave 1: `GET /v1/agents` lists installed agent plugins. Same security
// contract as /v1/models — never leaks systemPrompt/skills content/endpoints.
app.route("/v1", createAgentsRoutes({ registry: pluginRegistry, catalogs }));

// Wave 2: `GET /v1/skills` and `GET /v1/mcps` list catalog entries with
// content redacted — never leaks skill content or MCP urls/headers.
app.route("/v1", createSkillsRoutes({ catalogs, verifyKey: requireApiKey }));
app.route("/v1", createMcpRoutes({ catalogs, verifyKey: requireApiKey }));

// Phase 4, Wave B: ONE in-memory tool-result cache shared by the sync
// transport and every background job so the same read-only tool call is never
// executed twice across either path.
const toolCache = createToolResultCache();
const chatBudget = createBudgetManager({
  maxConcurrentPerUser: env.BUDGET_MAX_CONCURRENT,
  queueMaxPerUser: env.BUDGET_QUEUE_MAX,
  maxModelCallsPerWindow: env.BUDGET_MODEL_CALL_LIMIT,
  modelCallWindowMs: env.BUDGET_MODEL_CALL_WINDOW_MS,
});
// Step 1.13: tool-pipeline construction is a composition-root concern. ONE
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
// Phase 3.5 (credential seam): the composition root owns the SHARED credential
// dependency — the in-memory pin store — but NOT the two providers. Both are
// inherently per-invocation and are constructed by their consumers:
//   - `RequestBodyCredentialResolver` per REQUEST in `transport/chat.ts`
//     (it closes over that request's validated body maps); and
//   - `PinStoreCredentialResolver` per JOB in `jobs/runner.ts`
//     (it closes over the admitted pin handles + running-fence guard).
// Neither can be a root singleton: a shared one would either hold one
// request's credentials for another's turn or lose the per-job handle/fence.
// M1: tie NOTIFY_BASE_URL's host to NOTIFY_TRUSTED_HOSTS at boot. A private-
// address (or production http:) ntfy that is not trusted would otherwise be
// refused by SSRF validation and its pushes SILENTLY dropped — best-effort by
// design, so warn loudly rather than exit.
const notifyConfigWarning = notifyEgressConfigWarning(env.NOTIFY_BASE_URL, {
  trustedHosts: env.NOTIFY_TRUSTED_HOSTS,
  mode: env.NODE_ENV,
});
if (notifyConfigWarning) console.warn(notifyConfigWarning);
try {
  jobPins = new CredentialPinStore();
  jobRunner = createJobRunner({
    ledger,
    shadowReporter: sentinelShadowReporter,
    registry: pluginRegistry,
    pins: jobPins,
    getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
    // H1: the executor's call-time validatedFetch re-resolution must apply
    // the SAME trusted-hosts policy the pins were computed under, or an
    // admin-trusted internal plugin backend (`*.local`, RFC1918) would be
    // rejected as DNS_REBINDING on every tool call.
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    // ntfy push: the real hook behind the runner's DI seam. Empty
    // NOTIFY_BASE_URL (the default) makes it a silent no-op.
    notification: createNtfyNotificationHook({
      store: notifyStore,
      baseUrl: env.NOTIFY_BASE_URL,
      // Admin-vouched ntfy hosts (private-range bypass + production http:
      // carve-out), scoped to notify egress only.
      trustedHosts: env.NOTIFY_TRUSTED_HOSTS,
    }),
    // Phase 4, Wave B: the shared in-memory tool-result cache so a repeated
    // read-only tool call is never executed twice across sync and async.
    toolCache,
    budget: chatBudget,
    // Step 1.13: the job-channel engine is built here (from the same shared
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
    // M1: periodic credential-pin GC. In-memory pins are released by the
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
  // Restart-loss startup pass: `ledger.reconcileOrphans()` (ledger.routes.ts)
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

// Phase 3, Wave C1/C2: `POST /v1/chat/completions` is the LangChain transport
// (`src/transport/chat.ts`) — model built from the MODEL plugin + per-request
// credentials, agent graph streamed via the SSE adapter (sync), or admitted as
// an idempotent background job (async, `background: true`). The sync path is
// session-only; the async path runs on a self-contained message snapshot the
// runner persists as the ledger payload (no checkpoint store involved). If
// runner wiring failed, async delegation returns 503 background_unavailable.
//
// Phase 4, Wave A middleware (per-owner gates): the rate limiter reuses the
// existing INFERENCE_RATE_LIMIT / INFERENCE_RATE_BURST knobs as PER-OWNER
// values (the bucket key is the authenticated user id, not the API key), and
// the budget caps concurrent in-flight chat operations per owner.
const chatRateLimiter = createPerOwnerRateLimiter({
  ratePerMinute: env.INFERENCE_RATE_LIMIT,
  burst: env.INFERENCE_RATE_BURST,
});
// Stateless-gateway session cache (plan §4): the in-memory, evictable mirror
// of a client-owned conversation, keyed (owner, session_id). Always created —
// RAM-only, no boot dependencies. Served read-back via `createSessionRoutes`
// (GET/DELETE /v1/sessions/:id) and written by the sync transport's
// managed-session path.
const sessionStore = createSessionStore();
authModule.configureAccountDeletionRuntime?.({
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
    // Step 1.13: the ONE sync-shaped engine, shared with warmup above.
    toolPipeline: syncToolPipeline,
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    rateLimiter: chatRateLimiter,
    budget: chatBudget,
    warmups,
  }),
);


// M5 watchdog: unauthenticated probe for k8s liveness/readiness (200 when
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
  console.log(`ai-assistant gateway listening on http://localhost:${info.port}`);
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