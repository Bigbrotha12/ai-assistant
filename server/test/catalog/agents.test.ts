import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadAgentsCatalog, migrateInstalledAgents } from "../../src/catalog/agents.ts";
import type { SkillEntry } from "../../src/catalog/skills.ts";
import type { McpEntry } from "../../src/catalog/mcp.ts";
import type { AgentPluginDefinition } from "../../src/plugins/types.ts";

const skillsCatalog: SkillEntry[] = [
  { id: "mealie", title: "Mealie Skills", content: "# Mealie\nRecipe management." },
  { id: "vikunja", title: "Vikunja Skills", content: "# Vikunja\nTask management." },
];

const mcpCatalog: McpEntry[] = [
  { name: "filesystem", url: "https://filesystem.example.com", headers: { Authorization: "${TOKEN}" } },
];

const VALID_TEMPLATE = {
  id: "kitchen-copilot",
  version: "1.0.0",
  schemaVersion: 1,
  type: "agent",
  name: "Kitchen Copilot",
  description: "Mealie recipe assistant",
  systemPrompt: "You are a kitchen assistant.",
  skills: [{ id: "mealie" }],
  mcpServers: [{ name: "filesystem" }],
  tools: [{ pluginId: "mealie", required: true }],
  modelRef: "open-router",
  inference: { temperature: 0.3, maxTokens: 2048, visionCapable: true },
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agents-catalog-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadAgentsCatalog", () => {
  test("happy path: valid template with skill refs and mcp refs", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "kitchen.json"), JSON.stringify(VALID_TEMPLATE));

      const result = await loadAgentsCatalog(dir, skillsCatalog, mcpCatalog);
      assert.equal(result.length, 1);
      const entry = result[0]!;
      assert.equal(entry.id, "kitchen-copilot");
      assert.equal(entry.name, "Kitchen Copilot");
      assert.equal(entry.systemPrompt, "You are a kitchen assistant.");
      assert.equal(entry.skills.length, 1);
      assert.equal(entry.skills[0]!.id, "mealie");
      assert.equal(entry.skills[0]!.title, "Mealie Skills");
      assert.equal(entry.skills[0]!.content, "# Mealie\nRecipe management.");
      assert.equal(entry.mcpServers.length, 1);
      assert.equal(entry.mcpServers[0]!.name, "filesystem");
      assert.equal(entry.mcpServers[0]!.url, "https://filesystem.example.com");
      assert.equal(entry.tools!.length, 1);
      assert.equal(entry.tools![0]!.pluginId, "mealie");
      assert.equal(entry.tools![0]!.required, true);
      assert.equal(entry.modelRef, "open-router");
      assert.equal(entry.inference?.temperature, 0.3);
    });
  });

  test("empty dir returns []", async () => {
    await withDir(async (dir) => {
      const result = await loadAgentsCatalog(dir, skillsCatalog, mcpCatalog);
      assert.deepEqual(result, []);
    });
  });

  test("missing dir returns []", async () => {
    const result = await loadAgentsCatalog(
      join(tmpdir(), "nonexistent-agents-" + Date.now()),
      skillsCatalog,
      mcpCatalog,
    );
    assert.deepEqual(result, []);
  });

  test("invalid template JSON throws", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "bad.json"), "not json");

      await assert.rejects(
        () => loadAgentsCatalog(dir, skillsCatalog, mcpCatalog),
        (err: unknown) =>
          err instanceof Error && err.message.includes("not valid JSON"),
      );
    });
  });

  test("missing skill ref throws", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "broken.json"),
        JSON.stringify({ ...VALID_TEMPLATE, skills: [{ id: "nonexistent-skill" }] }),
      );

      await assert.rejects(
        () => loadAgentsCatalog(dir, skillsCatalog, mcpCatalog),
        (err: unknown) =>
          err instanceof Error && err.message.includes("unknown skill id"),
      );
    });
  });

  test("missing mcp ref throws", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "broken.json"),
        JSON.stringify({ ...VALID_TEMPLATE, mcpServers: [{ name: "nonexistent-mcp" }] }),
      );

      await assert.rejects(
        () => loadAgentsCatalog(dir, skillsCatalog, mcpCatalog),
        (err: unknown) =>
          err instanceof Error && err.message.includes("unknown MCP server name"),
      );
    });
  });

  test("duplicate template id throws", async () => {
    await withDir(async (dir) => {
      const templateA = { ...VALID_TEMPLATE, id: "dup-id", name: "A" };
      const templateB = { ...VALID_TEMPLATE, id: "dup-id", name: "B" };
      await writeFile(join(dir, "a.json"), JSON.stringify(templateA));
      await writeFile(join(dir, "b.json"), JSON.stringify(templateB));

      await assert.rejects(
        () => loadAgentsCatalog(dir, skillsCatalog, mcpCatalog),
        (err: unknown) =>
          err instanceof Error && err.message.includes("Duplicate agent template id"),
      );
    });
  });

  test("template without skills/mcpServers resolves with empty arrays", async () => {
    await withDir(async (dir) => {
      const minimal = {
        id: "minimal",
        version: "1.0.0",
        schemaVersion: 1,
        type: "agent",
        name: "Minimal",
        description: "No skills or mcp",
      };
      await writeFile(join(dir, "minimal.json"), JSON.stringify(minimal));

      const result = await loadAgentsCatalog(dir, skillsCatalog, mcpCatalog);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0]!.skills, []);
      assert.deepEqual(result[0]!.mcpServers, []);
    });
  });

  test("sorts by id", async () => {
    await withDir(async (dir) => {
      const b = { ...VALID_TEMPLATE, id: "b-agent", name: "B" };
      const a = { ...VALID_TEMPLATE, id: "a-agent", name: "A" };
      const c = { ...VALID_TEMPLATE, id: "c-agent", name: "C" };
      await writeFile(join(dir, "b.json"), JSON.stringify(b));
      await writeFile(join(dir, "a.json"), JSON.stringify(a));
      await writeFile(join(dir, "c.json"), JSON.stringify(c));

      const result = await loadAgentsCatalog(dir, skillsCatalog, mcpCatalog);
      assert.deepEqual(
        result.map(r => r.id),
        ["a-agent", "b-agent", "c-agent"],
      );
    });
  });
});

