import { loadSkillsCatalog } from "./skills.ts";
import { loadMcpCatalog } from "./mcp.ts";
import { loadAgentsCatalog, migrateInstalledAgents } from "./agents.ts";
import type { ResolvedAgentDef } from "./agents.ts";

export type { ResolvedAgentDef };

export type CatalogAgent = Omit<ResolvedAgentDef, "mcpServers"> & {
  mcpServers: Array<{
    name: string;
    url: string;
    headers?: Record<string, string>;
    headerRefs?: Record<string, string>;
    pinnedIps?: readonly string[];
  }>;
};

export type RetainedCatalogMcpPin = {
  agentPluginId: string;
  serverName: string;
  url: string;
  pinnedIps: readonly string[];
};

type CatalogPluginStore = {
  getInstalled?(): unknown[];
  retainCatalogMcpPins?(entries: RetainedCatalogMcpPin[]): void;
};

export type Catalogs = {
  skills: Array<{ id: string; title: string; content: string }>;
  mcps: Array<{
    name: string;
    url: string;
    headers?: Record<string, string>;
    headerRefs?: Record<string, string>;
    pinnedIps?: readonly string[];
  }>;
  agents: Array<CatalogAgent>;
};

export async function loadCatalogs(
  configDir: string,
  pluginsStore: CatalogPluginStore,
): Promise<Catalogs> {
  const skills = await loadSkillsCatalog(`${configDir}/skills`);
  const mcps = await loadMcpCatalog(`${configDir}/mcp.json`);
  const agentTemplates = await loadAgentsCatalog(`${configDir}/agents`, skills, mcps);
  const resolved = migrateInstalledAgents(agentTemplates, pluginsStore);
  const mcpByName = new Map(mcps.map((entry) => [entry.name, entry]));
  const retainedPins: RetainedCatalogMcpPin[] = [];
  const agents: CatalogAgent[] = resolved.map((agent) => ({
    ...agent,
    mcpServers: agent.mcpServers.map((server) => {
      const catalogServer = mcpByName.get(server.name);
      const pinnedIps = catalogServer?.url === server.url
        ? catalogServer.pinnedIps
        : undefined;
      if (pinnedIps !== undefined) {
        retainedPins.push({
          agentPluginId: agent.id,
          serverName: server.name,
          url: server.url,
          pinnedIps: [...pinnedIps],
        });
      }
      return pinnedIps === undefined ? server : { ...server, pinnedIps: [...pinnedIps] };
    }),
  }));
  pluginsStore.retainCatalogMcpPins?.(retainedPins);
  return { skills, mcps, agents };
}