import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { inferenceRoutes } from "../../src/inference.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import {
  createModelsRoutes,
  modelListFromPlugins,
} from "../../src/transport/models.ts";
import type { ModelsListResponse } from "../../src/transport/models.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import type {
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

function openRouterPlugin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "1.0.0",
    schemaVersion: 1,
    type: "model",
    name: "OpenRouter",
    description: "Aggregated LLM inference",
    inference: {
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "openrouter/auto",
      tokenLimit: 131_072,
      supportsStreaming: true,
      visionCapable: true,
      parameters: {},
    },
    baseUrls: [{ id: "openrouter-api", url: "https://openrouter.ai/api/v1" }],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
  };
}

function secondaryModelPlugin(): ModelPluginDefinition {
  return {
    id: "azure-openai",
    version: "0.2.0",
    schemaVersion: 1,
    type: "model",
    name: "Azure OpenAI",
    description: "Admin-installed model plugin",
    inference: {
      endpoint: "https://example.openai.azure.com/openai/v1",
      defaultModel: "gpt-4o",
      tokenLimit: 128_000,
      supportsStreaming: true,
      visionCapable: false,
      parameters: { temperature: 0.2 },
    },
  };
}

function toolPlugin(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.4.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "Task management tools",
    tools: [
      {
        name: "list_tasks",
        description: "List tasks",
        readOnly: true,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Token", required: true } },
  };
}

const DNS: Record<string, LookupAddress[]> = {
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "example.openai.azure.com": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
};

function fakeLookup(records: Record<string, readonly LookupAddress[]> = DNS): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "models-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeEnv(
  dir: string,
): Promise<{ store: PluginStore; registry: PluginRegistry }> {
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    // The tool plugin is a builtin so it is "installed" — proving the route
    // filters to MODEL plugins only.
    builtinPlugins: [openRouterPlugin(), secondaryModelPlugin(), toolPlugin()],
    manifests: [],
    lookup: fakeLookup(),
  });
  await store.load();
  return { store, registry: new PluginRegistry(store) };
}

async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
): Promise<{ app: Hono; registry: PluginRegistry }> {
  const dir = await makeTempDir(t);
  const { registry } = await makeEnv(dir);
  const app = new Hono();
  app.route(
    "/v1",
    createModelsRoutes({
      registry,
      verifyKey: verifyKey ?? (async () => "test-user"),
    }),
  );
  return { app, registry };
}

const auth = { authorization: "Bearer test-key" };

/**
 * Recursively assert a serialized models payload never carries a provider URL
 * or the redacted keys. Guards the plan §3.3 / guardrail contract.
 */
function assertNoUrlLeak(node: unknown, path: string): void {
  if (typeof node === "string") {
    assert.equal(node.includes("https://"), false, `leaked URL at ${path}: ${node}`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((value, i) => assertNoUrlLeak(value, `${path}[${i}]`));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      for (const forbidden of ["endpoint", "baseUrls", "url"]) {
        assert.notEqual(key, forbidden, `leaked '${forbidden}' key at ${path}.${key}`);
      }
      assertNoUrlLeak(value, `${path}.${key}`);
    }
  }
}

