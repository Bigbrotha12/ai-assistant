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

  test("M2: POST /ledger/tasks with a duplicate intentKey returns the existing task (200, same id) — no 500", async () => {
    const { app } = makeApp();
    const first = await createTask(app, "dup-key");

    const res = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ intentKey: "dup-key", spec: { x: 1 } }),
    });
    assert.equal(res.status, 200, "a repeat must not 500 on the unique index");
    const body = (await res.json()) as { id: string };
    assert.equal(body.id, first.id, "the SAME task id must be returned");
  });

  test("M2: the duplicate is owner-scoped — another owner's duplicate is a fresh task", async () => {
    const { app, ledger } = makeApp();
    await createTask(app, "scope-key");

    const other = new Hono();
    other.route(
      "/ledger",
      createLedgerRoutes(ledger, { verifyKey: async () => "user-2" }),
    );
    const res = await other.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ intentKey: "scope-key", spec: {} }),
    });
    assert.equal(res.status, 201, "a different owner gets their own task");
  });
});

describe("ledger routes — fence enforcement on running tasks (M8)", () => {
  async function claimTask(app: Hono, taskId: string): Promise<string> {
    const res = await app.request(`/ledger/tasks/${taskId}/claim`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { fence_token: string }).fence_token;
  }

  test("heartbeat without a fence token on a running task → 403 fence_conflict", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "fence-hb");
    const fence = await claimTask(app, created.id);

    const res = await app.request(`/ledger/tasks/${created.id}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "fence_conflict" });

    const ok = await app.request(`/ledger/tasks/${created.id}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ fenceToken: fence }),
    });
    assert.equal(ok.status, 200, "with the fence token the heartbeat works");
  });

  test("appendStep without a fence token on a running task → 403 fence_conflict", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "fence-steps");
    const fence = await claimTask(app, created.id);

    const res = await app.request(`/ledger/tasks/${created.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stage: "tool", action: "A", result: "r" }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "fence_conflict" });

    const ok = await app.request(`/ledger/tasks/${created.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        stage: "tool",
        action: "A",
        result: "r",
        fenceToken: fence,
      }),
    });
    assert.equal(ok.status, 201, "with the fence token the step appends");
  });

  test("a non-running task (queued/terminal) is not fence-gated", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "fence-queued");

    // Queued task: heartbeat without a fence still fails as a transition
    // error (409 invalid_transition), NOT a fence gate — the fence check only
    // applies to running tasks.
    const res = await app.request(`/ledger/tasks/${created.id}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409, "queued heartbeat is a transition error, not a fence conflict");
  });
});