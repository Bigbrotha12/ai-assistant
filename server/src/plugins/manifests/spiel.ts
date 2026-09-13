import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ToolPluginDefinition } from "../types.ts";

/**
 * Optional SpielIndexer tool plugin manifest (admin-installable template).
 *
 * This is NOT a builtin: the admin opts in by installing it into the plugin
 * store (Step 4's `plugins.json`) and supplying a personal access token.
 *
 * SSRF requirement: `https://spiel.local` is a private homelab hostname that
 * the Step 2 SSRF module (`src/plugins/ssrf.ts`) rejects by default (it
 * resolves to a non-public address). The admin MUST add this host to the
 * trusted-host config — Step 4 wires that from env — before any SpielIndexer
 * tool may connect.
 */
const parsed = pluginDefinitionSchema.parse({
  id: "spiel",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "tool",
  name: "SpielIndexer",
  description: "Media search and indexing for your SpielIndexer instance (homelab).",
  baseUrls: [
    {
      id: "spiel-homelab",
      url: "https://spiel.local",
      label: "Spiel homelab",
    },
  ],
  credentials: {
    apiKey: { label: "Personal access token", required: true },
  },
  tools: [
    {
      name: "search_media",
      description: "Search the SpielIndexer media library.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text" },
          media_type: {
            type: "string",
            description: "Limit results: one of 'movie', 'show', or 'song'",
          },
        },
      },
    },
    {
      name: "get_media_details",
      description: "Fetch full metadata for a single indexed media item.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Spiel media item id" },
        },
        required: ["id"],
      },
    },
    {
      name: "add_to_library",
      description: "Add a discovered media item to the user's library.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          media_id: { type: "string", description: "Id of the media item to add" },
        },
        required: ["media_id"],
      },
    },
  ],
});

if (parsed.type !== "tool") {
  throw new Error("manifest 'spiel' must be a tool plugin");
}

/** Admin-installable SpielIndexer tool plugin template. */
export const spielManifest: ToolPluginDefinition = parsed;