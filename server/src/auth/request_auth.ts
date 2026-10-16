import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, getUserById } from "./index.ts";
import { isDeleting } from "./account_deletion.ts";

export function accountDeletedResponse(c: Context): Response {
  return c.json({ error: "account_deleted" }, 403);
}

/**
 * Result of an API-key verification:
 *   - `ok:true`               — valid key whose owner exists and is verified;
 *                               `owner` is the user id to scope the request to.
 *   - `bad_key`               — missing/malformed key, verification failure, or
 *                               an orphaned key whose user row no longer exists.
 *   - `email_not_verified`    — valid key, but the owning user has not
 *                               confirmed their email yet.
 *   - `account_deleted`       — the owning account is tombstoned for this
 *                               process lifetime.
 */
export type KeyAuth =
  | { ok: true; owner: string }
  | { ok: false; reason: "bad_key" | "email_not_verified" | "account_deleted" };

/** The failure arm of `KeyAuth`, already narrowed by an `if (!result.ok)` guard. */
export type KeyAuthFailure = Extract<KeyAuth, { ok: false }>;

/** Verifier seam: routes accept one so tests can inject a deterministic stub. */
export type VerifyApiKeyFn = (c: Context) => Promise<KeyAuth>;

/** Hono environment for routers that read the authenticated owner from context. */
export type OwnerVariables = {
  Variables: { owner: string; superuser?: boolean };
};

/** Hook run after the gate builds its denial response, e.g. to emit an audit event. */
export type OnDenied = (
  c: Context,
  auth: KeyAuthFailure,
  response: Response,
) => void | Promise<void>;

/** Single gate every `verifyKey` call site maps a failed verification through. */
export function keyGateResponse(c: Context, result: KeyAuthFailure): Response {
  if (result.reason === "email_not_verified") {
    return c.json({ error: "email_not_verified" }, 403);
  }
  if (result.reason === "account_deleted") {
    return accountDeletedResponse(c);
  }
  return c.json({ error: "unauthorized" }, 401);
}

/**
 * Verifies the `Authorization: Bearer <api-key>` header and returns the
 * tri-state `KeyAuth`. A valid key is not sufficient: the owning user must
 * still exist (else `bad_key`), have a confirmed email (else
 * `email_not_verified`), and not be tombstoned (else `account_deleted`).
 */
export async function requireApiKey(c: Context): Promise<KeyAuth> {
  const match = /^Bearer\s+(.+)$/i.exec((c.req.header("authorization") ?? "").trim());
  const token = match ? match[1]!.trim() : null;
  if (!token) return { ok: false, reason: "bad_key" };
  try {
    const result = await auth.api.verifyApiKey({
      body: { key: token },
    });
    if (result.valid && result.key) {
      const owner = result.key.referenceId;
      if (isDeleting(owner)) {
        return { ok: false, reason: "account_deleted" };
      }
      const user = getUserById(owner);
      if (!user) return { ok: false, reason: "bad_key" };
      if (user.emailVerified === false) return { ok: false, reason: "email_not_verified" };
      return { ok: true, owner: result.key.referenceId };
    }
  } catch {
    return { ok: false, reason: "bad_key" };
  }
  return { ok: false, reason: "bad_key" };
}

/**
 * Hono middleware that gates an entire router. It verifies the request, stores
 * the authenticated owner on the context, and calls `next()`; on failure it
 * returns the mapped 401/403 (running `onDenied` first). Register it with
 * `routes.use(...)` before any route so every route is protected by
 * construction rather than by remembering an inline check in each handler.
 */
export function requireOwner(
  verifyKey: VerifyApiKeyFn = requireApiKey,
  onDenied?: OnDenied,
): MiddlewareHandler<OwnerVariables> {
  return async (c, next) => {
    const auth = await verifyKey(c);
    if (!auth.ok) {
      const response = keyGateResponse(c, auth);
      await onDenied?.(c, auth, response);
      return response;
    }
    c.set("owner", auth.owner);
    await next();
  };
}

/** Owner id stamped on a request authenticated by a superuser ops secret. */
export const SUPERUSER_OWNER = "admin";

/**
 * Constant-time comparison of a candidate token against a configured secret.
 * Both sides are hashed to a fixed-length SHA-256 digest first, so tokens of
 * differing lengths still compare in constant time — raw `timingSafeEqual`
 * throws on unequal buffer lengths, and its byte-by-byte early exit can leak a
 * shared prefix.
 */
function constantTimeTokenEqual(candidate: string, secret: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const secretDigest = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(candidateDigest, secretDigest);
}

/**
 * True when `authorization` bears one of the configured superuser secrets.
 * An empty list never matches (the gate stays disabled). EVERY configured
 * secret is compared — no early return — so the comparison count does not
 * reveal which rotation entry matched.
 */
export function isSuperuserToken(
  authorization: string | undefined,
  secrets: readonly string[],
): boolean {
  if (secrets.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  const token = match ? match[1]!.trim() : null;
  if (!token) return false;
  let matched = false;
  for (const secret of secrets) {
    if (constantTimeTokenEqual(token, secret)) matched = true;
  }
  return matched;
}

/**
 * Hono middleware gating the ops-only superuser surface. It accepts only a
 * configured `SUPERUSER_API_KEY` bearer secret, then stamps `owner` as the
 * synthetic {@link SUPERUSER_OWNER} and marks the request `superuser`, so the
 * existing owner-scoped audit/rate-limit/deletion reads keep working.
 *
 * This is NOT a better-auth gate: the synthetic owner has no user row and is
 * not revoked by account deletion. An empty secret list — or any bearer token
 * that is not a configured secret — is refused with 403 (never 401), keeping
 * the surface invisible to ordinary keys. Secrets are never logged or echoed;
 * `onDenied` runs after the response is built so callers can audit the denial.
 */
export function requireSuperuser(
  secrets: readonly string[] = [],
  onDenied?: (c: Context, response: Response) => void | Promise<void>,
): MiddlewareHandler<OwnerVariables> {
  return async (c, next) => {
    if (!isSuperuserToken(c.req.header("authorization"), secrets)) {
      const response = c.json({ error: "forbidden" }, 403);
      await onDenied?.(c, response);
      return response;
    }
    c.set("owner", SUPERUSER_OWNER);
    c.set("superuser", true);
    await next();
  };
}

export function createAuthCheckRoutes(): Hono<OwnerVariables> {
  const routes = new Hono<OwnerVariables>();
  routes.use("/auth/*", requireOwner());

  // The probe relies on this route returning the same distinct 403/401 as every
  // other gated route, so it can tell "verify your email" from "re-auth".
  routes.get("/auth/check", (c) => c.json({ status: "ok" }));

  return routes;
}
