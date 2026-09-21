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
  createAgentsRoutes,
} from "../../src/transport/agents.ts";
import type { AgentsListResponse } from "../../src/transport/agents.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import type {
  AgentPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { Catalogs } from "../../src/catalog/index.ts";

function defaultAgentPlugin(): AgentPluginDefinition {
  return {
    id: "default",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Default",
    description: "General-purpose assistant",
    systemPrompt: "You are a helpful assistant.",
    skills: [],
    tools: [],
  };
}

function kitchenCopilotAgent(): AgentPluginDefinition {
  return {
    id: "kitchen-copilot",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Kitchen Copilot",
    description: "Mealie recipe assistant",
    systemPrompt: "You are a kitchen assistant.",
    skills: [
      { id: "recipes", title: "Recipes", content: "## Recipe tips\n..." },
    ],
    tools: [{ pluginId: "mealie", required: true }],
    modelRef: "open-router",
    inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
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
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
};

function fakeLookup(records: Record<string, readonly LookupAddress[]> = DNS): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agents-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeEnv(
  dir: string,
): Promise<{ store: PluginStore; registry: PluginRegistry }> {
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [defaultAgentPlugin(), kitchenCopilotAgent(), toolPlugin()],
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

  const catalogs: Catalogs = {
    skills: [],
    mcps: [],
    agents: [
      {
        id: "default",
        name: "Default",
        description: "General-purpose assistant",
        systemPrompt: "You are a helpful assistant.",
        skills: [],
        mcpServers: [],
        tools: [],
      },
      {
        id: "kitchen-copilot",
        name: "Kitchen Copilot",
        description: "Mealie recipe assistant",
        systemPrompt: "You are a kitchen assistant.",
        skills: [
          { id: "recipes", title: "Recipes", content: "## Recipe tips\n..." },
        ],
        mcpServers: [],
        tools: [{ pluginId: "mealie", required: true }],
        modelRef: "open-router",
        inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
      },
    ],
  };

  const app = new Hono();
  app.route(
    "/v1",
    createAgentsRoutes({
      registry,
      catalogs,
      verifyKey: verifyKey ?? (async () => "test-user"),
    }),
  );
  return { app, registry };
}

const auth = { authorization: "Bearer test-key" };

/**
 * Recursively assert a serialized agents payload never carries a provider URL
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
      assertNoUrlLeak(value, `${path}.${key}`);
    }
  }
}

describe("GET /v1/agents (HTTP)", () => {
  test("200 with installed agent plugins — no URL leak", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/agents", { headers: auth });
    assert.equal(res.status, 200);

    const body = (await res.json()) as AgentsListResponse;
    assert.deepEqual(
      body.data.map((a) => a.id),
      ["default", "kitchen-copilot"],
      "tool plugins are excluded and entries are id-sorted",
    );
    assert.ok(body.data.every((a) => a.object === "agent" && a.owned_by === "plugin"));

    const defaultAgent = body.data.find((a) => a.id === "default")!;
    assert.equal(defaultAgent.visionCapable, false);
    assert.equal(defaultAgent.skillCount, 0);
    assert.deepEqual(defaultAgent.skillIds, []);
    assert.deepEqual(defaultAgent.mcpNames, []);
    assert.equal(defaultAgent.source, "template");
    assert.deepEqual(defaultAgent.toolGrants, []);

    const copilot = body.data.find((a) => a.id === "kitchen-copilot")!;
    assert.equal(copilot.visionCapable, true);
    assert.equal(copilot.skillCount, 1);
    assert.deepEqual(copilot.skillIds, ["recipes"]);
    assert.deepEqual(copilot.mcpNames, []);
    assert.equal(copilot.source, "template");
    assert.deepEqual(copilot.toolGrants, [{ pluginId: "mealie", required: true }]);
    assert.equal(copilot.defaultModel, "open-router");
    assert.equal(copilot.temperature, 0.3);
    assert.equal(copilot.maxTokens, 2048);

    // Redaction invariants: systemPrompt and raw skill content must never leak
    assert.equal(JSON.stringify(body).includes("systemPrompt"), false, "systemPrompt must not appear in serialized response");
    assert.equal(JSON.stringify(body).includes("## Recipe tips"), false, "skill content must not appear in serialized response");
    assert.equal(JSON.stringify(body).includes("You are a helpful assistant"), false);
    assert.equal(JSON.stringify(body).includes("You are a kitchen assistant"), false);

    assert.equal(
      JSON.stringify(body).includes("https://"),
      false,
      "agents list must not leak systemPrompt/skills content",
    );
    assertNoUrlLeak(body, "body");
  });

  test("empty catalog -> 200 empty list (not an error)", async (t) => {
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
      createAgentsRoutes({
        registry,
        catalogs: { skills: [], mcps: [], agents: [] },
        verifyKey: async () => "test-user",
      }),
    );

    const res = await app.request("/v1/agents", { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { object: "list", data: [] });
  });

  test("serves from catalogs even with no registry plugins", async (t) => {
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
      createAgentsRoutes({
        registry,
        catalogs: {
          skills: [],
          mcps: [],
          agents: [
            {
              id: "standalone",
              name: "Standalone",
              description: "From catalog only",
              skills: [],
              mcpServers: [],
              tools: [],
            },
          ],
        },
        verifyKey: async () => "test-user",
      }),
    );

    const res = await app.request("/v1/agents", { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as AgentsListResponse;
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!.id, "standalone");
  });

  test("401 { error: unauthorized } when the verifier returns null", async (t) => {
    const { app } = await makeApp(t, async () => null);
    const res = await app.request("/v1/agents", { headers: auth });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

describe("GET /v1/agents — mount order", () => {
  test("inferenceRoutes does not register GET /agents", async () => {
    const res = await inferenceRoutes.request("/agents");
    assert.equal(res.status, 404);
  });

  test("mounted as index.ts does, the agent transport serves /v1/agents", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);
    const app = new Hono();
    app.route("/v1", inferenceRoutes);
    app.route(
      "/v1",
      createAgentsRoutes({
        registry,
        catalogs: {
          skills: [],
          mcps: [],
          agents: [
            {
              id: "default",
              name: "Default",
              description: "General-purpose assistant",
              systemPrompt: "You are a helpful assistant.",
              skills: [],
              mcpServers: [],
              tools: [],
            },
            {
              id: "kitchen-copilot",
              name: "Kitchen Copilot",
              description: "Mealie recipe assistant",
              systemPrompt: "You are a kitchen assistant.",
              skills: [
                { id: "recipes", title: "Recipes", content: "## Recipe tips\n..." },
              ],
              mcpServers: [],
              tools: [{ pluginId: "mealie", required: true }],
              modelRef: "open-router",
              inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
            },
          ],
        },
        verifyKey: async () => "test-user",
      }),
    );

    const res = await app.request("/v1/agents", { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as AgentsListResponse;
    assert.deepEqual(
      body.data.map((a) => a.id),
      ["default", "kitchen-copilot"],
    );
    assert.equal(JSON.stringify(body).includes("https://"), false);
  });
});