describe("migrateInstalledAgents", () => {
  const builtinAgent: AgentPluginDefinition = {
    id: "builtin-agent",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Builtin Agent",
    description: "A builtin agent",
    systemPrompt: "You are a builtin.",
    skills: [{ id: "mealie", title: "Mealie", content: "Recipe help" }],
    tools: [{ pluginId: "mealie", required: false }],
    modelRef: "open-router",
    inference: { temperature: 0.5, maxTokens: 1024, visionCapable: false },
  };

  test("builtin agent gets migrated when not in catalog", async () => {
    const store = { getInstalled: () => [builtinAgent] };
    const result = migrateInstalledAgents([], store);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "builtin-agent");
    assert.equal(result[0]!.skills.length, 1);
    assert.equal(result[0]!.skills[0]!.id, "mealie");
    assert.equal(result[0]!.skills[0]!.title, "Mealie");
    assert.equal(result[0]!.skills[0]!.content, "Recipe help");
  });

  test("file template wins over installed agent with same id", async () => {
    const store = { getInstalled: () => [builtinAgent] };
    const catalogEntry = {
      id: "builtin-agent",
      name: "Template Agent",
      description: "From file",
      systemPrompt: "Template beats builtin.",
      skills: [] as { id: string; title: string; content: string }[],
      mcpServers: [] as { name: string; url: string; headers?: Record<string, string> }[],
      tools: [] as { pluginId: string; required: boolean }[],
    };
    const result = migrateInstalledAgents([catalogEntry], store);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Template Agent");
  });

  test("non-agent plugins are ignored", async () => {
    const toolPlugin = {
      id: "some-tool",
      version: "1.0.0",
      schemaVersion: 1,
      type: "tool" as const,
      name: "Tool",
      description: "A tool",
      tools: [],
      baseUrls: [],
    };
    const store = { getInstalled: () => [builtinAgent, toolPlugin] };
    const result = migrateInstalledAgents([], store);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "builtin-agent");
  });

  test("empty installed list returns catalog as-is", async () => {
    const store = { getInstalled: () => [] };
    const result = migrateInstalledAgents([], store);
    assert.deepEqual(result, []);
  });
});