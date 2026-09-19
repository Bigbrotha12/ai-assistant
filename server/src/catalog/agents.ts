import { readFile, stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { templateAgentDefinitionSchema } from "../plugins/types.ts";
import type { AgentPluginDefinition, PluginDefinition, ResolvedAgentDef } from "../plugins/types.ts";
import type { SkillEntry } from "./skills.ts";
import type { McpEntry } from "./mcp.ts";

export type { ResolvedAgentDef };

export async function loadAgentsCatalog(
  agentsDir: string,
  skillsCatalog: SkillEntry[],
  mcpCatalog: McpEntry[],
): Promise<ResolvedAgentDef[]> {
  const skillsById = new Map(skillsCatalog.map(s => [s.id, s]));
  const mcpByName = new Map(mcpCatalog.map(m => [m.name, m]));

  const seenIds = new Map<string, string>();
  const entries: ResolvedAgentDef[] = [];

  try {
    await stat(agentsDir);
  } catch {
    return [];
  }

  const gen = glob("**/*.json", { cwd: agentsDir });

  for await (const file of gen) {
    const fullPath = join(agentsDir, file);
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Agent template ${fullPath} is not valid JSON`);
    }

    const result = templateAgentDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid agent template at ${fullPath}:\n${details}`);
    }

    const template = result.data;

    const existing = seenIds.get(template.id);
    if (existing) {
      throw new Error(
        `Duplicate agent template id '${template.id}' in ${existing} and ${fullPath}`,
      );
    }
    seenIds.set(template.id, fullPath);

    const resolvedSkills: ResolvedAgentDef["skills"] = [];
    for (const ref of template.skills ?? []) {
      const skill = skillsById.get(ref.id);
      if (!skill) {
        throw new Error(
          `Agent template '${template.id}' (${fullPath}) references unknown skill id '${ref.id}'`,
        );
      }
      resolvedSkills.push({ id: skill.id, title: skill.title, content: skill.content });
    }

    const resolvedMcp: ResolvedAgentDef["mcpServers"] = [];
    for (const ref of template.mcpServers ?? []) {
      const mcp = mcpByName.get(ref.name);
      if (!mcp) {
        throw new Error(
          `Agent template '${template.id}' (${fullPath}) references unknown MCP server name '${ref.name}'`,
        );
      }
      resolvedMcp.push({ name: mcp.name, url: mcp.url, headers: mcp.headers });
    }

    entries.push({
      id: template.id,
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      skills: resolvedSkills,
      mcpServers: resolvedMcp,
      tools: template.tools?.map(t => ({ pluginId: t.pluginId, required: t.required })),
      modelRef: template.modelRef,
      inference: template.inference,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

export function migrateInstalledAgents(
  catalog: ResolvedAgentDef[],
  store: { getInstalled?(): unknown[] },
): ResolvedAgentDef[] {
  const existingIds = new Set(catalog.map(a => a.id));
  const installed = (store.getInstalled?.() ?? []).filter(
    (p): p is AgentPluginDefinition =>
      typeof p === "object" && p !== null && (p as PluginDefinition).type === "agent",
  );
  const migrated: ResolvedAgentDef[] = [];
  for (const agent of installed) {
    if (existingIds.has(agent.id)) continue;
    migrated.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      skills: (agent.skills ?? []).map(s => ({ id: s.id, title: s.title, content: s.content })),
      mcpServers: (agent.mcpServers ?? []).map(s => ({ name: s.name, url: s.url, headers: s.headers })),
      tools: agent.tools?.map(t => ({ pluginId: t.pluginId, required: t.required })),
      modelRef: agent.modelRef,
      inference: agent.inference,
    });
  }
  return [...catalog, ...migrated];
}