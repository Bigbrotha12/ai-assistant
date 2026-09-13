import { Hono } from "hono";
import type { Context } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import { createTokenBucketLimiter } from "../rate_limit.ts";
import { PluginRegistryError } from "./registry.ts";
import type { PluginRegistry } from "./registry.ts";
import { PluginStoreError } from "./store.ts";
import type { PluginStore } from "./store.ts";
import { PluginSchemaError } from "./types.ts";

/**
 * Plugin HTTP surface (Phase 1, Step 6), mounted under `/v1` by the app.
 *
 * Route-factory DI mirrors `createLedgerRoutes(l)`: `createPluginRoutes(...)`
 * takes the dependencies explicitly so tests pass a real `PluginStore`/
 * `PluginRegistry` over temp fixtures (no network, no DB) instead of booting
 * the server. The `verifyKey` seam swaps the real `requireApiKey` (which
 * verifies against better-auth's DB) for a deterministic stub in tests that
 * returns an owner id — or `null` to exercise the 401 path without ever
 * touching auth. The `limiter` seam swaps the default token bucket for a
 * deterministic stub in tests.
 *
 * AUTHORIZATION MODEL (single-owner homelab): this gateway is a personal
 * homelab appliance. Every ApiKey issued by better-auth belongs to the owner;
 * there is NO multi-tenant / admin-role concept anywhere in the system. All
 * plugin-management endpoints are therefore gated only by "is a valid key"
 * (which means "is the owner") and must NOT grow a role system. If this ever
 * becomes multi-tenant, the /v1/plugins/:id detail endpoint — which reveals
 * allowlisted base URLs pointing at admin-trusted internal hosts — needs an
 * explicit admin gate; today it is already auth-gated, and that single gate IS
 * the owner gate.
 *
 * SECURITY / PAYLOAD DECISION (list vs details):
 *   - `GET /v1/plugins` (the public-ish list) returns `registry.
 *     listAvailablePlugins()` verbatim — a `PluginSummary[]` in which the
 *     registry REDACTS every baseUrl `url` string and a model plugin's
 *     `inference.endpoint` (ids + display labels only). Admin-trusted internal
 *     hosts must never leak through the list. Tool `inputSchema`s ARE retained
 *     in the summary: they carry no secrets and the client renders them to
 *     build tool-call forms straight from the marketplace list, so keeping
 *     them avoids a redundant detail round-trip. The registry's own security
 *     contract (registry.ts) is the single authority on what each shape may
 *     carry — the routes do no extra reshaping.
 *   - `GET /v1/plugins/:id` (auth-gated) returns the FULL definition via
 *     `registry.getPluginDetails(id)` — baseUrls WITH `url` values and the
 *     model `inference.endpoint` included — so the client can render the
 *     install/config form. Credentials remain spec-only (label/required) in
 *     both shapes; values are never stored or serialized server-side.
 *
 * RATE LIMITING: the three MANAGEMENT endpoints (`reload`, `install`,
 * `uninstall`) are token-bucket limited per-owner via `createTokenBucketLimiter`
 * (`src/rate_limit.ts`), matching the inference limiter's `{"error":
 * "rate_limited"}` 429 shape. The GET list/detail endpoints are left unlimited
 * (read-only, cheap, and the leaks they could amplify are already redacted).
 *
 * ERROR MAPPING (ledger-style `{"error": <code>}`):
 *   PluginStoreError MANIFEST_NOT_FOUND            -> 404 plugin_not_found
 *   PluginStoreError PLUGIN_NOT_FOUND              -> 404 plugin_not_found
 *   PluginStoreError BUILTIN_UNINSTALL             -> 403 builtin_plugin
 *   PluginStoreError SSRF_REJECTED                 -> 400 plugin_rejected
 *        + generic reason; the detailed reason (URLs/IPs) is logged server-side
 *   PluginStoreError INVALID_PLUGIN                -> 400 invalid_plugin
 *   PluginStoreError NOT_LOADED/FILE_IO/CONFIG     -> 500 internal      (logged)
 *   PluginRegistryError PLUGIN_NOT_FOUND           -> 404 plugin_not_found
 *   PluginRegistryError PLUGIN_DISABLED/REMOVED    -> 500 internal      (logged)
 *   PluginSchemaError (store file rejected)        -> 500 invalid_config (logged)
 *   plugin_already_installed is returned by the install route itself (409)
 *   before delegating, because PluginStore.install is an idempotent no-op for
 *   installed ids and cannot signal "already there" on its own.
 */

