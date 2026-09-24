import { Hono } from "hono";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { keyGateResponse, requireApiKey } from "../api_key.ts";
import {
  AccountDeletedError,
  assertNotDeleting,
  withOwnerBarrier,
} from "../account_deletion.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { NotifyStore } from "./store.ts";

/** Shape of `requireApiKey`: tri-state `KeyAuth` (owner / bad_key /
 *  email_not_verified). Re-exported from `plugins/routes.ts` (single
 *  definition; the plugin surface owns it). */
export type { VerifyApiKeyFn };

/**
 * ntfy push-notification provisioning surface (plan §Notifications), mounted
 * under `/api/notify` at the app root — alongside `/api/auth/*` — so the same
 * authenticated caller (the device) provisions its push credentials.
 *
 * SECURITY MODEL: the topic + access token are a secret, stored encrypted
 * server-side and never logged. Provisioning is authenticated via the same
 * `verifyKey` seam the checkpoint/plugin routes use (owner = the API key's
 * `referenceId`, gated through `keyGateResponse` — 401 bad key, 403
 * email_not_verified). The token is returned EXACTLY once, at first provision;
 * a later `provision` (or a read-only GET) only reports the topic. `rotate`
 * mints a new token for the SAME topic. `revoke` deletes the owner's stored
 * credentials so the next `provision` starts a brand-new topic+token.
 *
 * ENDPOINTS:
 *   POST /api/notify/provision — first call mints topic+token (the only time
 *       the token is revealed); repeat calls return topic + null token.
 *   GET  /api/notify/provision  — topic + null token, 404 until provisioned.
 *   POST /api/notify/rotate     — new token, same topic.
 *   POST /api/notify/revoke     — deletes the owner's credentials.
 *
 * Route-factory DI mirrors `createPluginRoutes(...)`: the store is injected
 * and the `verifyKey` seam swaps the real `requireApiKey` (which verifies
 * against better-auth's DB + the C2 email backstop) for a deterministic
 * `KeyAuth` stub in tests.
 */

export type NotifyRoutesOptions = {
  store: NotifyStore;
  /** Test seam; defaults to the real `requireApiKey` from api_key.ts. */
  verifyKey?: VerifyApiKeyFn;
};

/** Mints a fresh random ntfy access token (192 bits of entropy). */
function mintAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

async function runNotifyMutation<T>(
  c: Context,
  owner: string,
  mutation: (beforeWrite: () => void) => Promise<T>,
): Promise<T | Response> {
  try {
    return await withOwnerBarrier(owner, async () => {
      assertNotDeleting(owner);
      return mutation(() => assertNotDeleting(owner));
    });
  } catch (error) {
    return notifyError(c, error);
  }
}

export function createNotifyRoutes(opts: NotifyRoutesOptions): Hono {
  const { store } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  // First provision reveals the token exactly once; repeat calls (and the
  // read-only GET below) never reveal it again.
  routes.post("/provision", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    c.header("cache-control", "no-store");
    return runNotifyMutation(c, owner, async (beforeWrite) => {
      const existing = await store.get(owner);
      if (existing) {
        return c.json({
          topic: existing.topic,
          accessToken: null,
          newlyProvisioned: false,
        });
      }
      const topic = `assistant-${owner}-${randomBytes(8).toString("hex")}`;
      const accessToken = mintAccessToken();
      beforeWrite();
      await store.set(owner, { topic, accessToken });
      return c.json({ topic, accessToken, newlyProvisioned: true });
    });
  });

  // Read-only recovery: reveals only the topic, and only when already set.
  routes.get("/provision", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    c.header("cache-control", "no-store");
    try {
      const existing = await store.get(owner);
      if (!existing) return c.json({ error: "not_configured" }, 404);
      return c.json({
        topic: existing.topic,
        accessToken: null,
        newlyProvisioned: false,
      });
    } catch (e) {
      return notifyError(c, e);
    }
  });

  // Rotation: a NEW token for the SAME topic (subscribers keep their topic,
  // old token dies, new token ships).
  routes.post("/rotate", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    c.header("cache-control", "no-store");
    return runNotifyMutation(c, owner, async (beforeWrite) => {
      const existing = await store.get(owner);
      if (!existing) return c.json({ error: "not_configured" }, 404);
      const accessToken = mintAccessToken();
      beforeWrite();
      await store.set(owner, { topic: existing.topic, accessToken });
      return c.json({ topic: existing.topic, accessToken, rotated: true });
    });
  });

  // Revocation: drop the stored credentials entirely; the next provision mints
  // a brand-new topic + token.
  routes.post("/revoke", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    c.header("cache-control", "no-store");
    return runNotifyMutation(c, owner, async (beforeWrite) => {
      beforeWrite();
      await store.delete(owner);
      return c.json({ revoked: true });
    });
  });

  return routes;
}

function notifyError(c: Context, e: unknown): Response {
  if (e instanceof AccountDeletedError) {
    return c.json({ error: e.code }, 403);
  }
  // The store's error text deliberately omits credential material; the client
  // gets a generic code while the detail is logged server-side.
  console.error("notify: provisioning store error", e);
  return c.json({ error: "internal" }, 500);
}