import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PluginStore } from "../../src/plugins/store.ts";
import { computeManifestDigest } from "../../src/plugins/digest.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { createPluginRoutes } from "../../src/plugins/routes.ts";
import {
  isSuperuserToken,
  requireSuperuser,
  SUPERUSER_OWNER,
} from "../../src/auth/request_auth.ts";
import type { OwnerVariables, VerifyApiKeyFn } from "../../src/auth/request_auth.ts";
import type { AgentPluginDefinition, ModelPluginDefinition, ToolPluginDefinition } from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import { logger } from "../../src/observability/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";

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
      mode: "chat",
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
 * A configured superuser ops secret. Detail + management endpoints require
 * this (or any entry of the rotation list) instead of an ordinary owner key.
 */
const SUPERUSER_KEY = "test-superuser-key";
const superAuth = { authorization: `Bearer ${SUPERUSER_KEY}` };
const auth = { authorization: "Bearer test-key" };

/**
 * Build the app the way src/index.ts does (`app.route("/v1", routes)`) but
 * with the auth verifier swapped for a deterministic stub, so tests exercise
 * the full HTTP surface without better-auth's DB.
 */
async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
  limiter?: (key: string) => boolean,
  superuserKeysOption: readonly string[] = [SUPERUSER_KEY],
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
      verifyKey: verifyKey ?? (async () => ({ ok: true as const, owner: "test-user" })),
      superuserKeys: superuserKeysOption,
      limiter,
    }),
  );
  return { app, store, registry, storePath };
}

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

    const openrouter = (await (await app.request("/v1/plugins/openrouter", { headers: superAuth })).json()) as any;
    assert.equal(openrouter.installed, true);
    assert.deepEqual(openrouter.baseUrls, [
      { id: "openrouter-api", url: "https://openrouter.ai" },
    ]);
    assert.equal(openrouter.inference.endpoint, "https://openrouter.ai/api/v1");
    assert.equal(openrouter.credentials.apiKey.label, "OpenRouter API key");

    const vikunja = (await (await app.request("/v1/plugins/vikunja", { headers: superAuth })).json()) as any;
    assert.equal(vikunja.installed, false);
    assert.equal(vikunja.baseUrls[0].url, "https://vikunja.example.com");
    assert.equal(vikunja.tools[0].name, "list_tasks");
  });

  test("agent plugin details omit MCP header values", async (t) => {
    const dir = await makeTempDir(t);
    const agent: AgentPluginDefinition = {
      id: "private-agent",
      version: "1.0.0",
      schemaVersion: 1,
      type: "agent",
      name: "Private Agent",
      description: "agent",
      systemPrompt: "system",
      mcpServers: [{
        name: "private-mcp",
        url: "https://mcp.example.com",
        headers: { "X-Api-Key": "secret-value" },
      }],
    };
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin(), agent],
      manifests: [],
      lookup: fakeLookup(),
    });
    await store.load();
    const registry = new PluginRegistry(store);
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({
        registry,
        store,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        superuserKeys: [SUPERUSER_KEY],
      }),
    );

    const response = await app.request("/v1/plugins/private-agent", { headers: superAuth });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("secret-value"), false);
    assert.equal(text.includes("X-Api-Key"), false);
    assert.deepEqual(
      (JSON.parse(text) as { mcpServers: unknown }).mcpServers,
      [{ name: "private-mcp" }],
    );
  });

  test("unknown id → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/ghost", { headers: superAuth });
    assert.equal(res.status, 404);
    assert.deepEqual(await json(res), { error: "plugin_not_found" });
  });

  test("an ordinary owner key cannot read full detail → 403 forbidden", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/openrouter", { headers: auth });
    assert.equal(res.status, 403);
    assert.deepEqual(await json(res), { error: "forbidden" });
  });
});

