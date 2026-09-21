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
import { createResetPasswordRoutes } from "../src/reset_password.ts";
import { getMigrations } from "better-auth/db/migration";

// Mirrors src/auth.ts wiring (same config surface) but with a throwaway
// SQLite DB and a captured reset URL, so the forgot-password loop can be
// exercised without touching the gateway's real DB or SMTP.
async function buildTestAuth(captured: { url: string; token: string; to: string }) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "reset-pw-test-")), "test.db");
  const config = {
    appName: "AI Assistant",
    secret: "test-secret-at-least-thirty-two-characters",
    baseURL: "http://localhost:17600",
    basePath: "/api/auth",
    database: new Database(dbPath),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
      sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
        // Mirrors src/auth.ts: route the email to our reset page
        // (GET /reset-password?token=…), not better-auth's default callback.
        captured.to = user.email;
        captured.url = `http://localhost:17600/reset-password?token=${token}`;
        captured.token = token;
      },
    },
    rateLimit: { enabled: true, window: 60, max: 100 },
    plugins: [
      apiKey({ defaultPrefix: "sk", defaultKeyLength: 32, rateLimit: { enabled: false } }),
      bearer(),
    ],
  };
  // Run the better-auth migrations on the throwaway DB so the `user` table
  // exists before the forgot-password loop can sign up.
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

async function json(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://localhost:17600${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
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
  return { status: res.status, data };
}

test("forgot-password loop: request reset -> reset with token -> sign in with new password", async () => {
  const captured = { url: "", token: "", to: "" };
  const app = await buildTestAuth(captured);

  const signUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "reset@example.com",
    password: "old-password-1",
    name: "Reset User",
  });
  assert.equal(signUp.status, 200);

  const reqReset = await json(app, "POST", "/api/auth/request-password-reset", {
    email: "reset@example.com",
  });
  assert.equal(reqReset.status, 200);
  assert.equal((reqReset.data as { status: boolean }).status, true);
  assert.equal(captured.to, "reset@example.com");
  // The emailed URL points at OUR reset page (not better-auth's /api/auth
  // callback redirect) carrying the token as a query param.
  assert.match(captured.url, /^http:\/\/localhost:17600\/reset-password\?token=./);
  const token = new URL(captured.url).searchParams.get("token");
  assert.ok(captured.token && token && captured.token === token);

  // Unknown-account requests must not leak account existence (status true).
  const ghost = await json(app, "POST", "/api/auth/request-password-reset", {
    email: "nobody@example.com",
  });
  assert.equal((ghost.data as { status: boolean }).status, true);

  const reset = await json(app, "POST", "/api/auth/reset-password", {
    token,
    newPassword: "new-password-2",
  });
  assert.equal(reset.status, 200);
  assert.equal((reset.data as { status: boolean }).status, true);

  const signIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "reset@example.com",
    password: "new-password-2",
  });
  assert.equal(signIn.status, 200);

  // The old password is dead after the reset.
  const staleSignIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "reset@example.com",
    password: "old-password-1",
  });
  assert.equal(staleSignIn.status, 401);

  // Reusing the consumed token fails.
  const replay = await json(app, "POST", "/api/auth/reset-password", {
    token,
    newPassword: "another-password-3",
  });
  assert.equal(replay.status, 400);
});

test("GET /reset-password serves the completion page with an injected token", async () => {
  const app = createResetPasswordRoutes();
  const res = await app.fetch(new Request("http://localhost:17600/reset-password?token=abc123"));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Reset your password/);
  assert.match(body, /const token = "abc123";/);
  // The page wires straight to the better-auth wire route.
  assert.match(body, /\/api\/auth\/reset-password/);
});

test("reset page token is JSON-escaped (no injection via query string)", async () => {
  const app = createResetPasswordRoutes();
  const res = await app.fetch(
    new Request('http://localhost:17600/reset-password?token="></script><script>alert(1)</script>'),
  );
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /const token = "\\">/);
});