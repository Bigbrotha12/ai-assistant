import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { Ledger, migrateLedger } from "../src/ledger.ts";
import { createLedgerRoutes } from "../src/ledger.routes.ts";
import type { VerifyApiKeyFn } from "../src/plugins/routes.ts";

/**
 * Build the ledger app the way src/index.ts does (`app.route("/ledger", ...)`)
 * but with the auth verifier swapped for a deterministic stub, so tests
 * exercise the full HTTP surface without better-auth's DB — mirroring the
 * plugin routes' `verifyKey` seam.
 */
function makeApp(verifyKey?: VerifyApiKeyFn): {
  app: Hono;
  db: Database.Database;
  ledger: Ledger;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new Ledger(db);
  const app = new Hono();
  app.route(
    "/ledger",
    createLedgerRoutes(ledger, {
      verifyKey: verifyKey ?? (async () => "user-1"),
    }),
  );
  return { app, db, ledger };
}

const auth = {
  authorization: "Bearer test-key",
  "content-type": "application/json",
};

async function createTask(
  app: Hono,
  intentKey: string,
): Promise<{ id: string }> {
  const res = await app.request("/ledger/tasks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ intentKey, spec: {} }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

describe("ledger routes — status by idempotency key", () => {
  test("the owning user fetches their task by intent key", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "msg-abc");

    const res = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      owner: string;
      intent_key: string;
      status: string;
    };
    assert.equal(body.id, created.id);
    assert.equal(body.owner, "user-1");
    assert.equal(body.intent_key, "msg-abc");
    assert.equal(body.status, "queued");
  });

  test("cross-owner lookup -> 404 (IDOR: another tenant's key is a miss)", async () => {
    const { app, ledger } = makeApp();
    await createTask(app, "msg-secret");

    const intruder = new Hono();
    intruder.route(
      "/ledger",
      createLedgerRoutes(ledger, { verifyKey: async () => "intruder" }),
    );
    const res = await intruder.request("/ledger/tasks/by-key/msg-secret", {
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("unknown intent key -> 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/ledger/tasks/by-key/never-sent", {
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("401 without a valid key", async () => {
    const { app } = makeApp(async () => null);
    const res = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("the existing /ledger/tasks/:id surface still works alongside by-key", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "msg-abc");

    const byKey = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(byKey.status, 200);

    const byId = await app.request(`/ledger/tasks/${created.id}`, {
      headers: auth,
    });
    assert.equal(byId.status, 200);
    const body = (await byId.json()) as { id: string };
    assert.equal(body.id, created.id);
  });
});