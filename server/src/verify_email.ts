import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  createSendVerificationRateLimiter,
  type SendVerificationRateLimiterOptions,
} from "./rate_limit.ts";
import { isDeleting, withOwnerBarrier } from "./account_deletion.ts";

/**
 * Self-contained HTML page for completing email verification (C2). The
 * emailed link points at `GET /verify-email?token=…` (built in auth.ts);
 * the page's JS fetches better-auth's built-in WIRE route — a GET
 * `/api/auth/verify-email?token=…` (NOT to be confused with reset-password's
 * POST flow) — and renders the outcome.
 *
 * Mirrors reset_password.ts: plain-string template (the `hono/html` helper
 * HTML-escapes interpolations, which would corrupt a token inside <script>
 * data state), JSON-encode + `<`-neutralize for anything injected. On top of
 * that, the token is base64-encoded BEFORE injection so the raw JWT can never
 * appear verbatim anywhere in the server-rendered body (belt and braces: the
 * JS atob()s it back before calling the wire route).
 *
 * Success/failure states are fixed strings rendered via textContent — the
 * token is never echoed back into the DOM after the fetch either.
 */
function renderPage(token: string): string {
  const tokenLiteral = JSON.stringify(Buffer.from(token, "utf8").toString("base64")).replaceAll(
    "<",
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verify email — AI Assistant</title>
    <style>
      body {
        margin: 0;
        padding: 0 24px;
        background: #f4f4f5;
        color: #18181b;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        background: #fff;
        border: 1px solid #e4e4e7;
        border-radius: 12px;
        padding: 32px;
        width: 100%;
        max-width: 380px;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
      }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { color: #52525b; font-size: 14px; margin: 0 0 20px; }
      .msg { margin-top: 16px; font-size: 14px; border-radius: 8px; padding: 10px 12px; display: none; }
      .msg.pending { display: block; background: #f4f4f5; color: #52525b; }
      .msg.ok { display: block; background: #dcfce7; color: #166534; }
      .msg.err { display: block; background: #fee2e2; color: #991b1b; }
      .hint { margin-top: 12px; font-size: 12px; color: #71717a; }
    </style>
  </head>
  <body>
    <div id="card" class="card">
      <h1>Verify your email</h1>
      <p>Confirming your AI Assistant email address…</p>
      <div id="msg" class="msg pending">Verifying…</div>
      <p class="hint">You can close this page once verification succeeds, then open the app.</p>
    </div>
    <script>
      const token = atob(${tokenLiteral});
      const msg = document.getElementById("msg");
      function show(outcome, text) {
        msg.className = "msg " + outcome;
        while (msg.firstChild) msg.removeChild(msg.firstChild);
        const p = document.createElement("p");
        p.style.margin = "0";
        p.textContent = text;
        msg.appendChild(p);
      }
      (async () => {
        if (!token) {
          return show("err", "This verification link is missing its token. Request a new email from the app.");
        }
        try {
          const res = await fetch("/api/auth/verify-email?token=" + encodeURIComponent(token), {
            method: "GET",
          });
          if (!res.ok) {
            return show("err", "Verification failed — the link may be invalid or expired. Request a new email from the app.");
          }
          show("ok", "Email verified — you can now open the AI Assistant app and sign in.");
        } catch {
          show("err", "Network error. Please try again.");
        }
      })();
    </script>
  </body>
</html>`;
}

export function createVerifyEmailRoutes(): Hono {
  const app = new Hono();
  app.get("/verify-email", (c) => {
    const token = c.req.query("token") ?? "";
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(renderPage(token));
  });
  return app;
}

export type ApiKeyEmailVerificationGateDeps = {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>;
  getUserById: (id: string) => { emailVerified: boolean } | null;
};

export function createApiKeyEmailVerificationGate(
  deps: ApiKeyEmailVerificationGateDeps,
): MiddlewareHandler {
  return async (c, next) => {
    const isCreate =
      c.req.method === "POST" && c.req.path === "/api/auth/api-key/create";
    const isList =
      c.req.method === "GET" && c.req.path === "/api/auth/api-key/list";
    if (!isCreate && !isList) return next();

    const session = await deps.getSession(c.req.raw.headers);
    if (!session) return next();
    return withOwnerBarrier(session.user.id, async () => {
      if (deps.getUserById(session.user.id)?.emailVerified === false) {
        return c.json({ error: "email_not_verified" }, 403);
      }
      if (isDeleting(session.user.id)) {
        return c.json({ error: "account_deleted" }, 403);
      }
      return next();
    });
  };
}

export type SendVerificationRateLimiter = ReturnType<
  typeof createSendVerificationRateLimiter
>;

export type SendVerificationRateLimitGate = {
  check: SendVerificationRateLimiter;
  approveRequest: (request: Request, email: string) => void;
  consumeRequestApproval: (request: Request | undefined, email: string) => boolean;
};

export function createSendVerificationRateLimitGate(
  options: SendVerificationRateLimiterOptions = {},
): SendVerificationRateLimitGate {
  const check = createSendVerificationRateLimiter(options);
  const approvedRequests = new WeakMap<Request, string>();
  return {
    check,
    approveRequest(request, email) {
      approvedRequests.set(request, email.trim().toLowerCase());
    },
    consumeRequestApproval(request, email) {
      if (!request || approvedRequests.get(request) !== email) return false;
      approvedRequests.delete(request);
      return true;
    },
  };
}

const sharedSendVerificationRateLimitGate =
  createSendVerificationRateLimitGate();

export function getSendVerificationRateLimitGate(): SendVerificationRateLimitGate {
  return sharedSendVerificationRateLimitGate;
}

type SendVerificationEmailData = {
  user: { email: string };
  url: string;
  token: string;
};

type SendVerificationEmailCallbackOptions = {
  gate?: SendVerificationRateLimitGate;
  warn?: (message: string) => void;
};

export function createSendVerificationEmailCallback(
  send: (data: SendVerificationEmailData, request?: Request) => Promise<void>,
  options: SendVerificationEmailCallbackOptions = {},
): (data: SendVerificationEmailData, request?: Request) => Promise<void> {
  const gate = options.gate ?? getSendVerificationRateLimitGate();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (data, request) => {
    const email = data.user.email.trim().toLowerCase();
    let allowed: boolean;
    try {
      allowed = gate.consumeRequestApproval(request, email)
        ? true
        : gate.check(email).allowed;
    } catch {
      warn("verification email suppressed: rate limiter failed");
      return;
    }
    if (!allowed) {
      warn("verification email suppressed by per-address rate limit");
      return;
    }
    await send(data, request);
  };
}

/**
 * C2 resend gate: ≥60 seconds between verification emails to the same
 * address (lowercased). Applied as Hono middleware on the exact better-auth
 * path — register it BEFORE the catch-all `/api/auth/*` mount in index.ts so
 * it wraps the better-auth handler (Hono runs matched handlers in
 * registration order; the catch-all never calls next()).
 *
 * The request body is read from a CLONE of the raw Request: better-auth
 * reads the original body downstream and Request bodies are single-use.
 * A malformed body is passed through for better-auth to reject.
 */
export function createSendVerificationRateLimit(
  gate: SendVerificationRateLimitGate = getSendVerificationRateLimitGate(),
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    let email: unknown;
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      email = body?.email;
    } catch {
      // let better-auth produce its own validation error
    }
    if (typeof email === "string" && email.length > 0) {
      const { allowed, retryAfterSeconds } = gate.check(email);
      if (!allowed) {
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json(
          {
            message: "Too many verification emails requested for this address. Try again in a minute.",
            code: "RATE_LIMIT_EXCEEDED",
            retryAfterSeconds,
          },
          429,
        );
      }
      gate.approveRequest(c.req.raw, email);
    }
    return next();
  };
}
