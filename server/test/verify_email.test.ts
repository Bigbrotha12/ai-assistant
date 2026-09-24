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
  createSendVerificationEmailCallback,
  createSendVerificationRateLimit,
  createSendVerificationRateLimitGate,
  createVerifyEmailRoutes,
  type SendVerificationRateLimitGate,
} from "../src/verify_email.ts";
import { smtpUnconfigured } from "../src/email.ts";
import { testPasswordHasher } from "./better_auth_test_password.ts";

// Mirrors src/auth.ts C2 wiring (emailVerification + autoSignIn:false +
// requireEmailVerification + sliding session) but with a throwaway SQLite DB
// and a captured verification URL, so signup/sign-in/resend can be exercised
// without touching the gateway's real DB or SMTP.
type CapturedSend = { to: string; url: string; token: string };

type BuildTestAuthOptions = {
  gate?: SendVerificationRateLimitGate;
  warn?: (message: string) => void;
};

async function buildTestAuth(
  captures: CapturedSend[],
  options: BuildTestAuthOptions = {},
) {
  let now = 0;
  const gate =
    options.gate ?? createSendVerificationRateLimitGate({ now: () => now });
  const dbPath = join(mkdtempSync(join(tmpdir(), "verify-email-test-")), "test.db");
  const database = new Database(dbPath);
  const config = {
    appName: "AI Assistant",
    secret: "test-secret-at-least-thirty-two-characters",
    baseURL: "http://localhost:17600",
    basePath: "/api/auth",
    database,
    emailAndPassword: {
      enabled: true,
      password: testPasswordHasher,
      minPasswordLength: 8,
      autoSignIn: false,
      requireEmailVerification: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      // Mirrors src/auth.ts: route the link to OUR /verify-email page rather
      // than better-auth's /api/auth JSON response.
      sendVerificationEmail: createSendVerificationEmailCallback(
        async ({ user, token }) => {
          captures.push({
            to: user.email,
            token,
            url: `http://localhost:17600/verify-email?token=${token}`,
          });
        },
        { gate, warn: options.warn },
      ),
    },
    session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    rateLimit: { enabled: false },
    plugins: [
      apiKey({ defaultPrefix: "sk", defaultKeyLength: 32, rateLimit: { enabled: false } }),
      bearer(),
    ],
  };
  // Run the better-auth migrations on the throwaway DB so the `user`/`session`
  // tables exist before signup.
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  // Same mount order as src/index.ts: per-address resend gate BEFORE the
  // catch-all /api/auth/* handler.
  app.use(
    "/api/auth/send-verification-email",
    createSendVerificationRateLimit(gate),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return {
    app,
    database,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
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
  return { status: res.status, data, headers: res.headers };
}

test("production SMTP fallback never logs the reset token", () => {
  const warnings: string[] = [];
  const url = "https://mail.example.test/reset-password?token=secret-token";
  const unconfigured = smtpUnconfigured(
    "password reset",
    "ops@example.test",
    url,
    { NODE_ENV: "production", SMTP_HOST: "", SMTP_FROM: "" },
    (message) => warnings.push(String(message)),
  );

  assert.equal(unconfigured, true);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0]!.includes(url));
  assert.ok(!warnings[0]!.includes("secret-token"));
  assert.ok(!warnings[0]!.includes("token="));
  assert.match(warnings[0]!, /mail\.example\.test\/reset-password/);
});

test("signup with autoSignIn:false returns token:null, creates NO session row, and sends the verification mail", async () => {
  const captures: CapturedSend[] = [];
  const { app, database } = await buildTestAuth(captures);

  const signUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "fresh@example.com",
    password: "password-123",
    name: "Fresh User",
  });
  assert.equal(signUp.status, 200);
  const body = signUp.data as { token: string | null };
  assert.equal(body.token, null);

  // No session row was written (autoSignIn:false / requireEmailVerification).
  const sessions = database.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number };
  assert.equal(sessions.n, 0);

  // The user exists and stays unverified until the emailed token is used.
  const user = database
    .prepare("SELECT emailVerified FROM user WHERE email = ?")
    .get("fresh@example.com") as { emailVerified: number | boolean };
  assert.equal(Boolean(user.emailVerified), false);

  // sendOnSignUp fired: one captured send, addressed to the user and pointing
  // at OUR /verify-email page (mirroring the auth.ts callback).
  assert.equal(captures.length, 1);
  assert.equal(captures[0]!.to, "fresh@example.com");
  assert.match(captures[0]!.url, /^http:\/\/localhost:17600\/verify-email\?token=./);
  assert.equal(new URL(captures[0]!.url).searchParams.get("token"), captures[0]!.token);
});

