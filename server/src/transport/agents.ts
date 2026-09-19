import { Hono } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isAgentPlugin } from "../plugins/types.ts";
import type { AgentPluginDefinition } from "../plugins/types.ts";

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
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { object: "list", data };
}

export type AgentsRoutesOptions = {
  registry: PluginRegistry;
  verifyKey?: VerifyApiKeyFn;
};

export function createAgentsRoutes(opts: AgentsRoutesOptions): Hono {
  const { registry } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;

  const routes = new Hono();

  routes.get("/agents", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);

    let agentPlugins: AgentPluginDefinition[];
    try {
      agentPlugins = registry.listInstalledPlugins().filter(isAgentPlugin);
    } catch (err) {
      console.error("agents: plugin registry unavailable", err);
      return c.json({ error: "inference_unavailable" }, 502);
    }
    return c.json(agentListFromPlugins(agentPlugins));
  });

  return routes;
}