import {
  CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  pluginDefinitionSchema,
} from "../types.ts";
import type { ModelPluginDefinition } from "../types.ts";

/**
 * The Kev-4B internal decision model plugin.
 *
 * Unlike OpenRouter, this is not a chat provider: `mode: "decisions"` marks it
 * internal-only, so no client can select it through `/v1/models`, the plugin
 * marketplace, or the plugin detail route (see `registry.ts`/`models.ts`).
 * Only the decision transport reaches it. The endpoint is a private,
 * plain-`http:` llama.cpp-style server; it becomes reachable ONLY through the
 * egress facade's `egressTrustOptions` host trust, and the URL never leaves the
 * gateway.
 *
 * No credentials: the server is on the internal network and unauthenticated.
 * `supportsStreaming`/`visionCapable` are false — the decisions path is a
 * one-shot, text-only request per question.
 */
const parsed = pluginDefinitionSchema.parse({
  id: "kev-4b",
  version: "1.0.0",
  schemaVersion: CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION,
  type: "model",
  name: "Kev-4B",
  description: "Internal decision model for the Sentinel decisions path.",
  inference: {
    endpoint: "http://llama-kev.local:19096",
    defaultModel: "Kev-4B-Q8_0.gguf",
    tokenLimit: 512,
    supportsStreaming: false,
    visionCapable: false,
    parameters: {},
    mode: "decisions",
  },
});

if (parsed.type !== "model") {
  throw new Error("builtin plugin 'kev-4b' must be a model plugin");
}

/** The built-in Kev-4B internal decision model plugin. */
export const kev4bPlugin: ModelPluginDefinition = parsed;
