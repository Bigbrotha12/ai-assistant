import "./test_env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { createPasswordResetHooks } from "../src/auth/index.ts";
import { testPasswordHasher } from "./better_auth_test_password.ts";

const BASE = "http://localhost:17600";

async function buildTestAuth() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "reset-revoke-test-")), "test.db");
  const db = new Database(dbPath);
  const captured: { token: string } = { token: "" };
  const config = {
    appName: "AI Assistant",
    secret: "test-secret-at-least-thirty-two-characters",
    baseURL: BASE,
    basePath: "/api/auth",
    database: db,
    emailAndPassword: {
      enabled: true,
      password: testPasswordHasher,
      minPasswordLength: 8,
      autoSignIn: true,
      ...createPasswordResetHooks(db),
      sendResetPassword: async ({ token }: { token: string }) => {
        captured.token = token;
      },
    },
    rateLimit: { enabled: true, window: 60, max: 100 },
    plugins: [
      apiKey({ defaultPrefix: "sk", defaultKeyLength: 32, rateLimit: { enabled: false } }),
      bearer(),
    ],
  };
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return { app, auth, db, captured };
}

type JsonResult = { status: number; data: unknown; cookies: string };

async function json(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<JsonResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    origin: BASE,
  };
  if (cookie) headers.cookie = cookie;
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const cookies = res.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
  return { status: res.status, data, cookies };
}

function countFor(db: DatabaseType, table: string, userId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${table === "session" ? "userId" : "referenceId"} = ?`)
    .get(userId) as { c: number };
  return row.c;
}

test("password reset revokes pre-reset sessions and API keys, scoped to the user", async () => {
  const { app, auth, db, captured } = await buildTestAuth();

  const victim = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "victim-reset@example.com",
    password: "old-password-1",
    name: "Victim",
  });
  assert.equal(victim.status, 200, JSON.stringify(victim.data));
  const victimId = (victim.data as { user: { id: string } }).user.id;
  const victimCookie = victim.cookies;

  const bystander = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "bystander-reset@example.com",
    password: "bystander-password-1",
    name: "Bystander",
  });
  assert.equal(bystander.status, 200, JSON.stringify(bystander.data));
  const bystanderId = (bystander.data as { user: { id: string } }).user.id;

  const victimKey = await json(app, "POST", "/api/auth/api-key/create", {}, victimCookie);
  assert.equal(victimKey.status, 200, JSON.stringify(victimKey.data));
  const victimKeyValue = (victimKey.data as { key: string }).key;

  const bystanderKey = await json(app, "POST", "/api/auth/api-key/create", {}, bystander.cookies);
  assert.equal(bystanderKey.status, 200, JSON.stringify(bystanderKey.data));
  const bystanderKeyValue = (bystanderKey.data as { key: string }).key;

  assert.equal(countFor(db, "session", victimId) > 0, true);
  assert.equal(countFor(db, "apikey", victimId), 1);

  const request = await json(app, "POST", "/api/auth/request-password-reset", {
    email: "victim-reset@example.com",
  });
  assert.equal(request.status, 200);
  assert.ok(captured.token);

  const reset = await json(app, "POST", "/api/auth/reset-password", {
    token: captured.token,
    newPassword: "new-password-2",
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));

  assert.equal(countFor(db, "session", victimId), 0, "all victim sessions must be deleted");
  assert.equal(countFor(db, "apikey", victimId), 0, "all victim API keys must be deleted");
  assert.equal(countFor(db, "session", bystanderId) > 0, true, "bystander sessions must survive");
  assert.equal(countFor(db, "apikey", bystanderId), 1, "bystander API keys must survive");

  const staleSession = await json(app, "POST", "/api/auth/api-key/create", {}, victimCookie);
  assert.notEqual(staleSession.status, 200, "the pre-reset session must no longer mint keys");

  const staleKey = await auth.api.verifyApiKey({ body: { key: victimKeyValue } });
  assert.equal(staleKey.valid, false, "the pre-reset API key must no longer verify");

  const freshKey = await auth.api.verifyApiKey({ body: { key: bystanderKeyValue } });
  assert.equal(freshKey.valid, true, "another user's key must remain valid");

  const signIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "victim-reset@example.com",
    password: "new-password-2",
  });
  assert.equal(signIn.status, 200);
});
