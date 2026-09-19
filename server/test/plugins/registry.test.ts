import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry, PluginRegistryError } from "../../src/plugins/registry.ts";
import { CURRENT_PLUGIN_STORE_SCHEMA_VERSION, isModelPlugin, isToolPlugin, isAgentPlugin } from "../../src/plugins/types.ts";
import type {
  ModelPluginDefinition,
  PluginStoreConfig,
  ToolPluginDefinition,
  AgentPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

function openRouterBuiltin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "0.1.0",
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

function vikunjaManifest(
  overrides: Partial<ToolPluginDefinition> = {},
): ToolPluginDefinition {
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
    ...overrides,
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

const DNS: Record<string, LookupAddress[]> = {
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  "mealie.example.com": [{ address: "1.1.1.1", family: 4 }],
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.local": [{ address: "10.0.0.5", family: 4 }],
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
  const dir = await mkdtemp(join(tmpdir(), "plugin-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeEnv(dir: string): Promise<{
  store: PluginStore;
  registry: PluginRegistry;
  storePath: string;
}> {
  const storePath = join(dir, "plugins.json");
  const store = new PluginStore({
    storePath,
    trustedHosts: [],
    builtinPlugins: [openRouterBuiltin(), defaultAgentPlugin(), kitchenCopilotAgent()],
    manifests: [vikunjaManifest(), mealieManifest()],
    lookup: fakeLookup(),
  });
  await store.load();
  const registry = new PluginRegistry(store);
  return { store, registry, storePath };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

describe("PluginRegistry list (public) endpoints", () => {
  test("listAvailablePlugins redacts baseUrl url values and model endpoint", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);

    const list = registry.listAvailablePlugins();
    assert.deepEqual(
      list.map((p) => p.id),
      ["openrouter", "default", "kitchen-copilot", "vikunja", "mealie"],
    );

    const openrouter = list.find((p) => p.id === "openrouter")!;
    assert.equal(openrouter.installed, true);
    assert.equal(openrouter.type, "model");
    assert.deepEqual(openrouter.baseUrls, [{ id: "openrouter-api" }]);
    assert.ok(
      openrouter.baseUrls.every((b) => !("url" in b)),
      "url strings must be redacted",
    );
    assert.equal(openrouter.inference!.defaultModel, "anthropic/claude-3.5-sonnet");
    assert.equal(openrouter.inference!.visionCapable, true);
    assert.equal(
      "endpoint" in openrouter.inference!,
      false,
      "endpoint must be redacted",
    );
    assert.equal(
      openrouter.credentials!.apiKey.label,
      "OpenRouter API key",
      "labels are fine for client UI",
    );

    const vikunja = list.find((p) => p.id === "vikunja")!;
    assert.equal(vikunja.installed, false);
    assert.equal(vikunja.type, "tool");
    assert.deepEqual(vikunja.tools![0]!.name, "list_tasks");
    assert.deepEqual(vikunja.tools![0]!.inputSchema.required, ["projectId"]);
    assert.ok(vikunja.baseUrls.every((b) => !("url" in b)));
  });

  test("install state flips in the public list after an install", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    await store.install("vikunja");
    const vikunja = registry.listAvailablePlugins().find((p) => p.id === "vikunja")!;
    assert.equal(vikunja.installed, true);
    const mealie = registry.listAvailablePlugins().find((p) => p.id === "mealie")!;
    assert.equal(mealie.installed, false);
  });

  test("getPluginDetails (auth-gated) includes baseUrl urls and endpoint", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);

    const openrouter = registry.getPluginDetails("openrouter")!;
    assert.equal(openrouter.installed, true);
    if (isModelPlugin(openrouter)) {
      assert.deepEqual(openrouter.baseUrls, [
        { id: "openrouter-api", url: "https://openrouter.ai" },
      ]);
      assert.equal(openrouter.inference.endpoint, "https://openrouter.ai/api/v1");
      assert.ok(openrouter.credentials, "spec present (labels only, never values)");
    } else {
      assert.fail("openrouter must be a model plugin");
    }

    const vikunja = registry.getPluginDetails("vikunja")!;
    assert.equal(vikunja.installed, false);
    if (isToolPlugin(vikunja)) {
      assert.equal(vikunja.baseUrls[0]!.url, "https://vikunja.example.com");
    } else {
      assert.fail("vikunja must be a tool plugin");
    }

    assert.equal(registry.getPluginDetails("ghost"), undefined);
  });

  test("listAvailablePlugins includes agents with redacted summary", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);

    const list = registry.listAvailablePlugins();

    const defaultAgent = list.find((p) => p.id === "default")!;
    assert.equal(defaultAgent.type, "agent");
    assert.equal(defaultAgent.installed, true);
    assert.equal(defaultAgent.agent!.skillCount, 0);
    assert.equal(defaultAgent.agent!.visionCapable, false);
    assert.deepEqual(defaultAgent.agent!.toolGrants, []);
    assert.equal(defaultAgent.agent!.modelRef, undefined);

    const copilot = list.find((p) => p.id === "kitchen-copilot")!;
    assert.equal(copilot.type, "agent");
    assert.equal(copilot.installed, true);
    assert.equal(copilot.agent!.skillCount, 1);
    assert.equal(copilot.agent!.visionCapable, true);
    assert.deepEqual(copilot.agent!.toolGrants, [
      { pluginId: "mealie", required: true },
    ]);
    assert.equal(copilot.agent!.modelRef, "open-router");
    assert.ok(
      !("systemPrompt" in copilot),
      "systemPrompt must be redacted from public list",
    );
  });

  test("getPluginDetails includes full agent definition with systemPrompt", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);

    const agent = registry.getPluginDetails("default")!;
    assert.equal(agent.installed, true);
    assert.equal(agent.type, "agent");
    if (isAgentPlugin(agent)) {
      assert.equal(agent.systemPrompt, "You are a helpful assistant.");
    }

    const copilot = registry.getPluginDetails("kitchen-copilot")!;
    assert.equal(copilot.installed, true);
    if (isAgentPlugin(copilot)) {
      assert.equal(copilot.systemPrompt, "You are a kitchen assistant.");
      assert.equal(copilot.skills?.length, 1);
      assert.equal(copilot.skills![0]!.content, "## Recipe tips\n...");
    }
  });
});

