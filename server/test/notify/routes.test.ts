import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  clearDeleting,
  markDeleting,
  withOwnerBarrier,
} from "../../src/account_deletion.ts";
import { NotifyStore } from "../../src/notify/store.ts";
import { createNotifyRoutes } from "../../src/notify/routes.ts";
import type { VerifyApiKeyFn } from "../../src/notify/routes.ts";

const TEST_KEY = "test-key-0123456789abcdef";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Auth stub mirroring `requireApiKey`: key-a → user-a, key-b → user-b,
 * anything else → `bad_key` (401).
 */
function makeVerifyKey(): VerifyApiKeyFn {
  return async (c) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match ? match[1]!.trim() : "";
    const owners: Record<string, string> = { "key-a": "user-a", "key-b": "user-b" };
    const owner = owners[token];
    return owner
      ? ({ ok: true, owner } as const)
      : ({ ok: false, reason: "bad_key" } as const);
  };
}

async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
): Promise<{ app: Hono; store: NotifyStore }> {
  const dir = await mkdtemp(join(tmpdir(), "notify-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new NotifyStore({ storePath: join(dir, "notify.json"), key: TEST_KEY });
  const app = new Hono();
  app.route(
    "/api/notify",
    createNotifyRoutes({ store, verifyKey: verifyKey ?? makeVerifyKey() }),
  );
  return { app, store };
}

async function provision(app: Hono): Promise<{ topic: string; accessToken: string }> {
  const res = await app.request("/api/notify/provision", {
    method: "POST",
    headers: { authorization: "Bearer key-a" },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { topic: string; accessToken: string };
}

const authA = { authorization: "Bearer key-a" };
const authB = { authorization: "Bearer key-b" };

describe("notify routes — lifecycle", () => {
  test("provision returns { topic, accessToken } with newlyProvisioned:true on first call", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/api/notify/provision", { method: "POST", headers: authA });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      topic: string;
      accessToken: string;
      newlyProvisioned: boolean;
    };
    assert.match(json.topic, /^assistant-user-a-[0-9a-f]{16}$/);
    assert.ok(json.accessToken.length >= 24, "token must carry ~192 bits");
    assert.equal(json.newlyProvisioned, true);
  });

  test("second provision returns the same topic, a null token, newlyProvisioned:false", async (t) => {
    const { app } = await makeApp(t);
    const first = await provision(app);
    const res = await app.request("/api/notify/provision", { method: "POST", headers: authA });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      topic: string;
      accessToken: string | null;
      newlyProvisioned: boolean;
    };
    assert.equal(json.topic, first.topic, "topic must be stable across provisions");
    assert.equal(json.accessToken, null, "the token is revealed exactly once");
    assert.equal(json.newlyProvisioned, false);
  });

  test("GET /provision is 404 until configured, then exposes topic + null token", async (t) => {
    const { app } = await makeApp(t);
    const missing = await app.request("/api/notify/provision", { headers: authA });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_configured" });

    const first = await provision(app);
    const res = await app.request("/api/notify/provision", { headers: authA });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      topic: string;
      accessToken: string | null;
      newlyProvisioned: boolean;
    };
    assert.equal(json.topic, first.topic);
    assert.equal(json.accessToken, null);
    assert.equal(json.newlyProvisioned, false);
  });

  test("rotate returns the same topic and a NEW token", async (t) => {
    const { app } = await makeApp(t);
    const first = await provision(app);
    const res = await app.request("/api/notify/rotate", { method: "POST", headers: authA });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      topic: string;
      accessToken: string;
      rotated: boolean;
    };
    assert.equal(json.topic, first.topic, "rotate keeps the same topic");
    assert.notEqual(json.accessToken, first.accessToken, "rotate mints a fresh token");
    assert.equal(json.rotated, true);
  });

  test("rotate before provision → 404 not_configured", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/api/notify/rotate", { method: "POST", headers: authA });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_configured" });
  });

  test("revoke then provision creates a brand-new topic", async (t) => {
    const { app } = await makeApp(t);
    const first = await provision(app);
    const revoke = await app.request("/api/notify/revoke", { method: "POST", headers: authA });
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), { revoked: true });

    const second = await provision(app);
    assert.notEqual(second.topic, first.topic, "revoked owners get a fresh topic");
  });

  test("owners are isolated: A's provision never leaks to B", async (t) => {
    const { app } = await makeApp(t);
    const asA = await provision(app);
    const resB = await app.request("/api/notify/provision", { method: "POST", headers: authB });
    assert.equal(resB.status, 200);
    const jsonB = (await resB.json()) as { topic: string; newlyProvisioned: boolean };
    assert.notEqual(jsonB.topic, asA.topic);
    assert.equal(jsonB.newlyProvisioned, true);
  });
});

