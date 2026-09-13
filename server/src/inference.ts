import { Hono } from "hono";
import type { Context } from "hono";
import { auth } from "./auth.ts";
import { env } from "./env.ts";
import { createTokenBucketLimiter } from "./rate_limit.ts";

function extractBearerToken(header: string | null | undefined): string | null {
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

const inferenceLimiter = createTokenBucketLimiter(
  env.INFERENCE_RATE_LIMIT,
  env.INFERENCE_RATE_BURST,
);

inferenceRoutes.get("/auth/check", async (c) => {
  const apiKey = await requireApiKey(c);
  if (!apiKey) return unauthorized(c);
  return c.json({ status: "ok" });
});

inferenceRoutes.post("/chat/completions", async (c) => {
  const apiKey = await requireApiKey(c);
  if (!apiKey) return unauthorized(c);
  if (!inferenceLimiter(apiKey)) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.text();
  const upstream = new URL("/v1/chat/completions", env.INFERENCE_URL);

  try {
    const resp = await fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": c.req.header("content-type") ?? "application/json",
        accept: c.req.header("accept") ?? "text/event-stream",
      },
      body,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "text/event-stream",
        "cache-control": resp.headers.get("cache-control") ?? "no-cache",
      },
    });
  } catch (err) {
    console.error("gateway: upstream chat/completions request failed", err);
    return c.json({ error: "inference_unavailable" }, 502);
  }
});
// NOTE: `GET /v1/models` was REMOVED here in Phase 3, Wave B — it moved to
// `src/transport/models.ts` (createModelsRoutes), which serves the installed
// MODEL plugins (incl. visionCapable) instead of proxying INFERENCE_URL. This
// keeps a single `/v1/models` owner and avoids a duplicate-path mount conflict.