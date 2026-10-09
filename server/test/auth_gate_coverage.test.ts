import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { Catalogs } from "../src/catalog/index.ts";
import type { Ledger } from "../src/ledger.ts";
import { createLedgerRoutes } from "../src/ledger.routes.ts";
import { createNotifyRoutes } from "../src/notify/routes.ts";
import type { NotifyStore } from "../src/notify/store.ts";
import { createPluginRoutes } from "../src/plugins/routes.ts";
import type { PluginRegistry } from "../src/plugins/registry.ts";
import type { PluginStore } from "../src/plugins/store.ts";
import {
  createAuthCheckRoutes,
  type OwnerVariables,
  type VerifyApiKeyFn,
} from "../src/request_auth.ts";
import { createSentinelRoutes } from "../src/sentinel/routes.ts";
import { createSessionRoutes } from "../src/sessions/routes.ts";
import { createSessionStore } from "../src/sessions/store.ts";
import { createAgentsRoutes } from "../src/transport/agents.ts";
import { createChatRoutes } from "../src/transport/chat.ts";
import { createMcpRoutes } from "../src/transport/mcps.ts";
import { createModelsRoutes } from "../src/transport/models.ts";
import { createSkillsRoutes } from "../src/transport/skills.ts";

/**
 * Fail-closed guard: every route a router registers must sit behind the shared
 * `requireOwner` gate, so a newly added handler cannot accidentally run
 * unauthenticated. Each factory is built with a verifier that always denies,
 * each router is mounted at its production prefix, and every registered route
 * must answer 401 with the canonical body.
 *
 * A route added without the gate runs its handler and returns something else,
 * failing this test. The isolation tests guard the other direction: a router's
 * gate/body-limit must not leak onto a sibling mounted at the same prefix.
 */

const deny: VerifyApiKeyFn = async () => ({ ok: false, reason: "bad_key" });

const emptyCatalogs = {
  skills: [],
  mcps: [],
  agents: [],
} as unknown as Catalogs;
const stubRegistry = {
  listInstalledPlugins: () => [],
} as unknown as PluginRegistry;
const stubStore = {} as unknown as PluginStore;
const stubLedger = {} as unknown as Ledger;
const stubNotifyStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => false,
} as unknown as NotifyStore;

type RouterSpec = { name: string; mount: string; app: Hono<OwnerVariables> };

function gatedRouters(): RouterSpec[] {
  return [
    { name: "models", mount: "/v1", app: createModelsRoutes({ registry: stubRegistry, verifyKey: deny }) },
    {
      name: "agents",
      mount: "/v1",
      app: createAgentsRoutes({ registry: stubRegistry, catalogs: emptyCatalogs, verifyKey: deny }),
    },
    { name: "skills", mount: "/v1", app: createSkillsRoutes({ catalogs: emptyCatalogs, verifyKey: deny }) },
    { name: "mcps", mount: "/v1", app: createMcpRoutes({ catalogs: emptyCatalogs, verifyKey: deny }) },
    {
      name: "sessions",
      mount: "/v1",
      app: createSessionRoutes({ store: createSessionStore(), verifyKey: deny }),
    },
    { name: "sentinel", mount: "/v1", app: createSentinelRoutes({ ledger: stubLedger, verifyKey: deny }) },
    {
      name: "plugins",
      mount: "/v1",
      app: createPluginRoutes({ registry: stubRegistry, store: stubStore, verifyKey: deny }),
    },
    {
      name: "chat",
      mount: "/v1",
      app: createChatRoutes({ registry: stubRegistry, pluginStore: stubStore, verifyKey: deny }),
    },
    { name: "notify", mount: "/api/notify", app: createNotifyRoutes({ store: stubNotifyStore, verifyKey: deny }) },
    { name: "ledger", mount: "/ledger", app: createLedgerRoutes(stubLedger, { verifyKey: deny }) },
  ];
}

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "x");
}

test("every route on every gated router rejects an unauthenticated request", async () => {
  for (const { name, mount, app } of gatedRouters()) {
    const routes = app.routes.filter((route) => route.method !== "ALL");
    assert.ok(routes.length > 0, `${name} exposes at least one route`);
    const parent = new Hono();
    parent.route(mount, app);
    for (const route of routes) {
      const path = mount + concretePath(route.path);
      const res = await parent.request(path, { method: route.method });
      assert.equal(
        res.status,
        401,
        `${name}: ${route.method} ${path} must be gated (got ${res.status})`,
      );
      assert.deepEqual(
        await res.json(),
        { error: "unauthorized" },
        `${name}: ${route.method} ${path} must return the canonical body`,
      );
    }
  }
});

test("a gated router does not gate a sibling mounted at the same prefix", async () => {
  // All /v1 routers scope their gate to their own segment; a wildcard gate
  // would hoist to /v1/* and deny every sibling (the regression this guards).
  for (const { name, app } of gatedRouters().filter((spec) => spec.mount === "/v1")) {
    const parent = new Hono();
    parent.route("/v1", app);
    const sibling = new Hono();
    sibling.get("/__gate_probe__", (c) => c.json({ ok: true }));
    parent.route("/v1", sibling);
    const res = await parent.request("/v1/__gate_probe__");
    assert.equal(res.status, 200, `${name}'s gate leaked onto a sibling`);
  }
});

test("a router's body limit does not reject a sibling's oversized request", async () => {
  // Sentinel's default body cap (64 KB) is far below chat's establish cap; if
  // its bodyLimit leaked to /v1/* it would 413 normal chat requests.
  const parent = new Hono();
  parent.route("/v1", createSentinelRoutes({ ledger: stubLedger, verifyKey: deny }));
  const sibling = new Hono();
  sibling.post("/chat/completions", (c) => c.json({ ok: true }));
  parent.route("/v1", sibling);

  const res = await parent.request("/v1/chat/completions", {
    method: "POST",
    body: "x".repeat(100_000),
  });
  assert.equal(res.status, 200);
});

test("the auth-check router does not gate a sibling mounted at /v1", async () => {
  const parent = new Hono();
  parent.route("/v1", createAuthCheckRoutes());
  const sibling = new Hono();
  sibling.get("/sibling", (c) => c.json({ ok: true }));
  parent.route("/v1", sibling);

  const res = await parent.request("/v1/sibling");
  assert.equal(res.status, 200);
});