describe("notify routes — auth", () => {
  test("unauthenticated (owner resolver → bad_key) → 401 on every endpoint", async (t) => {
    const { app } = await makeApp(t, async () => ({ ok: false as const, reason: "bad_key" as const }));
    const cases: Array<[string, string]> = [
      ["POST", "/api/notify/provision"],
      ["GET", "/api/notify/provision"],
      ["POST", "/api/notify/rotate"],
      ["POST", "/api/notify/revoke"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: authA });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "unauthorized" }, `${method} ${path}`);
    }
  });

  test("valid key but the owner's email is unverified → 403 email_not_verified on every endpoint", async (t) => {
    const { app } = await makeApp(t, async () => ({
      ok: false as const,
      reason: "email_not_verified" as const,
    }));
    const cases: Array<[string, string]> = [
      ["POST", "/api/notify/provision"],
      ["GET", "/api/notify/provision"],
      ["POST", "/api/notify/rotate"],
      ["POST", "/api/notify/revoke"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: authA });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "email_not_verified" }, `${method} ${path}`);
    }
  });

  test("an admitted key whose owner starts deleting is rejected with 403 account_deleted", async (t) => {
    const { app } = await makeApp(t);
    markDeleting("user-a");
    try {
      const res = await app.request("/api/notify/provision", {
        method: "POST",
        headers: authA,
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "account_deleted" });
    } finally {
      clearDeleting("user-a");
    }
  });

  test("an unknown/other key → 401", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/api/notify/provision", {
      method: "POST",
      headers: { authorization: "Bearer some-other-key" },
    });
    assert.equal(res.status, 401);
  });
});

describe("notify store — encryption at rest", () => {
  test("the on-disk file never contains the raw topic or token", async (t) => {
    const { app, store } = await makeApp(t);
    const { topic, accessToken } = await provision(app);

    const raw = await readFile(store.path, "utf8");
    assert.equal(raw.includes(accessToken), false, "plaintext token must not leak");
    assert.equal(raw.includes(topic), false, "plaintext topic must not leak");

    // The file must still be parseable JSON carrying an AES-256-GCM bundle
    // (iv/tag/data) per owner — not a scrambled write.
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      accounts: Record<string, { credentials: { iv: string; tag: string; data: string } }>;
    };
    assert.equal(parsed.schemaVersion, 1);
    const account = parsed.accounts["user-a"];
    assert.ok(account, "owner record must exist");
    assert.ok(account.credentials.iv && account.credentials.tag && account.credentials.data);
  });

  test("delete of a missing owner is a no-op false", async (t) => {
    const { store } = await makeApp(t);
    assert.equal(await store.delete("ghost-owner"), false);
  });
});

describe("notify store — serialized mutations", () => {
  test("concurrent set/delete for different owners preserves both changes", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "notify-race-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "notify.json");
    const seed = new NotifyStore({ storePath: path, key: TEST_KEY });
    await seed.set("owner-a", { topic: "topic-a-old", accessToken: "token-a-old" });
    await seed.set("owner-b", { topic: "topic-b-old", accessToken: "token-b-old" });

    const renameStarted = deferred();
    const releaseRename = deferred();
    let armed = false;
    let delayed = false;
    const store = new NotifyStore({
      storePath: path,
      key: TEST_KEY,
      renameFile: async (oldPath, newPath) => {
        if (armed && !delayed) {
          delayed = true;
          renameStarted.resolve();
          await releaseRename.promise;
        }
        await rename(oldPath, newPath);
      },
    });
    await store.get("owner-a");
    await store.get("owner-b");
    armed = true;

    const updateA = store.set("owner-a", {
      topic: "topic-a-new",
      accessToken: "token-a-new",
    });
    await renameStarted.promise;
    const deleteB = store.delete("owner-b");
    releaseRename.resolve();
    await Promise.all([updateA, deleteB]);

    assert.equal((await store.get("owner-a"))?.topic, "topic-a-new");
    assert.equal(await store.get("owner-b"), undefined);
    const fresh = new NotifyStore({ storePath: path, key: TEST_KEY });
    assert.equal((await fresh.get("owner-a"))?.topic, "topic-a-new");
    assert.equal(await fresh.get("owner-b"), undefined);
  });

  test("a failed mid-save keeps the prior snapshot and a retry merges from it", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "notify-failure-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "notify.json");
    const seed = new NotifyStore({ storePath: path, key: TEST_KEY });
    await seed.set("owner-a", { topic: "topic-a-old", accessToken: "token-a-old" });
    await seed.set("owner-b", { topic: "topic-b-old", accessToken: "token-b-old" });

    let failNextRename = true;
    const store = new NotifyStore({
      storePath: path,
      key: TEST_KEY,
      renameFile: async (oldPath, newPath) => {
        if (failNextRename) {
          failNextRename = false;
          throw new Error("injected rename failure");
        }
        await rename(oldPath, newPath);
      },
    });
    await store.get("owner-a");
    await store.get("owner-b");

    await assert.rejects(
      store.set("owner-a", {
        topic: "topic-a-failed",
        accessToken: "token-a-failed",
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "FILE_IO",
    );
    assert.equal((await store.get("owner-a"))?.topic, "topic-a-old");
    assert.equal((await store.get("owner-b"))?.topic, "topic-b-old");

    await store.set("owner-a", {
      topic: "topic-a-retry",
      accessToken: "token-a-retry",
    });
    await store.delete("owner-b");
    const fresh = new NotifyStore({ storePath: path, key: TEST_KEY });
    assert.equal((await fresh.get("owner-a"))?.topic, "topic-a-retry");
    assert.equal(await fresh.get("owner-b"), undefined);
  });
});

