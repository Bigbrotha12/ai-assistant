import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Context } from "hono";
import { createChatRoutes, resolveChatRequest } from "../../src/transport/chat.ts";
import type { Catalogs, ResolvedAgentDef } from "../../src/catalog/index.ts";
import type {
  PluginDefinition,
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import { PluginRegistryError } from "../../src/plugins/registry.ts";
import type { PluginRegistry } from "../../src/plugins/registry.ts";

/**
 * Tests for the build-on-the-fly agent request pipeline in the chat route.
 * 200-path tests use resolveChatRequest() directly (no network calls).
 * 400-path tests use HTTP (buildModel never reached for pre-stream errors).
 */

// ----- Fakes -----

function fakeModelPlugin(): ModelPluginDefinition {
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

function fakeToolPlugin(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.4.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "Task management tools",
    tools: [
      { name: "list_tasks", description: "List tasks", readOnly: true, inputSchema: { type: "object" } },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Token", required: true } },
  };
}

type FakePluginMap = Map<string, PluginDefinition>;

function makeFakeRegistry(plugins: FakePluginMap): PluginRegistry {
  const store: FakePluginMap = plugins;
  return {
    requirePlugin(id: string): PluginDefinition {
      const p = store.get(id);
      if (!p) {
        throw new PluginRegistryError("PLUGIN_NOT_FOUND", `plugin '${id}' not found`);
      }
      return p;
    },
    listAvailable() { return [...store.values()]; },
    listInstalledPlugins() { return [...store.values()]; },
    getPlugin(id: string) { return store.get(id); },
  } as unknown as PluginRegistry;
}

function makeCatalogs(agentTemplates: ResolvedAgentDef[] = []): Catalogs {
  return {
    skills: [
      { id: "svc-restart", title: "Service Restart", content: "## Restart a service\nUse systemctl." },
      { id: "db-query", title: "Database Query", content: "## Query the database\nUse SQL." },
    ],
    mcps: [
      { name: "github", url: "https://api.github.com/mcp", headers: { authorization: "${GITHUB_TOKEN}" } },
    ],
    agents: agentTemplates,
  };
}

const defaultTemplate: ResolvedAgentDef = {
  id: "default",
  name: "Default",
  description: "General-purpose assistant",
  systemPrompt: "You are a helpful assistant.",
  skills: [],
  mcpServers: [],
};

function makeRegistryWithModelAndTool(): FakePluginMap {
  return new Map<string, PluginDefinition>([
    ["openrouter", fakeModelPlugin()],
    ["vikunja", fakeToolPlugin()],
  ]);
}

function makeRegistryWithModelOnly(): FakePluginMap {
  return new Map<string, PluginDefinition>([
    ["openrouter", fakeModelPlugin()],
  ]);
}

function makeFakePluginStore(): unknown {
  return {
    path: "/tmp/fake-plugins.json",
    getPinnedIps: () => undefined,
    hasMcpPins: () => false,
  };
}

function makeApp(
  registry: FakePluginMap,
  catalogs: Catalogs,
  catalogsEmptyFallback: boolean = false,
): Hono {
  const app = new Hono();
  const chatCatalogs = catalogsEmptyFallback
    ? { skills: [], mcps: [], agents: [] }
    : catalogs;
  app.route(
    "/v1",
    createChatRoutes({
      registry: makeFakeRegistry(registry),
      pluginStore: makeFakePluginStore() as never,
      verifyKey: async () => "test-user",
      limiter: () => true,
      trustedHosts: [],
      catalogs: chatCatalogs,
    }),
  );
  return app;
}

function postChat(
  app: Hono,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "openrouter",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    credentials: { openrouter: { apiKey: "sk-test" } },
    ...overrides,
  };
}

// Minimal Hono Context mock that only supports c.json()
function mockContext(): Context {
  return {
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}

function resolveOk(
  body: Record<string, unknown>,
  registry: FakePluginMap,
  catalogs: Catalogs,
): ReturnType<typeof resolveChatRequest> {
  return resolveChatRequest(
    mockContext(),
    body,
    makeFakeRegistry(registry),
    catalogs,
  );
}

// ----- Tests -----

describe("POST /v1/chat/completions — build-on-the-fly agent resolution", () => {

  test("1. Template path: body { agent: 'default' } resolves template from catalogs → ok", async (_t) => {
    const result = resolveOk(
      chatBody({ agent: "default" }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.agentOverride?.systemPrompt, "You are a helpful assistant.");
  });

  test("2. Unknown template: body { agent: 'nonexistent' } → 400 template_not_found", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({ agent: "nonexistent" }));
    assert.equal(res.status, 400);
    const json = await res.json() as Record<string, unknown>;
    assert.equal(json.error, "invalid_request");
    assert.match(String(json.message ?? ""), /template_not_found/, "mentions template_not_found");
  });

  test("3. Custom agent valid: skills/mcp/modelRef resolved → ok", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          skills: ["svc-restart"],
          mcpServers: [{ name: "github" }],
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("4. Custom agent unknown skill → ok (skill skipped with warn)", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          skills: ["nonexistent-skill"],
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("5. Custom agent unknown MCP → ok (MCP skipped with warn)", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          mcpServers: [{ name: "nonexistent-mcp" }],
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("6. Strict schema rejects unknown keys (url in mcpServers)", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({
      agent: {
        mcpServers: [{ name: "github", url: "https://evil.com" }],
      },
    }));
    assert.equal(res.status, 400, "unknown key 'url' rejected by strict schema");
    const json = await res.json() as Record<string, unknown>;
    assert.equal(json.error, "invalid_request");
  });

  test("7. Custom agent required tool not installed → 400 invalid_credentials", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelOnly(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({
      agent: {
        tools: [{ pluginId: "nonexistent", required: true }],
        modelRef: "openrouter",
      },
    }));
    assert.equal(res.status, 400, "required but uninstalled tool → 400");
    const json = await res.json() as Record<string, unknown>;
    assert.equal(json.error, "invalid_credentials", "error is invalid_credentials");
  });

  test("8. Custom agent optional tool not installed → ok (skipped)", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          tools: [{ pluginId: "nonexistent", required: false }],
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelOnly(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("9. Custom agent modelRef not found → 400", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelOnly(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({
      agent: {
        modelRef: "nonexistent-model",
      },
    }));
    assert.equal(res.status, 400, "modelRef not found → 400");
  });

  test("10. Custom agent empty mcpServers → ok", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          mcpServers: [],
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("11. String back-compat: agent: 'default' → resolves template", async (_t) => {
    const result = resolveOk(
      chatBody({ agent: "default" }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("12. Invalid body agent type: agent: 42 → 400", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({ agent: 42 }));
    assert.equal(res.status, 400, "non-string non-object agent → 400");
    const json = await res.json() as Record<string, unknown>;
    assert.equal(json.error, "invalid_request", "error is invalid_request");
  });

  test("13. Custom agent with system prompt, name, description → ok", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          name: "Custom Helper",
          description: "A custom agent for testing",
          systemPrompt: "You are a test agent.",
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("14. Custom agent with inference overrides → ok", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          inference: { temperature: 0.5, maxTokens: 4096, visionCapable: true },
          modelRef: "openrouter",
        },
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
  });

  test("15. Empty agent string → 400", async (_t) => {
    const app = makeApp(
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    const res = await postChat(app, chatBody({ agent: "" }));
    assert.equal(res.status, 400, "empty string agent is rejected");
    const json = await res.json() as Record<string, unknown>;
    assert.equal(json.error, "invalid_request");
  });

  test("16. Template without tools preserves user enabled_plugins", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: "default",
        enabled_plugins: ["vikunja"],
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // tools is undefined on template → agentOverride does NOT wipe enabledPlugins
    assert.deepEqual(result.value.enabledPlugins, ["vikunja"]);
  });

  test("17. Custom spec without tools preserves user enabled_plugins", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          modelRef: "openrouter",
        },
        enabled_plugins: ["vikunja"],
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.enabledPlugins, ["vikunja"]);
  });

  test("18. Custom spec with empty tools sets enabledPlugins = []", async (_t) => {
    const result = resolveOk(
      chatBody({
        agent: {
          tools: [],
          modelRef: "openrouter",
        },
        enabled_plugins: ["vikunja"],
      }),
      makeRegistryWithModelAndTool(),
      makeCatalogs([defaultTemplate]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.enabledPlugins, []);
  });

});