describe("plugin routes — install/uninstall lifecycle", () => {
  test("install → 200, list flips to installed; second install → 409", async (t) => {
    const { app } = await makeApp(t);

    const install = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(install.status, 200);
    assert.deepEqual(await json(install), { status: "ok" });

    const list = (await (await app.request("/v1/plugins", { headers: auth })).json()) as { plugins: any[] };
    assert.equal(list.plugins.find((p) => p.id === "vikunja")!.installed, true);

    const reinstall = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(reinstall.status, 409);
    assert.deepEqual(await json(reinstall), { error: "plugin_already_installed" });
  });

  test("installing a builtin remains 409 plugin_already_installed", async (t) => {
    const { app } = await makeApp(t, undefined, () => true);
    const res = await app.request("/v1/plugins/openrouter/install", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await json(res), { error: "plugin_already_installed" });
  });

  test("unknown manifest id → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/ghost/install", {
      method: "POST",
      headers: superAuth,
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
      createPluginRoutes({
        registry,
        store,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        superuserKeys: [SUPERUSER_KEY],
      }),
    );

    const res = await app.request("/v1/plugins/evil/install", {
      method: "POST",
      headers: superAuth,
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
    await app.request("/v1/plugins/vikunja/install", { method: "POST", headers: superAuth });

    const uninstall = await app.request("/v1/plugins/vikunja/uninstall", {
      method: "POST",
      headers: superAuth,
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
      headers: superAuth,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await json(res), { error: "builtin_plugin" });
  });

  test("uninstall a known-but-not-installed manifest → 404 plugin_not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/mealie/uninstall", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await json(res), { error: "plugin_not_found" });
  });

  test("management mutations emit one request-scoped redacted audit record", async (t) => {
    const originalInfo = logger.info;
    const lines: string[] = [];
    logger.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      const { app } = await makeApp(t, undefined, () => true);
      const response = await app.request("/v1/plugins/vikunja/install", {
        method: "POST",
        headers: { ...superAuth, "x-request-id": "mgmt-request-1" },
      });
      assert.equal(response.status, 200);
      await flushAuditTelemetry();
      const records = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const management = records.filter((record) => record.event === "plugin.management");
      assert.equal(management.length, 1);
      assert.equal(management[0]?.operation, "install");
      assert.equal(management[0]?.pluginId, "vikunja");
      assert.equal(management[0]?.requestId, "mgmt-request-1");
      assert.equal(lines.some((line) => line.includes(SUPERUSER_KEY)), false);
    } finally {
      await flushAuditTelemetry();
      logger.info = originalInfo;
      resetAuditTelemetryConfig();
    }
  });

  test("a denied management request emits an ownerless redacted rejection record", async (t) => {
    const originalInfo = logger.info;
    const lines: string[] = [];
    logger.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      // Superuser gate disabled (empty key list): every management request 403s.
      const { app } = await makeApp(t, undefined, undefined, []);
      const response = await app.request("/v1/plugins/vikunja/install", {
        method: "POST",
        headers: { authorization: "Bearer test-key", "x-request-id": "mgmt-unauth" },
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await json(response), { error: "forbidden" });
      await flushAuditTelemetry();
      const management = lines.flatMap((line) => {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          return record.event === "plugin.management" ? [record] : [];
        } catch {
          return [];
        }
      });
      assert.equal(management.length, 1);
      assert.equal(management[0]?.operation, "install");
      assert.equal(management[0]?.pluginId, "vikunja");
      assert.equal(management[0]?.requestId, "mgmt-unauth");
      assert.equal(management[0]?.outcome, "error");
      assert.equal(management[0]?.errorCode, "FORBIDDEN");
      assert.equal("ownerHash" in management[0]!, false);
      assert.equal(lines.some((line) => line.includes("test-key")), false);
    } finally {
      await flushAuditTelemetry();
      logger.info = originalInfo;
      resetAuditTelemetryConfig();
    }
  });

  test("rate-limited management mutations emit one rejected audit record each", async (t) => {
    const originalInfo = logger.info;
    const lines: string[] = [];
    logger.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      const { app } = await makeApp(t, undefined, () => false);
      const requests = [
        ["/v1/plugins/vikunja/install", "install", "vikunja", "mgmt-install-denied"],
        ["/v1/plugins/reload", "reload", undefined, "mgmt-reload-denied"],
        ["/v1/plugins/vikunja/uninstall", "uninstall", "vikunja", "mgmt-uninstall-denied"],
      ] as const;
      for (const [path, , , requestId] of requests) {
        const response = await app.request(path, {
          method: "POST",
          headers: {
            ...superAuth,
            "x-request-id": requestId,
          },
        });
        assert.equal(response.status, 429);
      }
      await flushAuditTelemetry();
      const management = lines.flatMap((line) => {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          return record.event === "plugin.management" ? [record] : [];
        } catch {
          return [];
        }
      });
      assert.equal(management.length, 3);
      assert.deepEqual(
        management.map((record) => [
          record.operation,
          record.pluginId,
          record.requestId,
          record.outcome,
          record.status,
          record.errorCode,
        ]),
        [
          ["install", "vikunja", "mgmt-install-denied", "error", 429, "RATE_LIMITED"],
          ["reload", undefined, "mgmt-reload-denied", "error", 429, "RATE_LIMITED"],
          ["uninstall", "vikunja", "mgmt-uninstall-denied", "error", 429, "RATE_LIMITED"],
        ],
      );
    } finally {
      await flushAuditTelemetry();
      logger.info = originalInfo;
      resetAuditTelemetryConfig();
    }
  });
});

