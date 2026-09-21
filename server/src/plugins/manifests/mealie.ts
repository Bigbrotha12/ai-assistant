import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ToolPluginDefinition } from "../types.ts";

/**
 * Optional Mealie tool plugin manifest (admin-installable template).
 *
 * This is NOT a builtin: the admin opts in by installing it into the plugin
 * store (Step 4's `plugins.json`) and supplying a personal access token.
 *
 * SSRF requirement: `https://mealie.local` is a private homelab hostname
 * that the Step 2 SSRF module (`src/plugins/ssrf.ts`) rejects by default (it
 * resolves to a non-public address). The admin MUST add this host to the
 * trusted-host config — Step 4 wires that from env — before any Mealie tool
 * may connect.
 */
const parsed = pluginDefinitionSchema.parse({
  id: "mealie",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "tool",
  name: "Mealie",
  description: "Recipe management for your Mealie instance (homelab).",
  baseUrls: [
    {
      id: "mealie-homelab",
      url: "https://mealie.local",
      label: "Mealie homelab",
    },
  ],
  credentials: {
    apiKey: { label: "Personal access token", required: true },
  },
  warmupTools: ["search_recipes"],
  tools: [
    {
      name: "get_random_recipe",
      description: "Fetch a single random recipe from the Mealie collection.",
      readOnly: true,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_recipes",
      description: "Search the Mealie recipe collection.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query" },
          tags: {
            type: "array",
            description: "Only return recipes tagged with any of these tags",
            items: { type: "string" },
          },
        },
      },
    },
    {
      name: "get_recipe_by_id",
      description: "Fetch a full recipe by its Mealie id (slug or UUID).",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Mealie recipe id (slug or UUID)",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "create_recipe",
      description: "Create a new recipe in Mealie.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Recipe name" },
          description: {
            type: "string",
            description: "Optional recipe description",
          },
          ingredients: {
            type: "array",
            description: "List of ingredient strings",
            items: { type: "string" },
          },
        },
        required: ["name"],
      },
    },
  ],
});

if (parsed.type !== "tool") {
  throw new Error("manifest 'mealie' must be a tool plugin");
}

/** Admin-installable Mealie tool plugin template. */
export const mealieManifest: ToolPluginDefinition = parsed;