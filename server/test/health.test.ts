import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Hono } from "hono";
import { createHealthRoutes } from "../src/health.ts";

const require = createRequire(import.meta.url);
const pkgVersion = (require("../package.json") as { version: string }).version;

type HealthBody = {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  checks: { authDb: "ok" | "error"; ledgerDb: "ok" | "error" };
};

async function getHealth(
  app: Hono,
): Promise<{ status: number; body: HealthBody }> {
  const res = await app.fetch(new Request("http://localhost:17600/health"));
  return { status: res.status, body: (await res.json()) as HealthBody };
}

test("healthy: default checks pass against the live handles -> 200 probe payload", async () => {
  // No overrides: the lazy default probes run `SELECT 1` on authDb and a PK
  // lookup through the shared ledger handle (no second connection).
  const { status, body } = await getHealth(createHealthRoutes());
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.version, pkgVersion);
  assert.equal(typeof body.uptime, "number");
  assert.ok(body.uptime >= 0);
  assert.deepEqual(body.checks, { authDb: "ok", ledgerDb: "ok" });
  // Exact probe contract — no stray fields.
  assert.deepEqual(Object.keys(body).sort(), [
    "checks",
    "status",
    "uptime",
    "version",
  ]);
});

test("degraded: a failing check -> 503 with that check reported as error", async () => {
  const { status, body } = await getHealth(
    createHealthRoutes({
      authDb: () => {
        throw new Error("auth db unreachable");
      },
      ledgerDb: () => {},
    }),
  );
  assert.equal(status, 503);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, { authDb: "error", ledgerDb: "ok" });
  // The rest of the contract stays intact on the degraded path.
  assert.equal(body.version, pkgVersion);
  assert.equal(typeof body.uptime, "number");
});

test("never-throw: failing checks yield the degraded JSON response, not a 500", async () => {
  const { status, body } = await getHealth(
    createHealthRoutes({
      authDb: () => {
        throw new Error("boom");
      },
      ledgerDb: async () => {
        throw new Error("async boom");
      },
    }),
  );
  assert.notEqual(status, 500);
  assert.equal(status, 503);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, { authDb: "error", ledgerDb: "error" });
});
