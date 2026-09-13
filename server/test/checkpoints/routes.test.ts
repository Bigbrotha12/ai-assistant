import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createCheckpointStore } from "../../src/checkpoints/store.ts";
import type { CheckpointStore } from "../../src/checkpoints/store.ts";
import { createCheckpointRoutes } from "../../src/checkpoints/routes.ts";
import type { VerifyApiKeyFn } from "../../src/checkpoints/routes.ts";

const TEST_KEY = "test-key-0123456789abcdef";

/**
 * Auth stub mirroring `requireApiKey`: the referenceId is derived from the
 * bearer token — `key-a` → `user-a`, `key-b` → `user-b`, anything else → null
 * (401). Lets the ownership tests act as distinct callers over HTTP.
 */
function makeVerifyKey(): VerifyApiKeyFn {
  return async (c) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match ? match[1]!.trim() : "";
    const owners: Record<string, string> = { "key-a": "user-a", "key-b": "user-b" };
    return owners[token] ?? null;
  };
}

async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
): Promise<{ app: Hono; store: CheckpointStore }> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-routes-"));
  const store = await createCheckpointStore({
    dbPath: join(dir, "checkpoints.db"),
    dbKey: TEST_KEY,
  });
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const app = new Hono();
  app.route(
    "/v1",
    createCheckpointRoutes({ store, verifyKey: verifyKey ?? makeVerifyKey() }),
  );
  return { app, store };
}

const authA = { authorization: "Bearer key-a" };
const authB = { authorization: "Bearer key-b" };

describe("checkpoint routes — auth", () => {
  test("every endpoint → 401 unauthorized without a valid key", async (t) => {
    const { app } = await makeApp(t, async () => null);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/threads"],
      ["DELETE", "/v1/threads"],
      ["DELETE", "/v1/threads/some-thread"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: authA });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "unauthorized" }, `${method} ${path}`);
    }
  });

  test("an unknown/other key → 401", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/threads", {
      headers: { authorization: "Bearer some-other-key" },
    });
    assert.equal(res.status, 401);
  });
});

describe("checkpoint routes — list", () => {
  test("GET /v1/threads returns only the caller's threads", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", "thr-a1");
    store.touchThread("user-a", "thr-a2");
    store.touchThread("user-b", "thr-b1");

    const asA = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: Array<{ threadId: string; messageCount: number }>;
    };
    assert.deepEqual(
      asA.threads.map((x) => x.threadId).sort(),
      ["thr-a1", "thr-a2"],
    );

    const asB = (await (await app.request("/v1/threads", { headers: authB })).json()) as {
      threads: Array<{ threadId: string }>;
    };
    assert.deepEqual(asB.threads.map((x) => x.threadId), ["thr-b1"]);
  });
});

describe("checkpoint routes — delete one", () => {
  test("DELETE /v1/threads/:id deletes the caller's thread → 200 ok", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", "thr-a1");

    const res = await app.request("/v1/threads/thr-a1", { method: "DELETE", headers: authA });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
    assert.equal(store.getThread("thr-a1"), undefined);
  });

  test("cross-owner delete is a 404, never a successful delete", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-b", "thr-b1");

    const res = await app.request("/v1/threads/thr-b1", { method: "DELETE", headers: authA });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
    assert.equal(store.getThread("thr-b1")?.owner, "user-b", "thread must survive");
  });

  test("unknown thread → 404 not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/threads/ghost-thread", {
      method: "DELETE",
      headers: authA,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });
});

describe("checkpoint routes — per-user GC", () => {
  test("DELETE /v1/threads removes ALL of the caller's threads → { deleted: N }", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", "thr-a1");
    store.touchThread("user-a", "thr-a2");
    store.touchThread("user-a", "thr-a3");
    store.touchThread("user-b", "thr-b1");

    const res = await app.request("/v1/threads", { method: "DELETE", headers: authA });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 3 });

    const asA = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: unknown[];
    };
    assert.equal(asA.threads.length, 0);
    assert.equal(store.getThread("thr-b1") !== undefined, true, "other owners survive GC");
  });
});