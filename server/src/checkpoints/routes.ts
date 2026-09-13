import { Hono } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { CheckpointStore } from "./store.ts";

/**
 * Conversation checkpoint HTTP surface (Phase 2, Wave B1), mounted under `/v1`.
 *
 * Route-factory DI mirrors `createPluginRoutes(...)`: the store is injected
 * explicitly, and the `verifyKey` seam swaps the real `requireApiKey` (which
 * verifies against better-auth's DB) for a deterministic stub in tests that
 * returns an owner id — or `null` to exercise the 401 path without auth.
 *
 * AUTHORIZATION MODEL (single-owner homelab): every endpoint is gated only by
 * "is a valid API key", exactly like the plugin routes; the caller's
 * `referenceId` is the owner and is passed to every store method, which is
 * owner-scoped. There is no admin role. A cross-owner or unknown thread is a
 * `not_found` (delete) / omitted row (list) — never a leak.
 *
 * ENDPOINTS:
 *   GET    /v1/threads            — list the caller's conversations.
 *   DELETE /v1/threads/:threadId  — owner-scoped hard delete; 404 if absent.
 *   DELETE /v1/threads            — per-user GC; `{"deleted": N}`.
 */

/** Shape of `requireApiKey`: returns the owned user id or null. Re-exported
 *  from `plugins/routes.ts` (single definition; the plugin surface owns it). */
export type { VerifyApiKeyFn };

export type CheckpointRoutesOptions = {
  store: CheckpointStore;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
};

export function createCheckpointRoutes(opts: CheckpointRoutesOptions): Hono {
  const { store } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  // Phase 5's list-conversations. Minimal: id + timestamps + message-count
  // proxy, owner-scoped.
  routes.get("/threads", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    return c.json({ threads: store.listThreads(owner) });
  });

  // Per-user GC: deletes ALL of the caller's threads (and their checkpoints).
  routes.delete("/threads", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    return c.json({ deleted: store.deleteThreadsForOwner(owner) });
  });

  // Conversation delete. Owner-scoped: another user's thread is a 404, never a
  // successful delete.
  routes.delete("/threads/:threadId", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const deleted = store.deleteThread(owner, c.req.param("threadId"));
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ status: "ok" });
  });

  return routes;
}
