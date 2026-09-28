import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoUrlLeak, walkJson } from "../helpers/leak.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { modelListFromPlugins } from "../../src/transport/models.ts";
import { agentListFromCatalogs } from "../../src/transport/agents.ts";
import type { PluginSummary } from "../../src/plugins/registry.ts";
import type { Catalogs } from "../../src/catalog/index.ts";
import type {
  AgentPluginDefinition,
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

/**
 * Wire-shape contract check (plan §5, task 0.4a).
 *
 * The plugin/model/agent JSON shapes are hand-mirrored between TypeScript
 * producers and Dart consumers. This test serializes one instance of each
 * shape from the REAL producers — `PluginRegistry.listAvailablePlugins`
 * (`plugins/registry.ts`), `modelListFromPlugins` (`transport/models.ts`) and
 * `agentListFromCatalogs` (`transport/agents.ts`) — into a single canonical
 * golden, and deep-compares it against `test/fixtures/plugin_contract.json`.
 *
 * The Dart side (`test/features/plugins/data/plugin_contract_test.dart`) parses
 * that same file with `PluginDto`/`PluginModelDto`/`AgentDto`. Drift on either
 * side of the wire fails a test. A `created` clock is injected so the golden is
 * deterministic.
 *
 * Intentional shape changes: `UPDATE_GOLDEN=1` rewrites the fixture and then
 * FAILS the test, because that run compared the producer against its own write
 * and so verified nothing. Re-run WITHOUT the flag to verify the committed
 * golden. The flag is refused outright under CI.
 */

/** Pinned epoch seconds; feeds the two `Date.now()` call sites. */
const NOW = 1_700_000_000;

/** Repo-rooted golden. `docs/` is gitignored; `test/` is tracked. */
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../test/fixtures/plugin_contract.json", import.meta.url),
);

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
        description: "List tasks from a project",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Project identifier" },
          },
          required: ["projectId"],
        },
      },
    ],
    baseUrls: [
      { id: "vikunja-api", url: "https://vikunja.example.com", label: "Vikunja API" },
    ],
    credentials: { apiKey: { label: "Vikunja token", required: true } },
  };
}

function modelPlugin(): ModelPluginDefinition {
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
      // URL-shaped values / url+endpoint+host keys below must be stripped by
      // `sanitizeParameters` before they reach the golden.
      parameters: {
        temperature: 0.2,
        maxTokens: 512,
        endpoint: "https://openrouter.ai/api/v1",
        url: "https://internal.vikunja.local",
        host: "10.0.0.5",
        baseUrlValue: "https://example.com",
        nested: { apiUrl: "https://admin.internal.example", keep: true },
      },
    },
    baseUrls: [
      { id: "openrouter-api", url: "https://openrouter.ai/api/v1", label: "OpenRouter API" },
    ],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
  };
}

function agentPlugin(): AgentPluginDefinition {
  return {
    id: "kitchen-copilot",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Kitchen Copilot",
    description: "Mealie recipe assistant",
    systemPrompt: "You are a kitchen assistant.",
    skills: [{ id: "recipes", title: "Recipes", content: "## Recipe tips\n..." }],
    tools: [{ pluginId: "mealie", required: true }],
    modelRef: "openrouter",
    inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
    baseUrls: [
      { id: "mealie-api", url: "https://mealie.example.com", label: "Mealie API" },
    ],
    credentials: { apiKey: { label: "Mealie token", required: false } },
    mcpServers: [
      {
        name: "recipes-mcp",
        url: "https://mcp.example.com",
        headers: { Authorization: "${MCP_TOKEN}" },
      },
    ],
  };
}

/** The agent-list producer reads from `Catalogs`, not the plugin registry. */
function catalogs(): Catalogs {
  return {
    skills: [],
    mcps: [],
    agents: [
      {
        id: "kitchen-copilot",
        name: "Kitchen Copilot",
        description: "Mealie recipe assistant",
        systemPrompt: "You are a kitchen assistant.",
        skills: [{ id: "recipes", title: "Recipes", content: "## Recipe tips\n..." }],
        mcpServers: [
          {
            name: "recipes-mcp",
            url: "https://mcp.example.com",
            headers: { Authorization: "${MCP_TOKEN}" },
          },
        ],
        tools: [{ pluginId: "mealie", required: true }],
        modelRef: "openrouter",
        inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
      },
    ],
  };
}