test("shared limiter: signup sends once; sign-in stays 403 without resend and resend stays 429", async () => {
  const captures: CapturedSend[] = [];
  const warnings: string[] = [];
  const { app } = await buildTestAuth(captures, {
    warn: (message) => warnings.push(message),
  });

  const signUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "unverified@example.com",
    password: "password-123",
    name: "Unverified User",
  });
  assert.equal(signUp.status, 200);
  assert.equal(captures.length, 1);

  const signIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "unverified@example.com",
    password: "password-123",
  });
  assert.equal(signIn.status, 403);
  assert.equal((signIn.data as { code?: string }).code, "EMAIL_NOT_VERIFIED");
  assert.equal(captures.length, 1);
  assert.deepEqual(warnings, [
    "verification email suppressed by per-address rate limit",
  ]);

  const resend = await json(app, "POST", "/api/auth/send-verification-email", {
    email: "unverified@example.com",
  });
  assert.equal(resend.status, 429);
  assert.equal(resend.headers.get("retry-after"), "60");
  assert.deepEqual(resend.data, {
    message:
      "Too many verification emails requested for this address. Try again in a minute.",
    code: "RATE_LIMIT_EXCEEDED",
    retryAfterSeconds: 60,
  });
  assert.equal(captures.length, 1);
});

test("GET /verify-email renders the page and never echoes the raw token", async () => {
  const app = createVerifyEmailRoutes();
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4f";
  const res = await app.fetch(
    new Request(`http://localhost:17600/verify-email?token=${encodeURIComponent(token)}`),
  );
   assert.equal(res.status, 200);
   assert.equal(res.headers.get("cache-control"), "no-store");
   assert.equal(res.headers.get("referrer-policy"), "no-referrer");
   const body = await res.text();
   assert.match(body, /Verify your email/);

  // The raw token must not appear anywhere in the server-rendered body.
  assert.ok(!body.includes(token), "raw token leaked into the HTML");
  // The page wires straight to better-auth's GET wire route.
  assert.match(body, /\/api\/auth\/verify-email/);
  assert.match(body, /method: "GET"/);

  // Hostile tokens are neutralized too (base64-encoded before injection —
  // nothing from the query can break out of the script element).
  const hostile = await app.fetch(
    new Request(
      `http://localhost:17600/verify-email?token=${encodeURIComponent(
        '"></script><script>alert(1)</script>',
      )}`,
    ),
  );
  assert.equal(hostile.status, 200);
  const hostileBody = await hostile.text();
  assert.ok(!hostileBody.includes("alert(1)"));
});

test("shared limiter normalizes case, isolates addresses, and admits one resend after 60s", async () => {
  const captures: CapturedSend[] = [];
  const { app, advance } = await buildTestAuth(captures, { warn: () => {} });

  const ownerSignUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "owner@example.com",
    password: "password-123",
    name: "Owner",
  });
  assert.equal(ownerSignUp.status, 200);
  assert.equal(captures.length, 1);

  const caseVariantSignIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "Owner@Example.com",
    password: "password-123",
  });
  assert.equal(caseVariantSignIn.status, 403);
  assert.equal(captures.length, 1);

  const caseVariantResend = await json(
    app,
    "POST",
    "/api/auth/send-verification-email",
    { email: "OWNER@example.COM" },
  );
  assert.equal(caseVariantResend.status, 429);
  assert.equal(captures.length, 1);

  const otherSignUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "other@example.com",
    password: "password-123",
    name: "Other",
  });
  assert.equal(otherSignUp.status, 200);
  assert.equal(captures.length, 2);

  advance(60_000);

  const ownerResend = await json(
    app,
    "POST",
    "/api/auth/send-verification-email",
    { email: "owner@example.com" },
  );
  assert.equal(ownerResend.status, 200);
  assert.equal((ownerResend.data as { status: boolean }).status, true);
  assert.equal(captures.length, 3);
  assert.equal(captures[2]!.to, "owner@example.com");

  const otherResend = await json(
    app,
    "POST",
    "/api/auth/send-verification-email",
    { email: "other@example.com" },
  );
  assert.equal(otherResend.status, 200);
  assert.equal(captures.length, 4);
  assert.equal(captures[3]!.to, "other@example.com");

  const exhausted = await json(
    app,
    "POST",
    "/api/auth/send-verification-email",
    { email: "OWNER@EXAMPLE.COM" },
  );
  assert.equal(exhausted.status, 429);
  assert.equal(captures.length, 4);
});

test("limiter failure suppresses the send without turning sign-in 403 into 500", async () => {
  const captures: CapturedSend[] = [];
  const warnings: string[] = [];
  const baseGate = createSendVerificationRateLimitGate({ now: () => 0 });
  let limiterFailed = false;
  const gate: SendVerificationRateLimitGate = {
    check(email) {
      if (limiterFailed) throw new Error("injected limiter failure");
      return baseGate.check(email);
    },
    approveRequest: baseGate.approveRequest,
    consumeRequestApproval: baseGate.consumeRequestApproval,
  };
  const { app } = await buildTestAuth(captures, {
    gate,
    warn: (message) => warnings.push(message),
  });

  const signUp = await json(app, "POST", "/api/auth/sign-up/email", {
    email: "limiter-failure@example.com",
    password: "password-123",
    name: "Limiter Failure",
  });
  assert.equal(signUp.status, 200);
  assert.equal(captures.length, 1);

  limiterFailed = true;
  const signIn = await json(app, "POST", "/api/auth/sign-in/email", {
    email: "limiter-failure@example.com",
    password: "password-123",
  });
  assert.equal(signIn.status, 403);
  assert.equal((signIn.data as { code?: string }).code, "EMAIL_NOT_VERIFIED");
  assert.equal(captures.length, 1);
  assert.deepEqual(warnings, ["verification email suppressed: rate limiter failed"]);
});