describe("plugin routes — reload", () => {
  test("POST /v1/plugins/reload → 200 status ok", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: superAuth,
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
      createPluginRoutes({
        registry,
        store,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        superuserKeys: [SUPERUSER_KEY],
      }),
    );

    const res = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await json(res), { error: "invalid_config" });
  });
});

describe("plugin routes — manifest pin mismatch", () => {
  test("reload exposes expected/actual in list and detail, then reinstall clears it", async (t) => {
    const { app, store, storePath } = await makeApp(t, undefined, () => true);
    const install = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(install.status, 200);

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as {
      approvedDigests: Record<string, string>;
      plugins: ToolPluginDefinition[];
    };
    const expected = persisted.approvedDigests.vikunja;
    const changed = structuredClone(persisted.plugins[0]!);
    changed.tools[0]!.inputSchema.required = ["changedId"];
    const actual = computeManifestDigest(changed);
    await writeFile(
      storePath,
      JSON.stringify({ ...persisted, plugins: [changed] }),
      "utf8",
    );

    const reload = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(reload.status, 409);
    assert.deepEqual(await json(reload), { error: "pin_mismatch" });

    const list = (await (await app.request("/v1/plugins", { headers: auth })).json()) as {
      plugins: Array<Record<string, unknown>>;
    };
    const vikunja = list.plugins.find((plugin) => plugin.id === "vikunja")!;
    assert.equal(vikunja.installed, true);
    assert.equal(vikunja.hashMismatch, true);
    assert.equal(vikunja.expected, expected);
    assert.equal(vikunja.actual, actual);
    assert.equal("approvedDigests" in vikunja, false);
    assert.equal(JSON.stringify(list).includes("https://"), false);

    const detail = (await (
      await app.request("/v1/plugins/vikunja", { headers: superAuth })
    ).json()) as Record<string, unknown>;
    assert.equal(detail.hashMismatch, true);
    assert.equal(detail.expected, expected);
    assert.equal(detail.actual, actual);

    const reinstall = await app.request("/v1/plugins/vikunja/install", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(reinstall.status, 200);
    assert.equal(store.getManifestHashMismatch("vikunja"), undefined);

    const afterReinstall = JSON.parse(await readFile(storePath, "utf8")) as {
      approvedDigests: Record<string, string>;
    };
    assert.equal(afterReinstall.approvedDigests.vikunja, expected);

    const uninstall = await app.request("/v1/plugins/vikunja/uninstall", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(uninstall.status, 200);
    const afterUninstall = JSON.parse(await readFile(storePath, "utf8")) as {
      approvedDigests: Record<string, string>;
    };
    assert.equal(afterUninstall.approvedDigests.vikunja, undefined);
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
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        superuserKeys: [SUPERUSER_KEY],
        limiter,
      }),
    );
    return app;
  }

  test("POST /v1/plugins/reload → 429 rate_limited once the bucket is exhausted", async (t) => {
    let allowed = 1;
    const limiter = () => allowed-- > 0;
    const app = await makeLimitedApp(t, limiter);

    const first = await app.request("/v1/plugins/reload", { method: "POST", headers: superAuth });
    assert.equal(first.status, 200);
    assert.deepEqual(await json(first), { status: "ok" });

    const second = await app.request("/v1/plugins/reload", { method: "POST", headers: superAuth });
    assert.equal(second.status, 429);
    assert.deepEqual(await json(second), { error: "rate_limited" });
  });

  test("install and uninstall are rate-limited with the same 429 shape", async (t) => {
    const limiter = () => false;
    const app = await makeLimitedApp(t, limiter);

    for (const path of ["/v1/plugins/vikunja/install", "/v1/plugins/vikunja/uninstall"]) {
      const res = await app.request(path, { method: "POST", headers: superAuth });
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
      createPluginRoutes({ registry, store, verifyKey: async () => ({ ok: true as const, owner: "test-user" }) }),
    );
    for (let i = 0; i < 25; i++) {
      const list = await app.request("/v1/plugins", { headers: auth });
      assert.equal(list.status, 200, `iteration ${i}`);
    }
  });
});

