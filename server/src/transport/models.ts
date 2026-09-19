import { Hono } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isModelPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";

/**
 * OpenAI-compatible `GET /v1/models` transport (Phase 3, Wave B).
 *
 * Replaces the Phase 1 proxy in `inference.ts` that forwarded `/v1/models` to
 * `INFERENCE_URL`. The models list is now compiled from the installed MODEL
 * plugins in the registry, so the client sees exactly what this gateway can
 * actually route to (incl. `visionCapable`) instead of whatever upstream
 * advertises.
 *
 * SECURITY CONTRACT (plan §3.3, guardrail): a plugin's `inference.endpoint`
 * and `baseUrls` may point at admin-trusted internal hosts (`vikunja.local`,
 * RFC1918 IPs) and must NEVER leave the gateway. `modelListFromPlugins`
 * therefore copies only id + capability metadata — `endpoint`, `baseUrls`,
 * `url` and any credential material are dropped by construction (the test
 * suite scans the serialized body recursively for `https://` and those keys).
 *
 * ROUTING / MOUNT ORDER: the old `GET /models` proxy was REMOVED from
 * `inferenceRoutes` (this transport is the single `/v1/models` owner), so the
 * mount order in `index.ts` introduces no duplicate-path shadowing.
 *
 * ERROR SHAPES (kept consistent with the proxy it replaces):
 *   - no/invalid key        -> 401 {"error":"unauthorized"}
 *   - registry unavailable  -> 502 {"error":"inference_unavailable"}
 *   - empty registry        -> 200 {"object":"list","data":[]}  (not an error)
 */

/** One OpenAI-compatible model entry. Never carries endpoint/baseUrls/url or credentials. */
export type ModelSummary = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  visionCapable: boolean;
  supportsStreaming: boolean;
  defaultModel: string;
  tokenLimit: number;
  parameters: Record<string, unknown>;
};

export type ModelsListResponse = {
  object: "list";
  data: ModelSummary[];
};

/** Build the models list from model plugin definitions, sorted by id. */
export function modelListFromPlugins(
  plugins: ModelPluginDefinition[],
): ModelsListResponse {
  const data = plugins
    .map((plugin): ModelSummary => ({
      id: plugin.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "plugin",
      visionCapable: plugin.inference.visionCapable,
      supportsStreaming: plugin.inference.supportsStreaming,
      defaultModel: plugin.inference.defaultModel,
      tokenLimit: plugin.inference.tokenLimit,
      parameters: sanitizeParameters(plugin.inference.parameters),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

/**
 * L3: a plugin's `inference.parameters` are echoed onto the wire verbatim —
 * a URL-shaped parameter value (or a key named `url`/`endpoint`/`host`) could
 * leak an admin-trusted internal endpoint, so they are stripped before the
 * models response is serialized. String values that begin with `http` are
 * dropped; keys named url/endpoint/host are dropped; nested objects are
 * sanitized recursively. Everything else passes through unchanged.
 */
export function sanitizeParameters(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === "url" || key === "endpoint" || key === "host") continue;
    if (typeof value === "string" && value.toLowerCase().startsWith("http")) {
      continue;
    }
    if (isRecord(value)) {
      out[key] = sanitizeParameters(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ModelsRoutesOptions = {
  registry: PluginRegistry;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
};

export function createModelsRoutes(opts: ModelsRoutesOptions): Hono {
  const { registry } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  routes.get("/models", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);

    let modelPlugins: ModelPluginDefinition[];
    try {
      modelPlugins = registry.listInstalledPlugins().filter(isModelPlugin);
    } catch (err) {
      console.error("models: plugin registry unavailable", err);
      return c.json({ error: "inference_unavailable" }, 502);
    }
    return c.json(modelListFromPlugins(modelPlugins));
  });

  return routes;
}