import { Hono } from "hono";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { SessionStore } from "./store.ts";

/**
 * In-memory session read-back + delete surface (plan §5), mounted under `/v1`.
 *
 * Replaces `GET/DELETE /v1/threads/:threadId` as the conversation surface: the
 * client reads back the session's accumulated `messages` under the same
 * `session_id` it sent (the `reconcileFromServer`/`_reconcileAlreadyCompleted`
 * fetch) and deletes a conversation with `DELETE /v1/sessions/:id`. The store
 * is RAM-only and evictable; a live session the caller owns returns its
 * messages, everything else is an IDOR-safe miss (see below).
 *
 * AUTHORIZATION MODEL (single-owner homelab): every endpoint is gated only by
 * "is a valid API key"; the caller's `referenceId` is the owner and is passed
 * to every store method, which is owner-scoped.
 *
 * MISS SHAPES (IDOR-safe): a session the caller cannot read is either
 *   - another owner's session   -> 404 `{ error: "not_found" }`
 *   - the caller's OWN session gone (evicted, or never seen in this process)
 *                                -> 409 `{ error: "session_missing", reason }`
 * where `reason` is the store's tombstone-backed `"evicted" | "restart"`.
 * The cross-owner/absent split is resolved via `store.lookupOwner` (a live
 * session's owner) + `store.missingReason` (the caller's own tombstone).
 * Note: because the split exists, a 404 implies the id belongs to another
 * owner — a deliberate, plan-approved read-back contract (the *content* is
 * never leaked; only that the id is not the caller's).
 *
 * DELETE is owner-scoped and non-destructive cross-owner: another owner's
 * session, or an absent session, is a 404 — never a successful delete.
 */

/** Wire shape of a session message, mirroring the old checkpoint read-back so
 *  the client's existing message parser keeps working. */
export type SessionHistoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: BaseMessage["content"];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

/** BaseMessage -> `{ role, content, tool_calls?, tool_call_id? }` (the shape
 *  the old checkpoint read-back produced, kept so the client's existing
 *  message parser keeps working). */
export function serializeSessionMessages(messages: readonly BaseMessage[]): SessionHistoryMessage[] {
  return messages.map((message) => {
    const type = message.getType();
    const role = (type === "human" ? "user" : type === "ai" ? "assistant" : type) as SessionHistoryMessage["role"];
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new Error("unsupported_session_message");
    }
    const result: SessionHistoryMessage = { role, content: message.content };
    if (role === "assistant" && message instanceof AIMessage && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.tool_calls = message.tool_calls.map((call) => ({
        id: call.id ?? `call_${result.tool_calls?.length ?? 0}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    if (role === "tool" && message instanceof ToolMessage) result.tool_call_id = String(message.tool_call_id);
    return result;
  });
}

export type SessionRoutesOptions = {
  store: SessionStore;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
};

export function createSessionRoutes(opts: SessionRoutesOptions): Hono {
  const { store } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  routes.get("/sessions/:id", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const sessionId = c.req.param("id");
    const record = store.get(owner, sessionId);
    c.header("cache-control", "no-store");
    if (record) {
      return c.json({ sessionId, messages: serializeSessionMessages(record.messages) });
    }
    // Not the caller's live session. Another owner's -> 404 (never leaks the
    // messages); the caller's own missing session -> 409 session_missing with
    // the tombstone-backed reason so the client re-establishes under the same
    // session_id (§5).
    const ownerOf = store.lookupOwner(sessionId);
    if (ownerOf !== null && ownerOf !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(
      { error: "session_missing", reason: store.missingReason(owner, sessionId) ?? "restart" },
      409,
    );
  });

  // Conversation delete (§5): owner-scoped, replaces `DELETE /v1/threads/:id`.
  // Another owner's session, or an absent one, is a 404 — never a successful
  // delete and never a leak.
  routes.delete("/sessions/:id", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const sessionId = c.req.param("id");
    c.header("cache-control", "no-store");
    const ownerOf = store.lookupOwner(sessionId);
    if (ownerOf !== null && ownerOf !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    if (!store.deleteSession(owner, sessionId)) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ status: "ok" });
  });

  return routes;
}