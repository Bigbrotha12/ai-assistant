import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, describe } from "node:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { clearDeleting, markDeleting } from "../src/account_deletion.ts";

/**
 * C2 backstop coverage for the tri-state `requireApiKey` + `keyGateResponse`
 * as exercised by `GET /v1/auth/check` — the route is NOT exempt: it returns
 * the same distinct 403 `email_not_verified` so the probe can tell "verify
 * your email" from "re-auth".
 *
 * `src/auth.ts` (better-auth + its DB) is swapped for a deterministic fake
 * via `registerHooks` — the same mechanism production.integration.test.ts
 * uses — so the REAL `requireApiKey`/`keyGateResponse`/route logic runs
 * against scripted keys/users without touching the gateway's SQLite file.
 */

type FakeState = {
  keys: Map<string, string>;
  users: Map<string, { emailVerified: boolean }>;
};

const state: FakeState = {
  keys: new Map([
    ["sk-unverified", "user-unverified"],
    ["sk-verified", "user-verified"],
    ["sk-orphan", "user-missing"],
    ["sk-deleted", "user-deleted"],
  ]),
  users: new Map([
    ["user-unverified", { emailVerified: false }],
    ["user-verified", { emailVerified: true }],
    ["user-deleted", { emailVerified: true }],
  ]),
};

const fakeAuthModule = `
const state = () => globalThis.__apiKeyAuthState;
export const auth = {
  api: {
    verifyApiKey: async ({ body }) => {
      const referenceId = state().keys.get(body.key);
      if (!referenceId) return { valid: false };
      return { valid: true, key: { referenceId } };
    },
  },
};
export function getUserById(id) {
  const user = state().users.get(id);
  return user ? { id, emailVerified: user.emailVerified } : null;
}
`;

const globals = globalThis as typeof globalThis & { __apiKeyAuthState?: FakeState };
globals.__apiKeyAuthState = state;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth.ts" && context.parentURL?.includes("/src/api_key.ts")) {
      return {
        url: `data:text/javascript,${encodeURIComponent(fakeAuthModule)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { inferenceRoutes, requireApiKey } = await import("../src/api_key.ts");
hooks.deregister();

/** Minimal Context carrying only the Authorization header (all requireApiKey reads). */
function authCtx(header: string | undefined): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? header : undefined,
    },
  } as unknown as Context;
}

test("requireApiKey is a tri-state: bad_key / email_not_verified / ok", async () => {
  assert.deepEqual(await requireApiKey(authCtx(undefined)), {
    ok: false,
    reason: "bad_key",
  });
  assert.deepEqual(await requireApiKey(authCtx("Bearer sk-garbage")), {
    ok: false,
    reason: "bad_key",
  });
  assert.deepEqual(await requireApiKey(authCtx("Bearer sk-unverified")), {
    ok: false,
    reason: "email_not_verified",
  });
  assert.deepEqual(await requireApiKey(authCtx("Bearer sk-verified")), {
    ok: true,
    owner: "user-verified",
  });
  // Valid key whose user row no longer exists collapses to bad_key (401), not
  // to the 403 branch.
  assert.deepEqual(await requireApiKey(authCtx("Bearer sk-orphan")), {
    ok: false,
    reason: "bad_key",
  });
});

test("a tombstoned owner fails the API-key gate with account_deleted", async () => {
  markDeleting("user-deleted");
  try {
    assert.deepEqual(await requireApiKey(authCtx("Bearer sk-deleted")), {
      ok: false,
      reason: "account_deleted",
    });
    const app = new Hono();
    app.route("/v1", inferenceRoutes);
    const res = await app.request("/v1/auth/check", {
      headers: { authorization: "Bearer sk-deleted" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "account_deleted" });
  } finally {
    clearDeleting("user-deleted");
  }
});

describe("GET /v1/auth/check — C2 backstop gate", () => {
  const app = new Hono();
  app.route("/v1", inferenceRoutes);

  test("verified owner → 200 { status: ok }", async () => {
    const res = await app.request("/v1/auth/check", {
      headers: { authorization: "Bearer sk-verified" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("valid key but the owner's email is unverified → 403 { error: email_not_verified }", async () => {
    const res = await app.request("/v1/auth/check", {
      headers: { authorization: "Bearer sk-unverified" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "email_not_verified" });
  });

  test("missing Authorization header → 401 { error: unauthorized } (body unchanged)", async () => {
    const res = await app.request("/v1/auth/check");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("garbage key → 401 { error: unauthorized } (body unchanged)", async () => {
    const res = await app.request("/v1/auth/check", {
      headers: { authorization: "Bearer sk-garbage" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("valid key with an orphaned user row → 401 { error: unauthorized }", async () => {
    const res = await app.request("/v1/auth/check", {
      headers: { authorization: "Bearer sk-orphan" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});
