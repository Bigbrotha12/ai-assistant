import { Hono } from "hono";
import type { Context } from "hono";
import { auth } from "./auth.ts";

export function extractBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return match ? match[1]!.trim() : null;
}

export function unauthorized(c: Context): Response {
  return c.json({ error: "unauthorized" }, 401);
}

/**
 * Verifies the `Authorization: Bearer <api-key>` header against the auth
 * server and returns the owning user id, or null when the key is missing or
 * invalid. The ledger routes reuse this for owner-bound authorization instead
 * of duplicating bearer-token parsing. Callers must treat a non-null return
 * as "this request is authenticated as `referenceId`".
 */
export async function requireApiKey(c: Context): Promise<string | null> {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return null;
  try {
    const result = await auth.api.verifyApiKey({
      body: { key: token },
    });
    if (result.valid && result.key) return result.key.referenceId;
  } catch {
    return null;
  }
  return null;
}

export const inferenceRoutes = new Hono();

inferenceRoutes.get("/auth/check", async (c) => {
  const apiKey = await requireApiKey(c);
  if (!apiKey) return unauthorized(c);
  return c.json({ status: "ok" });
});

// NOTE: `POST /v1/chat/completions` was REMOVED here in Phase 3, Wave C1 — it
// moved to `src/transport/chat.ts` (createChatRoutes), which builds a LangChain
// agent from the installed MODEL plugin + per-request credentials and streams
// SSE via the transport adapter, instead of proxying INFERENCE_URL. The shared
// seams below (`extractBearerToken`, `requireApiKey`, `unauthorized`) stay here
// because sibling transports import them.
// NOTE: `GET /v1/models` was REMOVED here in Phase 3, Wave B — it moved to
// `src/transport/models.ts` (createModelsRoutes), which serves the installed
// MODEL plugins (incl. visionCapable) instead of proxying INFERENCE_URL. This
// keeps a single `/v1/models` owner and avoids a duplicate-path mount conflict.