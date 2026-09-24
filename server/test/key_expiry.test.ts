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
import { getMigrations } from "better-auth/db/migration";
import {
  API_KEY_DEFAULT_EXPIRES_IN_SECONDS,
  API_KEY_PLUGIN_OPTIONS,
} from "../src/auth.ts";
import { testPasswordHasher } from "./better_auth_test_password.ts";

const BASE = "http://localhost:17600";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Mirrors src/auth.ts over a throwaway SQLite DB, but plugs in the SAME
// exported API_KEY_PLUGIN_OPTIONS object the gateway uses — so the key minted
// below goes through the production expiry configuration, not a copied literal.
async function buildTestAuth() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "key-expiry-test-")), "test.db");
  const config = {
    appName: "AI Assistant",
    secret: "test-secret-at-least-thirty-two-characters",
    baseURL: BASE,
    basePath: "/api/auth",
    database: new Database(dbPath),
    emailAndPassword: {
      enabled: true,
      password: testPasswordHasher,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    rateLimit: { enabled: true, window: 60, max: 100 },
    plugins: [apiKey(API_KEY_PLUGIN_OPTIONS), bearer()],
  };
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; data: unknown; cookies: string }> {
  const headers: Record<string, string> = {
    origin: BASE,
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
    .map((c) => c.split(";")[0]!)
    .join("; ");
  return { status: res.status, data, cookies };
}

test("M12: defaultExpiresIn is 90 days in SECONDS — a key minted via the normal create path expires ~90d from now", async () => {
  // The constant itself is the value the plugin receives as SECONDS.
  assert.equal(API_KEY_DEFAULT_EXPIRES_IN_SECONDS, 90 * 24 * 60 * 60);
  assert.equal(API_KEY_DEFAULT_EXPIRES_IN_SECONDS, 7_776_000);

  const app = await buildTestAuth();

  const signUp = await post(app, "/api/auth/sign-up/email", {
    email: "expiry@example.com",
    password: "password-123",
    name: "Expiry User",
  });
  assert.equal(signUp.status, 200);
  assert.ok(signUp.cookies, "sign-in must hand back a session cookie");

  // Normal mint path: the same POST the Flutter client uses.
  const created = await post(app, "/api/auth/api-key/create", {}, signUp.cookies);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const record = created.data as { expiresAt?: string | null; createdAt?: string };
  assert.ok(record.expiresAt, "defaultExpiresIn must produce a non-null expiresAt");
  assert.ok(record.createdAt);

  const delta =
    Date.parse(record.expiresAt) - Date.parse(record.createdAt!);
  // Units proof: SECONDS semantics give ~90d. A ms misread of the constant
  // would give ~246 years; treating the old `*1000` literal as seconds gave
  // ~1000 years; passing 90d as milliseconds would give ~2.2 hours. A tight
  // ±60s window catches all of them.
  assert.ok(
    Math.abs(delta - NINETY_DAYS_MS) < 60_000,
    `key lifetime should be ~90 days, got ${delta} ms (${delta / 3_600_000} h)`,
  );
});