describe("modelListFromPlugins (pure)", () => {
  test("maps a model plugin to an OpenAI entry with redacted capability metadata", () => {
    const result = modelListFromPlugins([openRouterPlugin()]);

    assert.equal(result.object, "list");
    assert.equal(result.data.length, 1);
    const entry = result.data[0]!;
    assert.equal(entry.id, "openrouter");
    assert.equal(entry.object, "model");
    assert.ok(
      Number.isInteger(entry.created) && entry.created > 0,
      "created is a real epoch-seconds timestamp, not 0",
    );
    assert.equal(entry.owned_by, "plugin");
    assert.equal(entry.visionCapable, true);
    assert.equal(entry.supportsStreaming, true);
    assert.equal(entry.defaultModel, "openrouter/auto");
    assert.equal(entry.tokenLimit, 131_072);
    assert.deepEqual(entry.parameters, {});
    assertNoUrlLeak(result, "result");
  });

  test("L3: sanitizes inference.parameters — URL-shaped values and url/endpoint/host keys never reach the wire", () => {
    const plugin: ModelPluginDefinition = {
      ...openRouterPlugin(),
      inference: {
        ...openRouterPlugin().inference,
        parameters: {
          temperature: 0.2,
          maxTokens: 512,
          endpoint: "https://openrouter.ai/api/v1",
          url: "https://internal.vikunja.local",
          host: "10.0.0.5",
          baseUrlValue: "https://example.com",
          nested: {
            apiUrl: "https://admin.internal.example",
            keep: true,
          },
        },
      },
    };
    const result = modelListFromPlugins([plugin]);
    assert.deepEqual(result.data[0]!.parameters, {
      temperature: 0.2,
      maxTokens: 512,
      nested: { keep: true },
    });
    assertNoUrlLeak(result, "result");
    assert.equal(
      JSON.stringify(result).includes("https://"),
      false,
      "URL-shaped parameter values must not leak",
    );
  });

  test("sorts entries by plugin id", () => {
    const result = modelListFromPlugins([
      openRouterPlugin(),
      secondaryModelPlugin(),
    ]);
    assert.deepEqual(
      result.data.map((m) => m.id),
      ["azure-openai", "openrouter"],
    );
  });

  test("empty input → empty list", () => {
    assert.deepEqual(modelListFromPlugins([]), { object: "list", data: [] });
  });
});

describe("GET /v1/models (HTTP)", () => {
  test("200 with installed model plugins incl. visionCapable — no URL leak", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/models", { headers: auth });
    assert.equal(res.status, 200);

    const body = (await res.json()) as ModelsListResponse;
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["azure-openai", "openrouter"],
      "tool plugins are excluded and entries are id-sorted",
    );
    assert.ok(body.data.every((m) => m.object === "model" && m.owned_by === "plugin"));

    const openrouter = body.data.find((m) => m.id === "openrouter")!;
    assert.equal(openrouter.visionCapable, true);
    assert.equal(openrouter.supportsStreaming, true);
    assert.equal(openrouter.defaultModel, "openrouter/auto");
    assert.equal(openrouter.tokenLimit, 131_072);
    assert.deepEqual(openrouter.parameters, {});

    const azure = body.data.find((m) => m.id === "azure-openai")!;
    assert.equal(azure.visionCapable, false);
    assert.deepEqual(azure.parameters, { temperature: 0.2 });

    assert.equal(
      JSON.stringify(body).includes("https://"),
      false,
      "models list must not leak plugin endpoints/baseUrls",
    );
    assertNoUrlLeak(body, "body");
  });

  test("empty registry → 200 empty list (not an error)", async (t) => {
    const dir = await makeTempDir(t);
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [],
      manifests: [],
      lookup: fakeLookup(),
    });
    await store.load();
    const registry = new PluginRegistry(store);
    const app = new Hono();
    app.route(
      "/v1",
      createModelsRoutes({ registry, verifyKey: async () => "test-user" }),
    );

    const res = await app.request("/v1/models", { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { object: "list", data: [] });
  });

  test("registry error → 502 { error: inference_unavailable }", async (t) => {
    const dir = await makeTempDir(t);
    // Never loaded → listInstalledPlugins() throws NOT_LOADED.
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [],
      manifests: [],
      lookup: fakeLookup(),
    });
    const registry = new PluginRegistry(store);
    const app = new Hono();
    app.route(
      "/v1",
      createModelsRoutes({ registry, verifyKey: async () => "test-user" }),
    );

    const res = await app.request("/v1/models", { headers: auth });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "inference_unavailable" });
  });

  test("401 { error: unauthorized } when the verifier returns null", async (t) => {
    const { app } = await makeApp(t, async () => null);
    const res = await app.request("/v1/models", { headers: auth });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

describe("GET /v1/models — mount order / single owner", () => {
  test("inferenceRoutes no longer registers GET /models (proxy removed)", async () => {
    const res = await inferenceRoutes.request("/models");
    assert.equal(res.status, 404, "the inference proxy must not own /models");
  });

  test("mounted as index.ts does, the plugin transport serves /v1/models", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);
    const app = new Hono();
    app.route("/v1", inferenceRoutes);
    app.route(
      "/v1",
      createModelsRoutes({ registry, verifyKey: async () => "test-user" }),
    );

    const res = await app.request("/v1/models", { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as ModelsListResponse;
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["azure-openai", "openrouter"],
    );
    assert.equal(JSON.stringify(body).includes("https://"), false);
  });
});