import { createRequire } from "node:module";
import { Hono } from "hono";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** A single reachability probe. Throws (sync or async) to signal failure. */
export type HealthCheck = () => void | Promise<void>;

export type HealthChecks = {
  authDb: HealthCheck;
  ledgerDb: HealthCheck;
};

// Default probes lazily import the live handles (same pattern as auth.ts's
// deletion hook): a static import would open BOTH databases for every importer
// of health.ts — including tests that only inject fake checks, and the
// production integration test's module-mock surface (its mocks apply only to
// index.ts's direct imports).
async function probeAuthDb(): Promise<void> {
  const { authDb } = await import("./auth.ts");
  authDb.prepare("SELECT 1").get();
}

async function probeLedgerDb(): Promise<void> {
  // `Ledger.getTask` is a primary-key SELECT on the SHARED ledger handle —
  // reachability without opening a second connection (ledger.db's raw handle
  // is not exported; the exported `ledger` instance is the existing seam).
  const { ledger } = await import("./ledger.routes.ts");
  ledger.getTask("health-probe");
}

/**
 * M5 watchdog — `GET /health`, UNAUTHENTICATED (k8s probes cannot auth).
 *
 * Response contract (probe surface; keep stable):
 * {
 *   status:  "ok" | "degraded",          // "ok" iff every check passed
 *   version: string,                     // server/package.json version
 *   uptime:  number,                     // process uptime, seconds
 *   checks: {
 *     authDb:  "ok" | "error",           // better-auth SQLite reachability
 *     ledgerDb: "ok" | "error",          // ledger SQLite reachability
 *   },
 * }
 * HTTP 200 when status is "ok"; 503 when "degraded" — k8s liveness/readiness
 * treat any non-2xx as failure. A thrown check becomes `"error"` in `checks`,
 * never a 500. Dropped per scope: SLA, incident alerts, runbooks, clock-skew.
 *
 * `overrides` replaces individual checks (test injection seam); omitted checks
 * default to the live probes above.
 */
export function createHealthRoutes(
  overrides: Partial<HealthChecks> = {},
): Hono {
  const active: HealthChecks = {
    authDb: overrides.authDb ?? probeAuthDb,
    ledgerDb: overrides.ledgerDb ?? probeLedgerDb,
  };
  const run = async (check: HealthCheck): Promise<"ok" | "error"> => {
    try {
      await check();
      return "ok";
    } catch {
      // Deliberately silent: the degraded status is the signal, and k8s
      // re-probes every few seconds — logging each tick would spam the log
      // for the whole outage.
      return "error";
    }
  };
  const app = new Hono();
  app.get("/health", async (c) => {
    const [authDb, ledgerDb] = await Promise.all([
      run(active.authDb),
      run(active.ledgerDb),
    ]);
    const checks = { authDb, ledgerDb };
    const status = authDb === "ok" && ledgerDb === "ok" ? "ok" : "degraded";
    return c.json(
      { status, version, uptime: process.uptime(), checks },
      status === "ok" ? 200 : 503,
    );
  });
  return app;
}
