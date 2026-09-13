import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ModelPluginDefinition } from "../types.ts";

/**
 * Builtin model plugins.
 *
 * Only OpenRouter ships built in. OpenAI and Anthropic ToS restrict access to
 * their models to their own first-party platforms; proxying them through a
 * third-party service from this gateway could breach those agreements.
 * OpenRouter aggregates many providers under its own terms against a single
 * user-supplied key, so it is the safe built-in default. Every other provider
 * — OpenAI/Anthropic included — must be added as an admin-installable
 * manifest/allowlist entry (Step 4's store), never as more builtin code.
 */
const parsed = pluginDefinitionSchema.parse({
  id: "openrouter",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "model",
  name: "OpenRouter",
  description:
    "Single API for 400+ models — user supplies their own OpenRouter API key.",
  inference: {
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    tokenLimit: 131072,
    supportsStreaming: true,
    visionCapable: true,
    parameters: {},
  },
  baseUrls: [
    {
      id: "openrouter-default",
      url: "https://openrouter.ai/api/v1",
      label: "OpenRouter API (default)",
    },
  ],
  credentials: {
    // User-owned key; never persisted server-side.
    apiKey: { label: "OpenRouter API key", required: true },
  },
});

if (parsed.type !== "model") {
  throw new Error("builtin plugin 'openrouter' must be a model plugin");
}

/** The built-in OpenRouter model plugin. */
export const openRouterPlugin: ModelPluginDefinition = parsed;

/**
 * Built-in model plugins, seeded by the registry/installer. Currently exactly
 * one entry — the membership test guards against accidentally adding
 * OpenAI/Anthropic as builtins later.
 */
export const builtinPlugins: readonly ModelPluginDefinition[] = [
  openRouterPlugin,
];

/** Stable ids of the built-in plugins, for id-based membership checks. */
export const builtinPluginIds: readonly string[] = builtinPlugins.map(
  (plugin) => plugin.id,
);