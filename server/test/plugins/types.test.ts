import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
  jsonSchemaSchema,
  pluginDefinitionSchema,
  pluginStoreConfigSchema,
  parsePluginStoreConfig,
  PluginSchemaError,
  isToolPlugin,
  isModelPlugin,
  pluginIdSchema,
} from "../../src/plugins/types.ts";
import type {
  ToolPluginDefinition,
  ModelPluginDefinition,
  PluginDefinition,
} from "../../src/plugins/types.ts";

function toolPlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function modelPlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      parameters: { temperature: 0.7, maxTokens: { max: 8192 } },
    },
    baseUrls: [{ id: "openrouter-api", url: "https://openrouter.ai" }],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
    ...overrides,
  };
}

describe("plugin definition schemas", () => {
  test("valid tool plugin parses", () => {
    const parsed = pluginDefinitionSchema.safeParse(toolPlugin());
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.type, "tool");
      assert.equal(parsed.data.tools.length, 1);
      assert.equal(parsed.data.baseUrls[0]!.id, "vikunja-api");
    }
  });

  test("valid model plugin parses", () => {
    const parsed = pluginDefinitionSchema.safeParse(modelPlugin());
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.type, "model");
      assert.equal(parsed.data.inference.tokenLimit, 200_000);
      assert.equal(parsed.data.credentials?.apiKey.required, true);
    }
  });

  test("missing tools on a tool plugin fails", () => {
    const bad = toolPlugin({ tools: undefined });
    delete bad.tools;
    const parsed = pluginDefinitionSchema.safeParse(bad);
    assert.equal(parsed.success, false);
  });

  test("empty tools array on a tool plugin fails", () => {
    const parsed = pluginDefinitionSchema.safeParse(toolPlugin({ tools: [] }));
    assert.equal(parsed.success, false);
  });

  test("missing inference on a model plugin fails", () => {
    const bad = modelPlugin({ inference: undefined });
    delete bad.inference;
    const parsed = pluginDefinitionSchema.safeParse(bad);
    assert.equal(parsed.success, false);
  });

  test("type: 'weird' fails", () => {
    const parsed = pluginDefinitionSchema.safeParse(
      toolPlugin({ type: "weird" }),
    );
    assert.equal(parsed.success, false);
  });

  test("bad ids fail (uppercase, space, empty)", () => {
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ id: "Vikunja" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ id: "vik unja" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ id: "" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ id: "trailing-" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ id: "ok" })).success, true);
  });

  test("bad version fails", () => {
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ version: "1.4" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ version: "v1.4.0" })).success, false);
    assert.equal(pluginDefinitionSchema.safeParse(toolPlugin({ version: "1.4.0" })).success, true);
  });

  test("readOnly must be boolean", () => {
    const bad = toolPlugin();
    (bad.tools as Array<Record<string, unknown>>)![0]!.readOnly = "yes";
    assert.equal(pluginDefinitionSchema.safeParse(bad).success, false);
  });

  test("tokenLimit must be a positive int", () => {
    const bad = modelPlugin();
    (bad.inference as Record<string, unknown>).tokenLimit = -1;
    assert.equal(pluginDefinitionSchema.safeParse(bad).success, false);
  });

  test("url/endpoint must parse as a URL", () => {
    const badUrl = toolPlugin();
    (badUrl.baseUrls as Array<Record<string, unknown>>)![0]!.url = "not-a-url";
    assert.equal(pluginDefinitionSchema.safeParse(badUrl).success, false);

    const badEndpoint = modelPlugin();
    (badEndpoint.inference as Record<string, unknown>).endpoint = "openrouter.ai";
    assert.equal(pluginDefinitionSchema.safeParse(badEndpoint).success, false);
  });

  test("display fields are trimmed and non-empty", () => {
    const parsed = pluginDefinitionSchema.safeParse(
      toolPlugin({ name: "  Vikunja  ", description: "   " }),
    );
    assert.equal(parsed.success, false);

    const ok = pluginDefinitionSchema.safeParse(
      toolPlugin({ name: "  Vikunja  ", description: " tasks " }),
    );
    assert.equal(ok.success, true);
    if (ok.success) {
      assert.equal(ok.data.name, "Vikunja");
      assert.equal(ok.data.description, "tasks");
    }
  });

  test("tool plugin does not look like a model plugin and vice versa", () => {
    const tp = pluginDefinitionSchema.parse(toolPlugin());
    assert.equal(tp.type, "tool");
    assert.ok(Array.isArray(tp.tools));
    assert.equal((tp as ToolPluginDefinition).inference, undefined);

    const mp = pluginDefinitionSchema.parse(modelPlugin());
    assert.equal(mp.type, "model");
    assert.ok(mp.inference);
    assert.equal((mp as ModelPluginDefinition).tools, undefined);
  });
});

