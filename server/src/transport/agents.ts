import { Hono } from "hono";
import { keyGateResponse, requireApiKey } from "../api_key.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
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

/**
 * `now` (epoch seconds) is an optional test seam for the golden wire-shape
 * contract (`server/test/transport/contract.test.ts`); it defaults to the
 * current wall-clock second, so production callers are unchanged.
 */
export function agentListFromCatalogs(
  catalogs: Catalogs,
  now: number = Math.floor(Date.now() / 1000),
): AgentsListResponse {
  const data = catalogs.agents.map(a => ({
    id: a.id,
    object: "agent" as const,
    created: now,
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
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);

    try {
      return c.json(agentListFromCatalogs(catalogs));
    } catch (err) {
      console.error("agents: catalog unavailable", err);
      return c.json({ error: "inference_unavailable" }, 502);
    }
  });

  return routes;
}