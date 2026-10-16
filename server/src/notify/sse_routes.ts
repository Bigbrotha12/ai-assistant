import { Hono } from "hono";
import { requireApiKey, requireOwner } from "../auth/request_auth.ts";
import type { OwnerVariables, VerifyApiKeyFn } from "../auth/request_auth.ts";
import type { SseHub } from "./sse_hub.ts";

/**
 * Owner-scoped SSE notification stream, mounted at the exclusive `/v1/notify`.
 *
 *   GET /v1/notify/events — one long-lived `text/event-stream` per connected
 *       client, held open until the client disconnects. Every job-completion
 *       event is exactly one `data:` frame carrying
 *       `{"title":"Job <taskId>","body":<summary>}` (no per-topic field);
 *       `:` comment lines are keep-alives and carry no event.
 *
 * The router is gated with `requireOwner` over `*`. That wildcard is safe only
 * because `/v1/notify` is exclusive to this router — do NOT mount it at the
 * shared `/v1` root, where the gate would leak onto every sibling router.
 *
 * The hub is injected and the `verifyKey` seam swaps the real verifier for a
 * deterministic stub in tests.
 */
export type SseNotifyRoutesOptions = {
  hub: SseHub;
  /** Test seam; defaults to the real `requireApiKey` from auth/request_auth.ts. */
  verifyKey?: VerifyApiKeyFn;
};

export function createSseNotifyRoutes(
  opts: SseNotifyRoutesOptions,
): Hono<OwnerVariables> {
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono<OwnerVariables>();
  routes.use("*", requireOwner(verifyKey));

  routes.get("/events", (c) => {
    const { response, close } = opts.hub.open(c.get("owner"));
    // The hub already drops the stream on the body's cancel callback; this is
    // the request-abort path, and close is idempotent.
    c.req.raw.signal.addEventListener("abort", close, { once: true });
    return response;
  });

  return routes;
}
