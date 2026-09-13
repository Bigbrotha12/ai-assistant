import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { createCheckpointRoutes } from "./checkpoints/routes.ts";
import { createCheckpointStore } from "./checkpoints/store.ts";
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
const checkpointStore = await createCheckpointStore({
  dbPath: env.CHECKPOINT_DB_PATH,
  dbKey: env.CHECKPOINT_DB_KEY,
});
app.route("/v1", createCheckpointRoutes({ store: checkpointStore }));

// Async job runner (Phase 2, Wave C1). Constructed GUARDED: background jobs
// are not wired into the HTTP transport yet (Phase 3), so boot must never fail
// because a dep is unavailable. The in-memory pin store starts empty — Phase 5
// pins credentials at admission; `buildModel` (model plugin resolution) and
// `credentialSource` (restart re-pin) are Phase 3/5 seams.
let jobRunner: JobRunner | undefined;
try {
  jobRunner = createJobRunner({
    ledger,
    registry: pluginRegistry,
    pins: new CredentialPinStore(),
    checkpointer: checkpointStore.checkpointer,
    getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
  });
  // Restart-loss startup pass: `ledger.reconcileOrphans()` (ledger.routes.ts)
  // already marked orphans `stuck`; resumeStuckJobs fails them cleanly with
  // credentials_expired when pins can't be re-established (no vault yet).
  await jobRunner.resumeStuckJobs();
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