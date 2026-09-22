import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, unlinkSync } from "node:fs";
import { auth } from "./auth.ts";
import { CredentialPinStore } from "./credentials/pins.ts";
import { env } from "./env.ts";
import { inferenceRoutes, requireApiKey } from "./inference.ts";
import { createJobRunner, JobError, ToolExecutor } from "./jobs/runner.ts";
import type { JobRunner } from "./jobs/runner.ts";
import { ledgerRoutes, ledger } from "./ledger.routes.ts";
import { createNtfyNotificationHook } from "./notify/hook.ts";
import { createNotifyRoutes } from "./notify/routes.ts";
import { NotifyStore } from "./notify/store.ts";
import { createPluginWiring } from "./plugins/index.ts";
import { createPluginRoutes } from "./plugins/routes.ts";
import { createResetPasswordRoutes } from "./reset_password.ts";
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
import { loadCatalogs } from "./catalog/index.ts";
import type { Catalogs } from "./catalog/index.ts";

const app = new Hono();
let stopping = false;

app.use(async (c, next) => {
  if (stopping) return c.json({ error: "shutting_down" }, 503);
  await next();
});

app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/v1", inferenceRoutes);
app.route("/ledger", ledgerRoutes);

// Password-reset completion page — the emailed link targets `GET
// /reset-password?token=…`, not better-auth's /api/auth callback redirect
// (the app has no deep-link handling). Mounted OUTSIDE the /api/auth namespace
// so the page is only ever served by this Hono app.
app.route("/", createResetPasswordRoutes());

// D8 (stateless-gateway): the SQLCipher checkpoint store is gone — no
// checkpoint DB is ever opened. Remove any legacy checkpoints.db left behind
// by older deployments so abandoned conversation data does not linger at rest
// (goal: no long-term user content on disk). The retired CHECKPOINT_DB_PATH
// env var is still honored here for custom locations; cleanup is best-effort
// and never fatal.
for (const base of [process.env.CHECKPOINT_DB_PATH ?? "./data/checkpoints.db"]) {
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
// access token are encrypted at rest with the NOTIFY_STORE_KEY secret (legacy
// alias CHECKPOINT_DB_KEY); the NOTIFY_BASE_URL env var (empty = disabled)
// gates the push hook. The store lazy-loads, so a corrupt notify file
// degrades provision 500s rather than taking down the gateway.
const notifyStore = new NotifyStore({ key: env.NOTIFY_STORE_KEY });
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
  createHandler: ({ signal }) => ({
    execute: (pluginId, toolName, args, credentials) =>
      warmupExecutor.execute(pluginId, toolName, args, credentials, signal),
  }),
});
let jobRunner: JobRunner | undefined;
let jobPins: CredentialPinStore | undefined;
try {
  jobPins = new CredentialPinStore();
  jobRunner = createJobRunner({
    ledger,
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
    }),
    // Phase 4, Wave B: the shared in-memory tool-result cache so a repeated
    // read-only tool call is never executed twice across sync and async.
    toolCache,
    budget: chatBudget,
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
app.route("/v1", createSessionRoutes({ store: sessionStore, verifyKey: requireApiKey }));
app.route(
  "/v1",
  createChatRoutes({
    registry: pluginRegistry,
    pluginStore,
    catalogs,
    sessionStore,
    ledger,
    jobRunner,
    pins: jobPins,
    toolCache,
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    rateLimiter: chatRateLimiter,
    budget: chatBudget,
    warmups,
  }),
);

app.get("/", (c) =>
  c.json({
    name: "ai-assistant-gateway",
    auth: "/api/auth",
    inference: "/v1/chat/completions",
    ledger: "/ledger",
    sessions: "/v1/sessions",
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
  // Close the ledger DB once no request can touch it anymore.
  cleanup("ledger", () => ledger.close());
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);