import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ToolPluginDefinition } from "../types.ts";

/**
 * Optional Vikunja tool plugin manifest (admin-installable template).
 *
 * This is NOT a builtin: the admin opts in by installing it into the plugin
 * store (Step 4's `plugins.json`) and supplying a personal access token.
 *
 * SSRF requirement: `https://vikunja.local` is a private homelab hostname
 * that the Step 2 SSRF module (`src/plugins/ssrf.ts`) rejects by default (it
 * resolves to a non-public address). The admin MUST add this host to the
 * trusted-host config — Step 4 wires that from env — before any Vikunja tool
 * may connect.
 */
const parsed = pluginDefinitionSchema.parse({
  id: "vikunja",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "tool",
  name: "Vikunja",
  description: "Task management for your Vikunja instance (homelab).",
  baseUrls: [
    {
      id: "vikunja-homelab",
      url: "https://vikunja.local",
      label: "Vikunja homelab",
    },
  ],
  credentials: {
    apiKey: { label: "Personal access token", required: true },
  },
  tools: [
    {
      name: "list_tasks",
      description:
        "List tasks from a Vikunja project, optionally filtered by completion.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "Only list tasks inside this project",
          },
          done: {
            type: "boolean",
            description: "true = completed only, false = open only",
          },
        },
      },
    },
    {
      name: "create_task",
      description: "Create a new task.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: {
            type: "string",
            description: "Optional task description",
          },
          priority: {
            type: "number",
            description: "Optional priority (0 for none, 1-4 higher = more urgent)",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "complete_task",
      description: "Mark an existing task as completed.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Id of the task to complete" },
        },
        required: ["task_id"],
      },
    },
  ],
});

if (parsed.type !== "tool") {
  throw new Error("manifest 'vikunja' must be a tool plugin");
}

/** Admin-installable Vikunja tool plugin template. */
export const vikunjaManifest: ToolPluginDefinition = parsed;