import { Hono } from "hono";
import type { Context } from "hono";
import { auth, getUserById } from "./auth.ts";
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
type KeyAuthFailure = Extract<KeyAuth, { ok: false }>;

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

export function createAuthCheckRoutes(): Hono {
  const routes = new Hono();

  // The probe uses this route to tell "verify your email" (403
  // email_not_verified) from "re-auth" (401), so it must return the same
  // distinct 403 as every other gated route.
  routes.get("/auth/check", async (c) => {
    const keyAuth = await requireApiKey(c);
    if (!keyAuth.ok) return keyGateResponse(c, keyAuth);
    return c.json({ status: "ok" });
  });

  return routes;
}