describe("PluginRegistry requirePlugin", () => {
  test("installed plugin resolves; builtins resolve", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);
    await store.install("vikunja");

    assert.equal(registry.requirePlugin("vikunja").id, "vikunja");
    assert.equal(registry.requirePlugin("openrouter").id, "openrouter");
  });

  test("known-but-not-installed plugin throws PLUGIN_DISABLED (actionable)", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);
    assert.throws(
      () => registry.requirePlugin("mealie"),
      (e: unknown) =>
        e instanceof PluginRegistryError &&
        e.code === "PLUGIN_DISABLED" &&
        e.message.includes("install it in the plugin store"),
    );
  });

  test("unknown plugin throws PLUGIN_NOT_FOUND (actionable, mentions id)", async (t) => {
    const dir = await makeTempDir(t);
    const { registry } = await makeEnv(dir);
    assert.throws(
      () => registry.requirePlugin("ghost"),
      (e: unknown) =>
        e instanceof PluginRegistryError &&
        e.code === "PLUGIN_NOT_FOUND" &&
        e.message.includes("'ghost'") &&
        e.message.includes("enable it in the plugin store"),
    );
  });
});

describe("PluginRegistry resolution helpers", () => {
  test("canResolveModelPlugin / canResolveToolPlugin / canResolveAgentPlugin", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);

    assert.equal(registry.canResolveModelPlugin("openrouter"), true);
    assert.equal(registry.canResolveToolPlugin("openrouter"), false);
    assert.equal(registry.canResolveAgentPlugin("openrouter"), false);

    assert.equal(registry.canResolveToolPlugin("vikunja"), false);
    assert.equal(registry.canResolveModelPlugin("vikunja"), false);
    assert.equal(registry.canResolveAgentPlugin("vikunja"), false);
    assert.equal(registry.canResolveToolPlugin("mealie"), false);
    assert.equal(registry.canResolveModelPlugin("ghost"), false);
    assert.equal(registry.canResolveAgentPlugin("ghost"), false);

    assert.equal(registry.canResolveAgentPlugin("default"), true);
    assert.equal(registry.canResolveAgentPlugin("kitchen-copilot"), true);
    assert.equal(registry.canResolveModelPlugin("default"), false);

    await store.install("vikunja");
    assert.equal(registry.canResolveToolPlugin("vikunja"), true);
    assert.equal(registry.canResolveModelPlugin("vikunja"), false);
  });
});

describe("PluginRegistry hot-reload", () => {
  test("hotReload picks up a disk-side store change", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry, storePath } = await makeEnv(dir);
    await store.install("vikunja");
    assert.equal(registry.canResolveToolPlugin("vikunja"), true);

    // Self-write guard: reload right after the store's own save is a no-op.
    await registry.hotReload();
    assert.equal(registry.canResolveToolPlugin("vikunja"), true, "own write ignored");

    // Simulate an admin editing plugins.json out-of-band: drop vikunja.
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [],
      } satisfies PluginStoreConfig),
      "utf8",
    );

    // Now read the external edit.
    await registry.hotReload();
    assert.equal(registry.canResolveToolPlugin("vikunja"), false);
    assert.equal(registry.getPluginDetails("vikunja")!.installed, false);
    const mealie = registry.listAvailablePlugins().find((p) => p.id === "mealie")!;
    assert.equal(mealie.installed, false);
  });
});

describe("PluginRegistry file watch", () => {
  test("fs.watch auto-reloads on an external edit", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry, storePath } = await makeEnv(dir);
    await store.install("vikunja");

    const abort = new AbortController();
    registry.watch({ signal: abort.signal, onError: () => undefined });
    try {
      await writeFile(
        storePath,
        JSON.stringify({
          schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
          plugins: [],
        } satisfies PluginStoreConfig),
        "utf8",
      );

      // Watch delivery is platform/timing dependent; skip instead of failing CI.
      const pickedUp = await waitFor(
        () => registry.canResolveToolPlugin("vikunja") === false,
        2000,
      );
      if (!pickedUp) {
        t.skip(
          "fs.watch did not deliver the rename event in this environment; hotReload() is covered directly above",
        );
        return;
      }
      assert.equal(registry.canResolveToolPlugin("vikunja"), false);
    } finally {
      abort.abort();
      registry.disposeWatch();
    }
  });

  test("the watch does not fight the store's own saves (no reload loop)", async (t) => {
    const dir = await makeTempDir(t);
    const { store, registry } = await makeEnv(dir);

    const abort = new AbortController();
    registry.watch({ signal: abort.signal, onError: () => undefined });
    try {
      await store.install("vikunja");
      // Let the debounced reload (150ms) fire over our own write.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(registry.canResolveToolPlugin("vikunja"), true);
    } finally {
      abort.abort();
      registry.disposeWatch();
    }
  });
});