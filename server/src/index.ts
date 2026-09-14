import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { createCheckpointRoutes } from "./checkpoints/routes.ts";
import { createCheckpointStore } from "./checkpoints/store.ts";
import type { CheckpointStore } from "./checkpoints/store.ts";
import { CredentialPinStore } from "./credentials/pins.ts";
import { env } from "./env.ts";
import { inferenceRoutes } from "./inference.ts";
import { createJobRunner, JobError } from "./jobs/runner.ts";
import type { JobRunner } from "./jobs/runner.ts";
import { ThreadLockRegistry } from "./jobs/thread_lock.ts";
import { ledgerRoutes, ledger } from "./ledger.routes.ts";
import { createPluginWiring } from "./plugins/index.ts";
import { createPluginRoutes } from "./plugins/routes.ts";
import { createModelsRoutes } from "./transport/models.ts";
import { createChatRoutes } from "./transport/chat.ts";
import type { JobModelRequestConfig } from "./transport/chat.ts";
import { buildModel } from "./transport/model.ts";
import { createBudgetManager } from "./middleware/budget.ts";
import { createPerOwnerRateLimiter } from "./middleware/rate_limit.ts";

const app = new Hono();

app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/v1", inferenceRoutes);
app.route("/ledger", ledgerRoutes);

const { registry: pluginRegistry, store: pluginStore } = createPluginWiring();
await pluginStore.load();
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

// Durable, encrypted conversation checkpoints (Phase 2, Wave B1). The store
// opens the SQLCipher-keyed SQLite file at CHECKPOINT_DB_PATH; the transport
// (Wave C1) compiles the agent graph over `checkpointStore.checkpointer`.
//
// M3: boot is GUARDED — a corrupt file or wrong key must not take down auth,
// inference, or the plugin surface. On failure we log a clear error and
// continue WITHOUT checkpoints (graceful degradation; the transport handles
// "no checkpointer available" in Phase 3). Fail-fast for a MISSING key in
// production stays at the env layer (env.ts), which is unchanged.
let checkpointStore: CheckpointStore | undefined;
try {
  checkpointStore = await createCheckpointStore({
    dbPath: env.CHECKPOINT_DB_PATH,
    dbKey: env.CHECKPOINT_DB_KEY,
  });
} catch (err) {
  console.error(
    "gateway: checkpoint store unavailable (corrupt file / wrong key?); " +
      "continuing WITHOUT conversation checkpoints:",
    err,
  );
}
if (checkpointStore) {
  app.route("/v1", createCheckpointRoutes({ store: checkpointStore }));
}

// Phase 3, Wave C2: the async background path and the sync stream share ONE
// per-thread lock registry and ONE credential pin store. The chat transport
// needs both, so the job runner (which owns the pin lifecycle) is constructed
// BEFORE the chat routes are mounted.
let jobRunner: JobRunner | undefined;
let jobPins: CredentialPinStore | undefined;
const threadLocks = new ThreadLockRegistry();
try {
  if (checkpointStore) {
    jobPins = new CredentialPinStore();
    jobRunner = createJobRunner({
      ledger,
      registry: pluginRegistry,
      pins: jobPins,
      checkpointer: checkpointStore.checkpointer,
      getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
      // H1: the executor's call-time validatedFetch re-resolution must apply
      // the SAME trusted-hosts policy the pins were computed under, or an
      // admin-trusted internal plugin backend (`*.local`, RFC1918) would be
      // rejected as DNS_REBINDING on every tool call.
      trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
      // M1: record owner→thread metadata so the /v1/threads surface works.
      touchThread: checkpointStore.touchThread.bind(checkpointStore),
      // Wave C2: one lock authority for every checkpoint-thread writer, shared
      // with the sync transport below.
      threadLocks,
      // M1: periodic credential-pin GC. In-memory pins are released by the
      // runner's finally / the transport's non-claimed-path releases, but a
      // crash between admission and claim could still leak one; a periodic
      // sweep bounds that window instead of relying on the release paths alone.
      sweepIntervalMs: 60_000,
      // The model-build seam (Wave C2): the async path pins the model-plugin
      // credential at admission; this closure resolves the owner-scoped pin and
      // builds the model exactly like the sync path (same plugin + request
      // overrides + trusted-hosts SSRF policy). The request config carries the
      // owner + overrides — never credential values (pins are the only channel).
      buildModel: (modelPluginId, requestConfig) => {
        const cfg = requestConfig as JobModelRequestConfig | undefined;
        if (!cfg || !jobPins) {
          throw new JobError(
            "plugin_unavailable",
            "no pinned credential source is wired for background model builds",
          );
        }
        // Throws `credentials_expired` when the pin is missing/expired (the
        // runner maps it to a failed job before any graph invoke).
        const pin = jobPins.get(cfg.owner, modelPluginId);
        return buildModel({
          registry: pluginRegistry,
          pluginStore,
          modelPluginId,
          requestModel: cfg.requestModel,
          requestParameters: cfg.requestParameters,
          credentials: pin.credentials,
          trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
        });
      },
    });
    // Restart-loss startup pass: `ledger.reconcileOrphans()` (ledger.routes.ts)
    // already marked orphans `stuck`; resumeStuckJobs fails them cleanly with
    // credentials_expired when pins can't be re-established (no vault yet).
    await jobRunner.resumeStuckJobs();
  } else {
    console.warn("jobs: no checkpointer available; background jobs disabled");
  }
} catch (err) {
  console.warn("jobs: JobRunner unavailable; background jobs disabled:", err);
}

// Phase 3, Wave C1/C2: `POST /v1/chat/completions` is the LangChain transport
// (`src/transport/chat.ts`) — model built from the MODEL plugin + per-request
// credentials, agent graph streamed via the SSE adapter (sync), or admitted as
// an idempotent background job (async, `background: true`). The checkpoint
// store is optional: if boot degraded (corrupt DB / wrong key), every run is
// STATELESS and async delegation returns 503 background_unavailable.
//
// Phase 4, Wave A middleware (per-owner gates): the rate limiter reuses the
// existing INFERENCE_RATE_LIMIT / INFERENCE_RATE_BURST knobs as PER-OWNER
// values (the bucket key is the authenticated user id, not the API key), and
// the budget caps concurrent in-flight chat operations per owner.
const chatRateLimiter = createPerOwnerRateLimiter({
  ratePerMinute: env.INFERENCE_RATE_LIMIT,
  burst: env.INFERENCE_RATE_BURST,
});
const chatBudget = createBudgetManager({
  maxConcurrentPerUser: env.BUDGET_MAX_CONCURRENT,
  queueMaxPerUser: env.BUDGET_QUEUE_MAX,
});
app.route(
  "/v1",
  createChatRoutes({
    registry: pluginRegistry,
    pluginStore,
    checkpointStore,
    ledger,
    jobRunner,
    pins: jobPins,
    threadLocks,
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    rateLimiter: chatRateLimiter,
    budget: chatBudget,
  }),
);

app.get("/", (c) =>
  c.json({
    name: "ai-assistant-gateway",
    auth: "/api/auth",
    inference: "/v1/chat/completions",
    ledger: "/ledger",
    threads: "/v1/threads",
  }),
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`ai-assistant gateway listening on http://localhost:${info.port}`);
});