/** Shape of `requireApiKey`: returns the owned user id or null (unauthenticated). */
export type VerifyApiKeyFn = (c: Context) => Promise<string | null>;

/** Per-owner token-bucket gate for the plugin-management endpoints. */
export type RateLimiterFn = (key: string) => boolean;

export type PluginRoutesOptions = {
  registry: PluginRegistry;
  /** Backing store; install/uninstall operate on it. Must be loaded first. */
  store: PluginStore;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
  /** Test seam; defaults to a real token bucket (30 req/min, burst 10). */
  limiter?: RateLimiterFn;
};

const managementLimiter = createTokenBucketLimiter(30, 10);

export function createPluginRoutes(opts: PluginRoutesOptions): Hono {
  const { registry, store } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const limiter = opts.limiter ?? managementLimiter;

  const routes = new Hono();

  // Public marketplace list. Auth-gated: the CLI/UI client needs a valid key
  // to see the catalog. Never leaks baseUrl url values (registry redacts).
  routes.get("/plugins", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    return c.json({ plugins: registry.listAvailablePlugins() });
  });

  // Full detail incl. baseUrl urls + inference.endpoint for the config form.
  routes.get("/plugins/:id", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const detail = registry.getPluginDetails(c.req.param("id"));
    if (!detail) return c.json({ error: "plugin_not_found" }, 404);
    return c.json(detail);
  });

  routes.post("/plugins/reload", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    if (!limiter(owner)) return c.json({ error: "rate_limited" }, 429);
    try {
      await registry.hotReload();
      return c.json({ status: "ok" });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  // Install an admin-curated manifest. No credentials ride this request; keys
  // are configured client-side per request at call time (credential.ts).
  routes.post("/plugins/:id/install", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    if (!limiter(owner)) return c.json({ error: "rate_limited" }, 429);
    const id = c.req.param("id");
    try {
      if (store.getPlugin(id)) {
        return c.json({ error: "plugin_already_installed" }, 409);
      }
      await store.install(id);
      return c.json({ status: "ok" });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  routes.post("/plugins/:id/uninstall", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    if (!limiter(owner)) return c.json({ error: "rate_limited" }, 429);
    try {
      await store.uninstall(c.req.param("id"));
      return c.json({ status: "ok" });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  return routes;
}

function pluginError(c: Context, e: unknown): Response {
  if (e instanceof PluginStoreError) {
    switch (e.code) {
      case "MANIFEST_NOT_FOUND":
      case "PLUGIN_NOT_FOUND":
        return c.json({ error: "plugin_not_found" }, 404);
      case "BUILTIN_UNINSTALL":
        return c.json({ error: "builtin_plugin" }, 403);
      case "SSRF_REJECTED":
        // The message lists the exact allowlist entry ids, URLs and resolved
        // private IPs — invaluable server-side, but it must never ship to a
        // client. Log the detail and return a generic, actionable reason.
        console.error("plugins: install/reload rejected by SSRF policy", e);
        return c.json(
          {
            error: "plugin_rejected",
            reason: "base URL not allowed by network policy (see server logs)",
          },
          400,
        );
      case "INVALID_PLUGIN":
        return c.json({ error: "invalid_plugin" }, 400);
      default:
        console.error("plugins: unexpected store error", e);
        return c.json({ error: "internal" }, 500);
    }
  }
  if (e instanceof PluginRegistryError) {
    if (e.code === "PLUGIN_NOT_FOUND") {
      return c.json({ error: "plugin_not_found" }, 404);
    }
    console.error("plugins: unexpected registry error", e);
    return c.json({ error: "internal" }, 500);
  }
  if (e instanceof PluginSchemaError) {
    // Corrupt/unparseable store file surfaced during hot-reload; a server-side
    // config problem, not something the client can fix.
    console.error("plugins: store reload rejected", e);
    return c.json({ error: "invalid_config" }, 500);
  }
  console.error("plugins: unexpected error", e);
  return c.json({ error: "internal" }, 500);
}