describe("plugin routes — auth", () => {
  test("GET /v1/plugins stays owner-gated → 401 when the owner verifier rejects", async (t) => {
    const { app } = await makeApp(t, async () => ({ ok: false as const, reason: "bad_key" as const }));
    const res = await app.request("/v1/plugins", { headers: auth });
    assert.equal(res.status, 401);
    assert.deepEqual(await json(res), { error: "unauthorized" });
  });

  test("GET /v1/plugins stays owner-gated → 403 email_not_verified for an unverified owner", async (t) => {
    const { app } = await makeApp(t, async () => ({
      ok: false as const,
      reason: "email_not_verified" as const,
    }));
    const res = await app.request("/v1/plugins", { headers: auth });
    assert.equal(res.status, 403);
    assert.deepEqual(await json(res), { error: "email_not_verified" });
  });

  test("an ordinary owner key is denied on every superuser-gated endpoint → 403", async (t) => {
    const { app } = await makeApp(t);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/plugins/openrouter"],
      ["POST", "/v1/plugins/vikunja/install"],
      ["POST", "/v1/plugins/vikunja/uninstall"],
      ["POST", "/v1/plugins/reload"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: auth });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await json(res), { error: "forbidden" }, `${method} ${path}`);
    }
  });

  test("with no superuser key configured every gated endpoint is disabled → 403", async (t) => {
    const { app } = await makeApp(t, undefined, undefined, []);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/plugins/openrouter"],
      ["POST", "/v1/plugins/vikunja/install"],
      ["POST", "/v1/plugins/vikunja/uninstall"],
      ["POST", "/v1/plugins/reload"],
    ];
    for (const [method, path] of cases) {
      // Even the value that WOULD be the secret is refused when the list is empty.
      const res = await app.request(path, { method, headers: superAuth });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await json(res), { error: "forbidden" }, `${method} ${path}`);
    }
  });

  test("the owner list is retained when the superuser gate is disabled", async (t) => {
    const { app } = await makeApp(t, undefined, undefined, []);
    const res = await app.request("/v1/plugins", { headers: auth });
    assert.equal(res.status, 200);
  });

  test("any entry of a rotated superuser secret list authorizes gated endpoints", async (t) => {
    const { app } = await makeApp(t, undefined, () => true, ["old-secret", SUPERUSER_KEY]);
    const viaOld = await app.request("/v1/plugins/openrouter", {
      headers: { authorization: "Bearer old-secret" },
    });
    assert.equal(viaOld.status, 200);
    const viaNew = await app.request("/v1/plugins/reload", {
      method: "POST",
      headers: superAuth,
    });
    assert.equal(viaNew.status, 200);
  });
});

describe("plugin routes — superuser gate mechanics", () => {
  test("requireSuperuser stamps the synthetic owner and superuser flag", async () => {
    const app = new Hono<OwnerVariables>();
    app.get("/probe", requireSuperuser([SUPERUSER_KEY]), (c) =>
      c.json({ owner: c.get("owner"), superuser: c.get("superuser") ?? false }),
    );

    const ok = await app.request("/probe", { headers: superAuth });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { owner: SUPERUSER_OWNER, superuser: true });

    const denied = await app.request("/probe", {
      headers: { authorization: "Bearer not-the-secret" },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forbidden" });
  });

  test("isSuperuserToken: empty list never matches (gate disabled)", () => {
    assert.equal(isSuperuserToken(`Bearer ${SUPERUSER_KEY}`, []), false);
    assert.equal(isSuperuserToken(undefined, []), false);
  });

  test("isSuperuserToken: matches only a configured secret", () => {
    assert.equal(isSuperuserToken(`Bearer ${SUPERUSER_KEY}`, [SUPERUSER_KEY]), true);
    assert.equal(isSuperuserToken("Bearer wrong", [SUPERUSER_KEY]), false);
    assert.equal(isSuperuserToken(undefined, [SUPERUSER_KEY]), false);
    assert.equal(isSuperuserToken("Basic abc", [SUPERUSER_KEY]), false);
  });

  test("isSuperuserToken: accepts any rotation entry", () => {
    const keys = ["old-secret", "new-secret"];
    assert.equal(isSuperuserToken("Bearer old-secret", keys), true);
    assert.equal(isSuperuserToken("Bearer new-secret", keys), true);
    assert.equal(isSuperuserToken("Bearer other", keys), false);
  });

  test("isSuperuserToken: differing-length tokens do not throw", () => {
    assert.equal(isSuperuserToken("Bearer x", ["a-much-longer-configured-secret"]), false);
    assert.equal(isSuperuserToken("Bearer a-much-longer-configured-secret", ["x"]), false);
  });
});