describe("jsonSchemaSchema", () => {
  test("accepts nested objects and arrays", () => {
    const schema = {
      type: "object",
      description: "booking payload",
      properties: {
        outbound: {
          type: "object",
          properties: { date: { type: "string" }, time: { type: "string" } },
          required: ["date"],
        },
        passengers: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, priority: { type: "string" } },
          },
        },
      },
      required: ["outbound", "passengers"],
    };
    const parsed = jsonSchemaSchema.safeParse(schema);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.properties?.outbound!.type, "object");
      assert.equal(
        parsed.data.properties?.passengers!.items?.properties?.name!.type,
        "string",
      );
    }
  });

  test("rejects a non-object", () => {
    assert.equal(jsonSchemaSchema.safeParse("object").success, false);
  });
});

describe("plugin store config", () => {
  test("parses a valid store with mixed plugins", () => {
    const store = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
      plugins: [toolPlugin(), modelPlugin()],
    };
    const parsed = pluginStoreConfigSchema.safeParse(store);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.plugins.length, 2);
    }
  });

  test("schemaVersion mismatch fails the check", () => {
    const future = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION + 1,
      plugins: [toolPlugin()],
    };
    // Raw schema accepts any positive int; the top-level check rejects it.
    assert.equal(pluginStoreConfigSchema.safeParse(future).success, true);
    assert.throws(
      () => parsePluginStoreConfig(future),
      (e: unknown) => e instanceof PluginSchemaError,
    );
  });

  test("malformed store throws PluginSchemaError with details", () => {
    assert.throws(
      () => parsePluginStoreConfig({}),
      (e: unknown) => e instanceof PluginSchemaError,
    );
  });

  test("valid store passes the check", () => {
    const store = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
      plugins: [toolPlugin()],
    };
    const parsed = parsePluginStoreConfig(store);
    assert.equal(parsed.plugins.length, 1);
  });

  test("Fix 10: duplicate plugin ids in the store fail the check", () => {
    const dup = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
      plugins: [toolPlugin(), toolPlugin({ version: "9.9.9" })],
    };
    // Raw schema is shape-lenient; the parse entry point enforces uniqueness.
    assert.equal(pluginStoreConfigSchema.safeParse(dup).success, true);
    assert.throws(
      () => parsePluginStoreConfig(dup),
      (e: unknown) =>
        e instanceof PluginSchemaError && e.message.includes("Duplicate plugin id"),
    );
  });
});

describe("type narrowing helpers", () => {
  test("isToolPlugin / isModelPlugin narrow correctly", () => {
    const tool: PluginDefinition = pluginDefinitionSchema.parse(toolPlugin());
    const model: PluginDefinition = pluginDefinitionSchema.parse(modelPlugin());

    assert.equal(isToolPlugin(tool), true);
    assert.equal(isModelPlugin(tool), false);
    assert.equal(isToolPlugin(model), false);
    assert.equal(isModelPlugin(model), true);

    if (isToolPlugin(tool)) {
      assert.equal(tool.tools.length, 1);
    }
    if (isModelPlugin(model)) {
      assert.equal(model.inference.defaultModel, "anthropic/claude-3.5-sonnet");
    }
  });

  test("pluginIdSchema is exported and reusable", () => {
    assert.equal(pluginIdSchema.safeParse("open-router").success, true);
    assert.equal(pluginIdSchema.safeParse("Open Router").success, false);
    assert.equal(pluginIdSchema.safeParse("open_router").success, false);
  });
});