import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import {
  clearDeleting,
  isDeleting,
  markDeleting,
} from "../src/account_deletion.ts";
import {
  API_KEY_PLUGIN_OPTIONS,
  createAccountDeletionHooks,
} from "../src/auth.ts";
import { createApiKeyEmailVerificationGate } from "../src/verify_email.ts";

const BASE = "http://localhost:17600";
const SECRET = "test-secret-at-least-thirty-two-characters";
const PASSWORD = "password-123";

type JsonResult = {
  status: number;
  data: unknown;
  cookies: string;
};

type BuildFixtureOptions = {
  beforeKeyInsert?: () => Promise<void>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("condition was not reached");
}

async function buildFixture(options: BuildFixtureOptions = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "api-key-gate-test-")), "test.db");
  const database = new Database(dbPath);
  const deletionHooks = createAccountDeletionHooks({ db: database });
  const apiKeyOptions = options.beforeKeyInsert
    ? {
        ...API_KEY_PLUGIN_OPTIONS,
        customKeyGenerator: async ({ length, prefix }: { length: number; prefix?: string }) => {
          await options.beforeKeyInsert?.();
          return `${prefix ?? "sk"}_${"k".repeat(length)}`;
        },
      }
    : API_KEY_PLUGIN_OPTIONS;
  const config = {
    appName: "AI Assistant",
    secret: SECRET,
    baseURL: BASE,
    basePath: "/api/auth",
    database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-up/email": { window: 60, max: 100 },
      },
    },
    user: { deleteUser: { enabled: true, ...deletionHooks } },
    plugins: [apiKey(apiKeyOptions), bearer()],
  };
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  const gate = createApiKeyEmailVerificationGate({
    getSession: (headers) =>
      auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      }),
    getUserById: (id) => {
      const row = database
        .prepare("SELECT emailVerified FROM user WHERE id = ?")
        .get(id) as { emailVerified: number | boolean } | undefined;
      return row ? { emailVerified: Boolean(row.emailVerified) } : null;
    },
  });
  app.use("/api/auth/api-key/create", gate);
  app.use("/api/auth/api-key/list", gate);
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return { app, database };
}

async function request(
  app: Hono,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<JsonResult> {
  const headers: Record<string, string> = {
    origin: BASE,
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return {
    status: response.status,
    data,
    cookies: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .join("; "),
  };
}

async function signUp(app: Hono, database: Database.Database, email: string) {
  const result = await request(app, "POST", "/api/auth/sign-up/email", {
    email,
    password: PASSWORD,
    name: email,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookies);
  const row = database
    .prepare("SELECT id FROM user WHERE email = ?")
    .get(email) as { id: string } | undefined;
  assert.ok(row);
  return { cookie: result.cookies, userId: row.id };
}

function countKeys(database: Database.Database, userId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM apikey WHERE referenceId = ?")
    .get(userId) as { count: number };
  return row.count;
}

test("unverified session cannot create or list API keys", async () => {
  const { app, database } = await buildFixture();
  const user = await signUp(app, database, "unverified-key-owner@example.com");

  const created = await request(
    app,
    "POST",
    "/api/auth/api-key/create",
    {},
    user.cookie,
  );
  assert.equal(created.status, 403, JSON.stringify(created.data));
  assert.deepEqual(created.data, { error: "email_not_verified" });
  assert.equal(countKeys(database, user.userId), 0);

  const listed = await request(
    app,
    "GET",
    "/api/auth/api-key/list",
    undefined,
    user.cookie,
  );
  assert.equal(listed.status, 403, JSON.stringify(listed.data));
  assert.deepEqual(listed.data, { error: "email_not_verified" });
});

test("verified session creates and lists API keys as before", async () => {
  const { app, database } = await buildFixture();
  const user = await signUp(app, database, "verified-key-owner@example.com");
  database
    .prepare("UPDATE user SET emailVerified = ? WHERE id = ?")
    .run(1, user.userId);

  const created = await request(
    app,
    "POST",
    "/api/auth/api-key/create",
    {},
    user.cookie,
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.ok((created.data as { key?: string }).key);
  assert.equal(countKeys(database, user.userId), 1);

  const listed = await request(
    app,
    "GET",
    "/api/auth/api-key/list",
    undefined,
    user.cookie,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal((listed.data as { total: number }).total, 1);
});

test("a deleting verified owner cannot create or list API keys", async () => {
  const { app, database } = await buildFixture();
  const user = await signUp(app, database, "deleting-key-owner@example.com");
  database
    .prepare("UPDATE user SET emailVerified = ? WHERE id = ?")
    .run(1, user.userId);
  markDeleting(user.userId);
  try {
    const created = await request(
      app,
      "POST",
      "/api/auth/api-key/create",
      {},
      user.cookie,
    );
    assert.equal(created.status, 403);
    assert.deepEqual(created.data, { error: "account_deleted" });

    const listed = await request(
      app,
      "GET",
      "/api/auth/api-key/list",
      undefined,
      user.cookie,
    );
    assert.equal(listed.status, 403);
    assert.deepEqual(listed.data, { error: "account_deleted" });
  } finally {
    clearDeleting(user.userId);
  }
});

test("an in-flight create paused before insert is swept by deletion and leaves no orphan key", async () => {
  const keygenStarted = deferred();
  const releaseKeygen = deferred();
  let pauseOnce = true;
  const { app, database } = await buildFixture({
    beforeKeyInsert: async () => {
      if (!pauseOnce) return;
      pauseOnce = false;
      keygenStarted.resolve();
      await releaseKeygen.promise;
    },
  });
  const user = await signUp(app, database, "racing-key-owner@example.com");
  database
    .prepare("UPDATE user SET emailVerified = ? WHERE id = ?")
    .run(1, user.userId);

  try {
    const createPromise = request(
      app,
      "POST",
      "/api/auth/api-key/create",
      {},
      user.cookie,
    );
    await keygenStarted.promise;
    assert.equal(countKeys(database, user.userId), 0);

    const deletePromise = request(
      app,
      "POST",
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    await waitFor(() => isDeleting(user.userId));
    assert.equal(countKeys(database, user.userId), 0);
    releaseKeygen.resolve();

    const [created, deleted] = await Promise.all([createPromise, deletePromise]);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(countKeys(database, user.userId), 0);
  } finally {
    releaseKeygen.resolve();
    clearDeleting(user.userId);
  }
});

test("missing session preserves the API-key route's 401 behavior", async () => {
  const { app, database } = await buildFixture();

  const created = await request(app, "POST", "/api/auth/api-key/create", {});
  assert.equal(created.status, 401, JSON.stringify(created.data));
  assert.equal(countKeys(database, "missing-user"), 0);

  const listed = await request(app, "GET", "/api/auth/api-key/list");
  assert.equal(listed.status, 401, JSON.stringify(listed.data));
});
