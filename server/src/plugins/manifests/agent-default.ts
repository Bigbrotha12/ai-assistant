import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { AgentPluginDefinition } from "../types.ts";

const parsed = pluginDefinitionSchema.parse({
  id: "default",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "agent",
  name: "Default",
  description:
    "General-purpose assistant with your selected model and enabled tools.",
  systemPrompt:
    "You are a helpful voice and text assistant. Decide whether to call a tool or answer directly based on the user's request. Never invent tool output.",
  skills: [],
  tools: [],
});

if (parsed.type !== "agent") {
  throw new Error("manifest 'default' must be an agent plugin");
}

export const defaultAgentPlugin: AgentPluginDefinition = parsed;

export const builtinAgentPlugins: readonly AgentPluginDefinition[] = [
  defaultAgentPlugin,
];