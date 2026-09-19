import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../../src/plugins/types.ts";
import {
  builtinPlugins,
  builtinPluginIds,
  openRouterPlugin,
} from "../../src/plugins/builtin/openrouter.ts";
import {
  availableToolManifests,
  vikunjaManifest,
  mealieManifest,
  spielManifest,
} from "../../src/plugins/manifests/index.ts";

const toolManifests = [vikunjaManifest, mealieManifest, spielManifest];
const allPlugins = [openRouterPlugin, ...toolManifests];

describe("boot validation contract (pluginDefinitionSchema)", () => {
  for (const plugin of allPlugins) {
    test(`'${plugin.id}' parses against pluginDefinitionSchema`, () => {
      const parsed = pluginDefinitionSchema.safeParse(plugin);
      assert.equal(parsed.success, true);
    });
  }
});

describe("openrouter builtin model plugin", () => {
  test("definition fields are correct", () => {
    assert.equal(openRouterPlugin.id, "openrouter");
    assert.equal(openRouterPlugin.version, "1.0.0");
    assert.equal(openRouterPlugin.schemaVersion, CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION);
    assert.equal(openRouterPlugin.type, "model");
    assert.equal(openRouterPlugin.name, "OpenRouter");
    assert.ok(openRouterPlugin.description.length > 0);
  });

  test("inference targets OpenRouter with user-supplied key defaults", () => {
    assert.equal(
      openRouterPlugin.inference.endpoint,
      "https://openrouter.ai/api/v1",
    );
    assert.equal(openRouterPlugin.inference.defaultModel, "openrouter/auto");
    assert.equal(openRouterPlugin.inference.tokenLimit, 131072);
    assert.equal(openRouterPlugin.inference.supportsStreaming, true);
    assert.equal(openRouterPlugin.inference.visionCapable, true);
    assert.deepEqual(openRouterPlugin.inference.parameters, {});
  });

  test("baseUrls carries the default allowlist entry", () => {
    assert.ok(openRouterPlugin.baseUrls);
    assert.equal(openRouterPlugin.baseUrls.length, 1);
    const entry = openRouterPlugin.baseUrls[0]!;
    assert.equal(entry.id, "openrouter-default");
    assert.equal(entry.url, "https://openrouter.ai/api/v1");
    assert.equal(entry.label, "Default provider endpoint");
  });

  test("credentials require a user-owned api key", () => {
    assert.equal(openRouterPlugin.credentials?.apiKey.required, true);
    assert.equal(openRouterPlugin.credentials?.apiKey.label, "Default provider API key");
  });
});

describe("tool plugin manifests", () => {
  test("every manifest is a tool plugin with non-empty tools", () => {
    for (const manifest of toolManifests) {
      assert.equal(manifest.type, "tool");
      assert.equal(manifest.schemaVersion, CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION);
      assert.ok(manifest.tools.length > 0, `${manifest.id} must define tools`);
      assert.ok(manifest.version.length > 0);
    }
  });

  test("every tool has a readOnly boolean and an inputSchema object", () => {
    for (const manifest of toolManifests) {
      for (const tool of manifest.tools) {
        assert.equal(typeof tool.readOnly, "boolean", `${manifest.id}.${tool.name}`);
        assert.equal(typeof tool.inputSchema, "object", `${manifest.id}.${tool.name}`);
        assert.ok(tool.inputSchema, `${manifest.id}.${tool.name}`);
        assert.equal(
          typeof tool.inputSchema.type,
          "string",
          `${manifest.id}.${tool.name} must carry a json-schema 'type'`,
        );
      }
    }
  });

  test("every manifest declares allowlist entries with homelab labels", () => {
    const expected =
      new Map([
        ["vikunja", "Vikunja homelab"],
        ["mealie", "Mealie homelab"],
        ["spiel", "Spiel homelab"],
      ]);
    for (const manifest of toolManifests) {
      assert.ok(manifest.baseUrls.length > 0, `${manifest.id} needs baseUrls`);
      const entry = manifest.baseUrls[0]!;
      assert.ok(entry.url.startsWith("https://"), `${manifest.id} url scheme`);
      assert.equal(entry.label, expected.get(manifest.id));
    }
  });

  test("every manifest requires a personal access token", () => {
    for (const manifest of toolManifests) {
      assert.equal(manifest.credentials?.apiKey.required, true);
      assert.equal(manifest.credentials?.apiKey.label, "Personal access token");
    }
  });

  test("readOnly mix exercises both true and false", () => {
    for (const manifest of toolManifests) {
      assert.ok(
        manifest.tools.some((tool) => tool.readOnly === true),
        `${manifest.id} should have a read-only tool`,
      );
      assert.ok(
        manifest.tools.some((tool) => tool.readOnly === false),
        `${manifest.id} should have a mutating tool`,
      );
    }
  });
});

describe("catalog membership", () => {
  test("manifests are NOT in builtinPlugins, ARE in availableToolManifests", () => {
    for (const manifest of toolManifests) {
      assert.equal(
        builtinPluginIds.includes(manifest.id),
        false,
        `${manifest.id} must not be builtin`,
      );
      assert.equal(
        availableToolManifests.some((entry) => entry.id === manifest.id),
        true,
        `${manifest.id} must be in availableToolManifests`,
      );
    }
  });

  test("openrouter is builtin and NOT in the installable catalog", () => {
    assert.equal(builtinPluginIds.includes("openrouter"), true);
    assert.equal(
      availableToolManifests.some((entry) => entry.id === "openrouter"),
      false,
    );
  });

  test("builtinPlugins has exactly one entry, openrouter", () => {
    // Guards against accidentally adding OpenAI/Anthropic (or any third-party
    // provider) as builtins later.
    assert.equal(builtinPlugins.length, 1);
    assert.equal(builtinPlugins[0]!.id, "openrouter");
    assert.deepEqual(builtinPluginIds, ["openrouter"]);
  });
});