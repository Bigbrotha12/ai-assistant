import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { NotifyStore } from "../../src/notify/store.ts";
import { createNotifyRoutes } from "../../src/notify/routes.ts";
import type { VerifyApiKeyFn } from "../../src/notify/routes.ts";

const TEST_KEY = "test-key-0123456789abcdef";

/**
 * Auth stub mirroring `requireApiKey`: key-a → user-a, key-b → user-b,
 * anything else → null (401).
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
  test("unauthenticated (owner resolver → null) → 401 on every endpoint", async (t) => {
    const { app } = await makeApp(t, async () => null);
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