import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { createCheckpointRoutes } from "./checkpoints/routes.ts";
import { createCheckpointStore } from "./checkpoints/store.ts";
import type { CheckpointStore } from "./checkpoints/store.ts";
import { CredentialPinStore } from "./credentials/pins.ts";
import { env } from "./env.ts";
import { inferenceRoutes } from "./inference.ts";
import { createJobRunner } from "./jobs/runner.ts";
import type { JobRunner } from "./jobs/runner.ts";
import { ledgerRoutes, ledger } from "./ledger.routes.ts";
import { createPluginWiring } from "./plugins/index.ts";
import { createPluginRoutes } from "./plugins/routes.ts";

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

// Async job runner (Phase 2, Wave C1). Constructed GUARDED: background jobs
// are not wired into the HTTP transport yet (Phase 3), so boot must never fail
// because a dep is unavailable. The in-memory pin store starts empty — Phase 5
// pins credentials at admission; `buildModel` (model plugin resolution) and
// `credentialSource` (restart re-pin) are Phase 3/5 seams.
let jobRunner: JobRunner | undefined;
try {
  if (checkpointStore) {
    jobRunner = createJobRunner({
      ledger,
      registry: pluginRegistry,
      pins: new CredentialPinStore(),
      checkpointer: checkpointStore.checkpointer,
      getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
      // H1: the executor's call-time validatedFetch re-resolution must apply
      // the SAME trusted-hosts policy the pins were computed under, or an
      // admin-trusted internal plugin backend (`*.local`, RFC1918) would be
      // rejected as DNS_REBINDING on every tool call.
      trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
      // M1: record owner→thread metadata so the /v1/threads surface works.
      touchThread: checkpointStore.touchThread.bind(checkpointStore),
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