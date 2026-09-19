import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { createPluginRoutes } from "../../src/plugins/routes.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import type { ModelPluginDefinition, ToolPluginDefinition } from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

function openRouterBuiltin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "1.0.0",
    schemaVersion: 1,
    type: "model",
    name: "OpenRouter",
    description: "Aggregated LLM inference",
    inference: {
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-3.5-sonnet",
      tokenLimit: 200_000,
      supportsStreaming: true,
      visionCapable: true,
      parameters: {},
    },
    baseUrls: [{ id: "openrouter-api", url: "https://openrouter.ai" }],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
  };
}

function vikunjaManifest(): ToolPluginDefinition {
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
        description: "List tasks from a project",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Personal access token", required: true } },
  };
}

function mealieManifest(): ToolPluginDefinition {
  return {
    id: "mealie",
    version: "0.9.0",
    schemaVersion: 1,
    type: "tool",
    name: "Mealie",
    description: "Recipe management",
    tools: [
      {
        name: "list_recipes",
        description: "List recipes",
        readOnly: true,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "mealie-api", url: "https://mealie.example.com" }],
  };
}

// `evil.local` resolves to a private address → SSRF-rejected unless trusted.
function evilManifest(): ToolPluginDefinition {
  return {
    id: "evil",
    version: "0.1.0",
    schemaVersion: 1,
    type: "tool",
    name: "Evil",
    description: "A manifest whose baseUrl is not SSRF-safe",
    tools: [
      {
        name: "peek",
        description: "Peek at internal networks",
        readOnly: true,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "evil-api", url: "https://evil.local" }],
  };
}

const DNS: Record<string, LookupAddress[]> = {
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  "mealie.example.com": [{ address: "1.1.1.1", family: 4 }],
  "evil.local": [{ address: "10.0.0.5", family: 4 }],
};

function fakeLookup(
  records: Record<string, readonly LookupAddress[]> = DNS,
): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plugin-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeEnv(
  dir: string,
  extraManifests: ToolPluginDefinition[] = [],
): Promise<{
  store: PluginStore;
  registry: PluginRegistry;
  storePath: string;
}> {
  const storePath = join(dir, "plugins.json");
  const store = new PluginStore({
    storePath,
    trustedHosts: [],
    builtinPlugins: [openRouterBuiltin()],
    manifests: [vikunjaManifest(), mealieManifest(), ...extraManifests],
    lookup: fakeLookup(),
  });
  await store.load();
  const registry = new PluginRegistry(store);
  return { store, registry, storePath };
}

/**
 * Build the app the way src/index.ts does (`app.route("/v1", routes)`) but
 * with the auth verifier swapped for a deterministic stub, so tests exercise
 * the full HTTP surface without better-auth's DB.
 */
async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
): Promise<{
  app: Hono;
  store: PluginStore;
  registry: PluginRegistry;
  storePath: string;
}> {
  const dir = await makeTempDir(t);
  const { store, registry, storePath } = await makeEnv(dir);
  const app = new Hono();
  app.route(
    "/v1",
    createPluginRoutes({
      registry,
      store,
      verifyKey: verifyKey ?? (async () => "test-user"),
    }),
  );
  return { app, store, registry, storePath };
}

const auth = { authorization: "Bearer test-key" };

async function json(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

describe("plugin routes — list endpoint", () => {
  test("GET /v1/plugins returns redacted summaries — no url strings in the body", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins", { headers: auth });
    assert.equal(res.status, 200);

    const bodyText = await res.text();
    assert.equal(
      bodyText.includes("https://"),
      false,
      "list payload must not leak baseUrl url values or endpoints",
    );

    const body = JSON.parse(bodyText) as { plugins: any[] };
    assert.deepEqual(
      body.plugins.map((p) => p.id),
      ["openrouter", "vikunja", "mealie"],
    );

    const openrouter = body.plugins.find((p) => p.id === "openrouter")!;
    assert.equal(openrouter.type, "model");
    assert.equal(openrouter.installed, true);
    assert.deepEqual(openrouter.baseUrls, [{ id: "openrouter-api" }]);
    assert.ok(openrouter.baseUrls.every((b: Record<string, unknown>) => !("url" in b)));
    assert.ok(!("endpoint" in openrouter.inference), "model endpoint redacted");
    assert.equal(openrouter.inference.visionCapable, true);
    assert.equal(
      openrouter.credentials.apiKey.label,
      "OpenRouter API key",
      "credential labels are safe for client UI",
    );

    const vikunja = body.plugins.find((p) => p.id === "vikunja")!;
    assert.equal(vikunja.installed, false);
    assert.equal(vikunja.tools[0].name, "list_tasks");
    assert.equal(vikunja.tools[0].description, "List tasks from a project");
    assert.equal(vikunja.tools[0].readOnly, true);
    assert.deepEqual(vikunja.tools[0].inputSchema.required, ["projectId"]);
    assert.ok(vikunja.baseUrls.every((b: Record<string, unknown>) => !("url" in b)));
  });
});

describe("plugin routes — details endpoint", () => {
  test("GET /v1/plugins/:id returns the full definition incl. baseUrl urls and endpoint", async (t) => {
    const { app } = await makeApp(t);

    const openrouter = (await (await app.request("/v1/plugins/openrouter", { headers: auth })).json()) as any;
    assert.equal(openrouter.installed, true);
    assert.deepEqual(openrouter.baseUrls, [
      { id: "openrouter-api", url: "https://openrouter.ai" },
    ]);
    assert.equal(openrouter.inference.endpoint, "https://openrouter.ai/api/v1");
    assert.equal(openrouter.credentials.apiKey.label, "OpenRouter API key");

    const vikunja = (await (await app.request("/v1/plugins/vikunja", { headers: auth })).json()) as any;
    assert.equal(vikunja.installed, false);
    assert.equal(vikunja.baseUrls[0].url, "https://vikunja.example.com");
    assert.equal(vikunja.tools[0].name, "list_tasks");
  });

  test("unknown id → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/ghost", { headers: auth });
    assert.equal(res.status, 404);
    assert.deepEqual(await json(res), { error: "plugin_not_found" });
  });
});

