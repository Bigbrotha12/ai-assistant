import { loadSkillsCatalog } from "./skills.ts";
import { loadMcpCatalog } from "./mcp.ts";
import { loadAgentsCatalog, migrateInstalledAgents } from "./agents.ts";
import type { ResolvedAgentDef } from "./agents.ts";

export type { ResolvedAgentDef };

export type Catalogs = {
  skills: Array<{ id: string; title: string; content: string }>;
  mcps: Array<{ name: string; url: string; headers?: Record<string, string> }>;
  agents: Array<ResolvedAgentDef>;
};

export async function loadCatalogs(
  configDir: string,
  pluginsStore: { getInstalled?(): unknown[] },
): Promise<Catalogs> {
  const skills = await loadSkillsCatalog(`${configDir}/skills`);
  const mcps = await loadMcpCatalog(`${configDir}/mcp.json`);
  const agentTemplates = await loadAgentsCatalog(`${configDir}/agents`, skills, mcps);
  const agents = migrateInstalledAgents(agentTemplates, pluginsStore);
  return { skills, mcps, agents };
}