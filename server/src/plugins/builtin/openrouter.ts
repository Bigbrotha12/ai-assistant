import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ModelPluginDefinition } from "../types.ts";
import { env } from "../../config/env.ts";
import { kev4bPlugin } from "./kev4b.ts";

/**
 * Built-in model plugins.
 *
 * OpenRouter ships as the only third-party chat provider. OpenAI and Anthropic
 * ToS restrict access to their models to their own first-party platforms;
 * proxying them through a third-party service from this gateway could breach
 * those agreements. OpenRouter aggregates many providers under its own terms
 * against a single user-supplied key, so it is the safe built-in default. Every
 * other provider — OpenAI/Anthropic included — must be added as an
 * admin-installable manifest/allowlist entry, never as more builtin code.
 *
 * Kev-4B is the one non-chat builtin: an internal, credential-less decision
 * model marked `mode: "decisions"` (see `kev4b.ts`). It is not a chat provider
 * and never appears on the chat/model-list surfaces.
 *
 * The OpenRouter endpoint + default model are env-configurable via
 * DEFAULT_MODEL_PROVIDER_BASE_URL / DEFAULT_MODEL_PROVIDER_MODEL so a
 * self-hosted operator can point the builtin at any OpenAI-compatible
 * provider without editing code. Everything else is fixed.
 */
const baseUrl = env.DEFAULT_MODEL_PROVIDER_BASE_URL;
const defaultModel = env.DEFAULT_MODEL_PROVIDER_MODEL;

const parsed = pluginDefinitionSchema.parse({
  id: "openrouter",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "model",
  name: "OpenRouter",
  description: "Single API for 400+ models.",
  inference: {
    endpoint: baseUrl,
    defaultModel,
    tokenLimit: 131072,
    supportsStreaming: true,
    visionCapable: true,
    parameters: {},
  },
  baseUrls: [
    {
      id: "openrouter-default",
      url: baseUrl,
      label: "Default provider endpoint",
    },
  ],
  credentials: {
    // User-owned key; never persisted server-side.
    apiKey: { label: "Default provider API key", required: true },
  },
});

if (parsed.type !== "model") {
  throw new Error("builtin plugin 'openrouter' must be a model plugin");
}

/** The built-in OpenRouter model plugin. */
export const openRouterPlugin: ModelPluginDefinition = parsed;

/**
 * Built-in model plugins, seeded by the registry/installer: the OpenRouter chat
 * provider and the internal Kev-4B decision model. The membership guard in the
 * test suite keeps accidental third-party chat providers out.
 */
export const builtinPlugins: readonly ModelPluginDefinition[] = [
  openRouterPlugin,
  kev4bPlugin,
];

/** Stable ids of the built-in plugins, for id-based membership checks. */
export const builtinPluginIds: readonly string[] = builtinPlugins.map(
  (plugin) => plugin.id,
);