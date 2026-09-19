import { vikunjaManifest } from "./vikunja.ts";
import { mealieManifest } from "./mealie.ts";
import { spielManifest } from "./spiel.ts";
import { defaultAgentPlugin, builtinAgentPlugins } from "./agent-default.ts";
import type { ToolPluginDefinition, AgentPluginDefinition } from "../types.ts";

export { vikunjaManifest, mealieManifest, spielManifest };
export { defaultAgentPlugin, builtinAgentPlugins };

/**
 * Catalog of admin-installable tool plugin templates. These are NOT loaded
 * automatically and are NOT part of `builtinPlugins` — the store (Step 4)
 * lists them as optional installs the admin can copy into `plugins.json`,
 * after which the admin must also wire the matching trusted hosts and
 * credential (see the per-manifest SSRF comments).
 */
export const availableToolManifests: readonly ToolPluginDefinition[] = [
  vikunjaManifest,
  mealieManifest,
  spielManifest,
];

/**
 * Catalog of built-in agent manifests that are always available but are
 * NOT part of `builtinPlugins` (agent manifests are not persisted to the
 * store; they are served separately via `GET /v1/agents`).
 */
export const availableAgentManifests: readonly AgentPluginDefinition[] =
  builtinAgentPlugins;