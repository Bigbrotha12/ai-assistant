import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  createSendVerificationRateLimiter,
  type SendVerificationRateLimiterOptions,
} from "../rate_limit.ts";
import { isDeleting, withOwnerBarrier } from "./account_deletion.ts";
import { injectToken, loadPageTemplate, scriptStringLiteral } from "./page_template.ts";

/**
 * Self-contained HTML page for completing email verification. The
 * emailed link points at `GET /verify-email?token=…` (built in auth/index.ts);
 * the page's JS fetches better-auth's built-in WIRE route — a GET
 * `/api/auth/verify-email?token=…` (NOT to be confused with reset-password's
 * POST flow) — and renders the outcome.
 *
 * The markup lives in pages/verify-email.html. The token is base64-encoded and
 * injected as a JS string literal via `injectToken` — never via `hono/html`,
 * whose escaping would corrupt a token in script-data state. Base64 keeps the
 * raw JWT out of the server-rendered body entirely; the page atob()s it before
 * calling the wire route.
 *
 * Success/failure states are fixed strings rendered via textContent — the
 * token is never echoed back into the DOM after the fetch either.
 */
const template = loadPageTemplate(new URL("./pages/verify-email.html", import.meta.url));

function renderPage(token: string): string {
  const literal = scriptStringLiteral(Buffer.from(token, "utf8").toString("base64"));
  return injectToken(template, literal);
}

/** Path of the verification page; the emailed link and this route must match. */
export const VERIFY_EMAIL_PATH = "/verify-email";

export function createVerifyEmailRoutes(): Hono {
  const app = new Hono();
  app.get(VERIFY_EMAIL_PATH, (c) => {
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
  /** Refunds the consumed token when the downstream send fails. */
  refund: (email: string) => void;
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
    refund(email) {
      check.refund(email.trim().toLowerCase());
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
    try {
      await send(data, request);
    } catch (error) {
      // A transient SMTP failure must not lock the address out for the full
      // 60s window: refund the consumed token, then let the caller report the
      // failure. The explicit resend endpoint rethrows (a 5xx is honest);
      // sign-up/sign-in resends run through better-auth's background wrapper,
      // which swallows the error so the auth response stays 2xx.
      gate.refund(email);
      warn(
        `verification email send failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  };
}

/**
 * Resend gate: ≥60 seconds between verification emails to the same
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
