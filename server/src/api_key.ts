// Formerly `inference.ts`: the proxy routes (`/v1/chat/completions`,
// `/v1/models`) moved to `transport/` in Phase 3; only the API-key auth seams
// remain here.
import { Hono } from "hono";
import type { Context } from "hono";
import { auth, getUserById } from "./auth.ts";
import { isDeleting } from "./account_deletion.ts";

export function extractBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return match ? match[1]!.trim() : null;
}

export function unauthorized(c: Context): Response {
  return c.json({ error: "unauthorized" }, 401);
}

export function accountDeletedResponse(c: Context): Response {
  return c.json({ error: "account_deleted" }, 403);
}

/**
 * Result of an API-key verification (C2 backstop):
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

/**
 * Single response gate every `verifyKey` call site routes through:
 * `ok:true` → null (the caller proceeds with `result.owner`); `bad_key` → 401
 * with the pre-existing `unauthorized` body (already parsed by the
 * client/probe); `email_not_verified` → 403 `{ error: "email_not_verified" }`.
 * The first overload lets a call site written as
 * `if (!auth.ok) return keyGateResponse(c, auth);` get a non-null `Response`
 * without a narrowing dance; the second serves the full-union form
 * (`const gate = keyGateResponse(c, auth); if (gate) return gate;`).
 */
export function keyGateResponse(
  c: Context,
  result: { ok: false; reason: "bad_key" | "email_not_verified" | "account_deleted" },
): Response;
export function keyGateResponse(c: Context, result: KeyAuth): Response | null;
export function keyGateResponse(c: Context, result: KeyAuth): Response | null {
  if (result.ok) return null;
  if (result.reason === "email_not_verified") {
    return c.json({ error: "email_not_verified" }, 403);
  }
  if (result.reason === "account_deleted") {
    return accountDeletedResponse(c);
  }
  return unauthorized(c);
}

/**
 * Verifies the `Authorization: Bearer <api-key>` header against the auth
 * server and returns the tri-state `KeyAuth`. A valid key alone is not
 * enough: the owning user is looked up via `getUserById` (S1 export) so a
 * missing row maps to `bad_key` and an unconfirmed email maps to
 * `email_not_verified` (C2 backstop). The ledger/transport/plugin/notify
 * routes reuse this for owner-bound authorization instead of duplicating
 * bearer-token parsing; callers gate through `keyGateResponse`.
 */
export async function requireApiKey(c: Context): Promise<KeyAuth> {
  const token = extractBearerToken(c.req.header("authorization"));
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

export const inferenceRoutes = new Hono();

// NOT exempt from the C2 backstop: the probe hits this route to distinguish
// "verify your email" (403 email_not_verified) from "re-auth" (401), so it
// returns the SAME distinct 403 as every other gated route.
inferenceRoutes.get("/auth/check", async (c) => {
  const keyAuth = await requireApiKey(c);
  if (!keyAuth.ok) return keyGateResponse(c, keyAuth);
  return c.json({ status: "ok" });
});

// NOTE: `POST /v1/chat/completions` was REMOVED here in Phase 3, Wave C1 — it
// moved to `src/transport/chat.ts` (createChatRoutes), which builds a LangChain
// agent from the installed MODEL plugin + per-request credentials and streams
// SSE via the transport adapter, instead of proxying INFERENCE_URL. The shared
// seams below (`extractBearerToken`, `requireApiKey`, `keyGateResponse`,
// `unauthorized`) stay here because sibling transports import them.
// NOTE: `GET /v1/models` was REMOVED here in Phase 3, Wave B — it moved to
// `src/transport/models.ts` (createModelsRoutes), which serves the installed
// MODEL plugins (incl. visionCapable) instead of proxying INFERENCE_URL. This
// keeps a single `/v1/models` owner and avoids a duplicate-path mount conflict.