describe("plugin routes — install/uninstall lifecycle", () => {
  test("install → 200, list flips to installed; second install → 409", async (t) => {
    const { app } = await makeApp(t);

    const install = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: auth,
    });
    assert.equal(install.status, 200);
    assert.deepEqual(await json(install), { status: "ok" });

    const list = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: any[] };
    assert.equal(list.plugins.find((p) => p.id === "vikunja")!.installed, true);

    const reinstall = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: auth,
    });
    assert.equal(reinstall.status, 409);
    assert.deepEqual(await json(reinstall), { error: "plugin_already_installed" });
  });

  test("unknown manifest id → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/ghost/install", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await json(res), { error: "plugin_not_found" });
  });

  test("manifest whose baseUrl fails SSRF → 400 plugin_rejected with reason", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir, [evilManifest()]);
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({ registry, store, verifyKey: async () => "test-user" }),
    );

    const res = await app.request("/v1/plugins/evil/install", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; reason: string };
    assert.equal(body.error, "plugin_rejected");
    // Fix 11: the reason must NOT leak the failing URL or resolved IP — the
    // admin sees them in the server log instead.
    assert.equal(body.reason, "base URL not allowed by network policy (see server logs)");
    assert.ok(
      !body.reason.includes("evil.local"),
      "response body must not leak failing URL",
    );
    // Nothing persisted: a later list still shows it uninstalled.
    const list = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: any[] };
    assert.equal(list.plugins.find((p) => p.id === "evil")!.installed, false);
  });

  test("uninstall installed → 200 and list flips to not installed", async (t) => {
    const { app } = await makeApp(t);
    await app.request("/v1/plugins/vikunja/install", { method: "POST", headers: auth });

    const uninstall = await app.request("/v1/plugins/vikunja/uninstall", {
      method: "POST",
      headers: auth,
    });
    assert.equal(uninstall.status, 200);
    assert.deepEqual(await json(uninstall), { status: "ok" });

    const list = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: any[] };
    assert.equal(list.plugins.find((p) => p.id === "vikunja")!.installed, false);
  });

  test("uninstall a builtin → 403 builtin_plugin", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/openrouter/uninstall", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await json(res), { error: "builtin_plugin" });
  });

  test("uninstall a known-but-not-installed manifest → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/mealie/uninstall", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await json(res), { error: "plugin_not_found" });
  });
});

describe("plugin routes — reload", () => {
  test("POST /v1/plugins/reload → 200 status ok", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { status: "ok" });
  });

  test("reload rejects a corrupted store file → 500 invalid_config", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry, storePath } = await makeEnv(dir);
    await writeFile(storePath, "not json {", "utf8");
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({ registry, store, verifyKey: async () => "test-user" }),
    );

    const res = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: auth,
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await json(res), { error: "invalid_config" });
  });
});

describe("plugin routes — rate limiting (Fix 5)", () => {
  async function makeLimitedApp(
    t: TestContext,
    limiter: (key: string) => boolean,
  ): Promise<Hono> {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({
        registry,
        store,
        verifyKey: async () => "test-user",
        limiter,
      }),
    );
    return app;
  }

  test("POST /v1/plugins/reload → 429 rate_limited once the bucket is exhausted", async (t) => {
    let allowed = 1;
    const limiter = () => allowed-- > 0;
    const app = await makeLimitedApp(t, limiter);

    const first = await app.request("/v1/plugins/reload", { method: "POST", headers: auth });
    assert.equal(first.status, 200);
    assert.deepEqual(await json(first), { status: "ok" });

    const second = await app.request("/v1/plugins/reload", { method: "POST", headers: auth });
    assert.equal(second.status, 429);
    assert.deepEqual(await json(second), { error: "rate_limited" });
  });

  test("install and uninstall are rate-limited with the same 429 shape", async (t) => {
    const limiter = () => false;
    const app = await makeLimitedApp(t, limiter);

    for (const path of ["/v1/plugins/vikunja/install", "/v1/plugins/vikunja/uninstall"]) {
      const res = await app.request(path, { method: "POST", headers: auth });
      assert.equal(res.status, 429, path);
      assert.deepEqual(await json(res), { error: "rate_limited" }, path);
    }
  });

  test("the default limiter permits normal usage (GET list still unlimited)", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({ registry, store, verifyKey: async () => "test-user" }),
    );
    for (let i = 0; i < 25; i++) {
      const list = await app.request("/v1/plugins", { headers: auth });
      assert.equal(list.status, 200, `iteration ${i}`);
    }
  });
});

describe("plugin routes — auth", () => {
  test("every endpoint → 401 unauthorized when the verifier returns null", async (t) => {
    const { app } = await makeApp(t, async () => null);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/plugins"],
      ["GET", "/v1/plugins/openrouter"],
      ["POST", "/v1/plugins/vikunja/install"],
      ["POST", "/v1/plugins/vikunja/uninstall"],
      ["POST", "/v1/plugins/reload"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: auth });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await json(res), { error: "unauthorized" }, `${method} ${path}`);
    }
  });
});