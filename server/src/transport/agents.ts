import { Hono } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { AgentPluginDefinition } from "../plugins/types.ts";
import type { Catalogs } from "../catalog/index.ts";

export type AgentSummary = {
  id: string;
  object: "agent";
  created: number;
  owned_by: "plugin";
  name: string;
  description: string;
  defaultModel?: string;
  visionCapable: boolean;
  temperature?: number;
  maxTokens?: number;
  toolGrants?: { pluginId: string; required: boolean }[];
  skillCount: number;
  skillIds: string[];
  mcpNames: string[];
  source: "template" | "plugin";
};

export type AgentsListResponse = {
  object: "list";
  data: AgentSummary[];
};

export function agentListFromPlugins(
  agents: AgentPluginDefinition[],
): AgentsListResponse {
  const data = agents
    .map((plugin): AgentSummary => ({
      id: plugin.id,
      object: "agent",
      created: Math.floor(Date.now() / 1000),
      owned_by: "plugin",
      name: plugin.name,
      description: plugin.description,
      defaultModel: plugin.modelRef,
      visionCapable: plugin.inference?.visionCapable ?? false,
      temperature: plugin.inference?.temperature,
      maxTokens: plugin.inference?.maxTokens,
      toolGrants: plugin.tools,
      skillCount: plugin.skills?.length ?? 0,
      skillIds: (plugin.skills ?? []).map(s => s.id),
      mcpNames: (plugin.mcpServers ?? []).map(s => s.name),
      source: "plugin",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

export function agentListFromCatalogs(
  catalogs: Catalogs,
): AgentsListResponse {
  const data = catalogs.agents.map(a => ({
    id: a.id,
    object: "agent" as const,
    created: Math.floor(Date.now() / 1000),
    owned_by: "plugin" as const,
    name: a.name,
    description: a.description,
    defaultModel: a.modelRef,
    visionCapable: a.inference?.visionCapable ?? false,
    temperature: a.inference?.temperature,
    maxTokens: a.inference?.maxTokens,
    toolGrants: a.tools,
    skillCount: a.skills.length,
    skillIds: a.skills.map((s: { id: string }) => s.id),
    mcpNames: a.mcpServers.map((s: { name: string }) => s.name),
    source: "template" as const,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

export type AgentsRoutesOptions = {
  registry: PluginRegistry;
  catalogs: Catalogs;
  verifyKey?: VerifyApiKeyFn;
};

export function createAgentsRoutes(opts: AgentsRoutesOptions): Hono {
  const { catalogs } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  routes.get("/agents", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);

    try {
      return c.json(agentListFromCatalogs(catalogs));
    } catch (err) {
      console.error("agents: catalog unavailable", err);
      return c.json({ error: "inference_unavailable" }, 502);
    }
  });

  return routes;
}