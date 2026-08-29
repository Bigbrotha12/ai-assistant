import { Hono } from "hono";
import type { Context } from "hono";
import { auth } from "./auth.ts";
import { env } from "./env.ts";
import { createTokenBucketLimiter } from "./rate_limit.ts";

function extractBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return match ? match[1]!.trim() : null;
}

function unauthorized(c: Context): Response {
  return c.json({ error: "unauthorized" }, 401);
}

async function requireApiKey(c: Context): Promise<string | null> {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return null;
  try {
    const result = await auth.api.verifyApiKey({
      body: { key: token },
    });
    if (result.valid) return token;
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

inferenceRoutes.get("/models", async (c) => {
  const apiKey = await requireApiKey(c);
  if (!apiKey) return unauthorized(c);

  const upstream = new URL("/v1/models", env.INFERENCE_URL);

  try {
    const resp = await fetch(upstream, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    console.error("gateway: upstream models request failed", err);
    return c.json({ error: "inference_unavailable" }, 502);
  }
});