describe("notify routes — owner deletion barrier", () => {
  test("a mutation admitted before deletion finishes its write before the purge", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "notify-barrier-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "notify.json");
    const renameStarted = deferred();
    const releaseRename = deferred();
    let delayed = false;
    const store = new NotifyStore({
      storePath: path,
      key: TEST_KEY,
      renameFile: async (oldPath, newPath) => {
        if (!delayed) {
          delayed = true;
          renameStarted.resolve();
          await releaseRename.promise;
        }
        await rename(oldPath, newPath);
      },
    });
    const app = new Hono();
    app.route(
      "/api/notify",
      createNotifyRoutes({ store, verifyKey: makeVerifyKey() }),
    );

    try {
      const responsePromise = app.request("/api/notify/provision", {
        method: "POST",
        headers: authA,
      });
      await renameStarted.promise;
      markDeleting("user-a");
      let purgeFinished = false;
      const purgePromise = withOwnerBarrier("user-a", async () => {
        const deleted = await store.delete("user-a");
        purgeFinished = true;
        return deleted;
      });
      await Promise.resolve();
      assert.equal(purgeFinished, false, "purge must wait for the admitted mutation");
      releaseRename.resolve();

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.equal(await purgePromise, true);
      assert.equal(purgeFinished, true);
      const fresh = new NotifyStore({ storePath: path, key: TEST_KEY });
      assert.equal(await fresh.get("user-a"), undefined);
    } finally {
      releaseRename.resolve();
      clearDeleting("user-a");
    }
  });

  test("a mutation starting after mark waits for the purge and is rejected", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "notify-barrier-after-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "notify.json");
    const seed = new NotifyStore({ storePath: path, key: TEST_KEY });
    await seed.set("user-a", { topic: "topic-old", accessToken: "token-old" });
    const renameStarted = deferred();
    const releaseRename = deferred();
    let delayed = false;
    const store = new NotifyStore({
      storePath: path,
      key: TEST_KEY,
      renameFile: async (oldPath, newPath) => {
        if (!delayed) {
          delayed = true;
          renameStarted.resolve();
          await releaseRename.promise;
        }
        await rename(oldPath, newPath);
      },
    });
    await store.get("user-a");
    const app = new Hono();
    app.route(
      "/api/notify",
      createNotifyRoutes({ store, verifyKey: makeVerifyKey() }),
    );

    markDeleting("user-a");
    try {
      const purgePromise = withOwnerBarrier("user-a", () => store.delete("user-a"));
      await renameStarted.promise;
      const responsePromise = app.request("/api/notify/provision", {
        method: "POST",
        headers: authA,
      });
      releaseRename.resolve();

      assert.equal(await purgePromise, true);
      const response = await responsePromise;
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "account_deleted" });
      const fresh = new NotifyStore({ storePath: path, key: TEST_KEY });
      assert.equal(await fresh.get("user-a"), undefined);
    } finally {
      releaseRename.resolve();
      clearDeleting("user-a");
    }
  });
});