function fakeLookup(): LookupFn {
  return async () => [];
}

async function makeRegistry(t: TestContext): Promise<PluginRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "plugin-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: [toolPlugin(), modelPlugin(), agentPlugin()],
    manifests: [],
    lookup: fakeLookup(),
  });
  await store.load();
  return new PluginRegistry(store);
}

/**
 * The canonical golden shape. Top-level keys line up with the Dart parsers:
 *   - `plugins` → `PluginDto.parseList` (reads `json['plugins']`)
 *   - `models`  → `PluginModelDto.parseList` (`{object:'list', data:[...]}`)
 *   - `agents`  → `AgentDto.parseList`      (`{object:'list', data:[...]}`)
 */
function serializePluginContract(registry: PluginRegistry): unknown {
  const summary = (id: string): PluginSummary => {
    const found = registry.listAvailablePlugins().find((plugin) => plugin.id === id);
    assert.ok(found, `fixture plugin '${id}' must be available`);
    return found;
  };
  return {
    plugins: [summary("vikunja"), summary("openrouter"), summary("kitchen-copilot")],
    models: modelListFromPlugins([modelPlugin()], NOW),
    agents: agentListFromCatalogs(catalogs(), NOW),
  };
}

/**
 * Credentials may appear only as the spec (`{apiKey:{label,required}}`). Uses
 * the shared `walkJson` traversal rather than a second copy of the recursion.
 */
function assertCredentialSpecOnly(node: unknown, path: string): void {
  walkJson(node, path, (current, currentPath) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(current, "credentials")) return;
    const spec = (current as Record<string, unknown>).credentials as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(spec),
      ["apiKey"],
      `credentials at ${currentPath} must be spec-only (apiKey)`,
    );
    assert.deepEqual(
      Object.keys(spec.apiKey as object).sort(),
      ["label", "required"],
      `credentials.apiKey at ${currentPath} must carry only label/required`,
    );
  });
}

describe("wire-shape contract — canonical golden", () => {
  test("fixture plugins are available from the registry", async (t) => {
    const registry = await makeRegistry(t);
    assert.deepEqual(
      registry.listAvailablePlugins().map((plugin) => plugin.id),
      ["vikunja", "openrouter", "kitchen-copilot"],
    );
  });

  test("server producers match test/fixtures/plugin_contract.json", async (t) => {
    const registry = await makeRegistry(t);
    const contract = serializePluginContract(registry);

    // Security invariants are checked BEFORE any rewrite, so UPDATE_GOLDEN can
    // never bless a fixture that leaks a URL or a credential value.
    assertNoUrlLeak(contract, "contract", { allowBaseUrlsContainer: true });
    assertCredentialSpecOnly(contract, "contract");

    if (process.env.UPDATE_GOLDEN === "1") {
      // CI must never auto-accept drift: the regenerated file would be
      // committed without a deliberate review. Regeneration is a local act.
      assert.ok(
        !process.env.CI,
        "refusing to rewrite test/fixtures/plugin_contract.json under CI; " +
          "run UPDATE_GOLDEN=1 locally and commit the regenerated golden deliberately",
      );
      await mkdir(dirname(FIXTURE_PATH), { recursive: true });
      await writeFile(FIXTURE_PATH, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
      t.diagnostic(`UPDATE_GOLDEN rewrote ${FIXTURE_PATH}`);
      // Fail rather than pass: this run had no golden to compare against, so a
      // green result here would be unearned. Re-run without the flag to verify.
      assert.fail(
        `regenerated ${FIXTURE_PATH}; re-run without UPDATE_GOLDEN=1 to verify the golden`,
      );
    }

    const golden = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as unknown;
    assert.deepEqual(contract, golden);
  });
});
