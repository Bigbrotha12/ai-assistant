import { z } from "zod";

/**
 * Schema version of the persisted plugin store (`plugins.json`).
 * Bump this when the *shape of the store* changes — top-level `schemaVersion`
 * is the version of this file, NOT of any individual plugin definition.
 */
export const CURRENT_PLUGIN_STORE_SCHEMA_VERSION = 2;
export const LEGACY_PLUGIN_STORE_SCHEMA_VERSION = 1;

/**
 * Schema version of an individual plugin definition (the per-plugin
 * `schemaVersion` field carried by every plugin/manifest). Independent from
 * the store axis above: a new store revision does not force a plugin
 * definition revision. `pluginDefinitionSchema` constrains definitions to this
 * value at parse time.
 */
export const CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION = 1;

/**
 * Stable plugin identifier, lowercase kebab-case. Clients reference plugins and
 * allowlist entries by this id, so it must be URL-safe and unambiguous.
 */
export const pluginIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be lowercase kebab-case, e.g. 'vikunja' or 'open-router'",
  );

export const MCP_HEADER_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isMcpHeaderReference(value: string): boolean {
  return MCP_HEADER_REFERENCE_PATTERN.test(value);
}

const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be semver, e.g. 1.4.0");

// Singleton recursive JSON Schema node; `z.lazy` defers the self-reference so
// `properties`/`items` can nest arbitrarily deep.
export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), z.lazy(() => jsonSchemaSchema)).optional(),
    required: z.array(z.string()).optional(),
    items: z.lazy(() => jsonSchemaSchema).optional(),
  }),
);

export const baseUrlAllowlistEntrySchema: z.ZodType<BaseUrlAllowlistEntry> =
  z.object({
    id: pluginIdSchema,
    // Format-level validation only (must parse as URL). SSRF IP/range
    // allow-listing lives in `ssrf.ts`; don't duplicate it here.
    url: z.string().url("must be an absolute URL"),
    label: z.string().trim().min(1).optional(),
  });

export const credentialSpecSchema: z.ZodType<CredentialSpec> = z.object({
  apiKey: z.object({
    label: z.string().trim().min(1),
    required: z.boolean(),
  }),
});

export const toolDefinitionSchema: z.ZodType<ToolDefinition> = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  // Mutating tools are never warmup'd/cached; only safe-to-repeat (GET-ish)
  // tools may be pre-warmed.
  readOnly: z.boolean(),
  inputSchema: jsonSchemaSchema,
});

export type InferenceMode = "chat" | "decisions";

export const inferenceDefinitionSchema: z.ZodType<InferenceDefinition> =
  z.object({
    endpoint: z
      .string()
      .url("must be the LLM provider base URL"),
    defaultModel: z.string().trim().min(1),
    tokenLimit: z.number().int().positive(),
    supportsStreaming: z.boolean(),
    visionCapable: z.boolean(),
    parameters: z.record(z.string(), z.unknown()),
    // Inference role. Omitted input (every definition written before this
    // field existed) parses as "chat", so the plugin definition schema
    // version does not need to move. `decisions` plugins are internal-only:
    // they are hidden from /v1/models and the plugin list/detail surfaces.
    mode: z.enum(["chat", "decisions"]).default("chat"),
  });

export const toolPluginDefinitionSchema = z.object({
    id: pluginIdSchema,
    version: semverSchema,
    schemaVersion: z.literal(CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION),
    type: z.literal("tool"),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: z.string().trim().min(1).optional(),
    // A tool plugin with no tools is meaningless; require at least one.
    tools: z.array(toolDefinitionSchema).min(1),
    // Read-only, zero-arg tools the gateway may pre-warm per owner.
    // Declared in plugin metadata instead of a hardcoded list so the
    // admin's installed set controls what is warmed. Only `readOnly` tools with
    // no required args are actually scheduled (defense in depth at schedule
    // time too).
    warmupTools: z.array(z.string()).optional(),
    baseUrls: z.array(baseUrlAllowlistEntrySchema),
    credentials: credentialSpecSchema.optional(),
  });

export const modelPluginDefinitionSchema = z.object({
    id: pluginIdSchema,
    version: semverSchema,
    schemaVersion: z.literal(CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION),
    type: z.literal("model"),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: z.string().trim().min(1).optional(),
    inference: inferenceDefinitionSchema,
    baseUrls: z.array(baseUrlAllowlistEntrySchema).optional(),
    credentials: credentialSpecSchema.optional(),
  });

/**
 * Per-tool MCP allowlist entry (Phase 1.1). Shared by the agent manifest, the
 * resolved catalog entry, the chat `agentOverride`, and `McpBindOptions`.
 */
export type AgentToolAllowlistEntry = { name: string; readOnly?: boolean };

const agentToolAllowlistSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1),
      readOnly: z.boolean().optional(),
    }),
  )
  .refine(
    (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
    "toolAllowlist names must be unique",
  );

export const agentPluginDefinitionSchema = z.object({
    id: pluginIdSchema,
    version: semverSchema,
    schemaVersion: z.literal(CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION),
    type: z.literal("agent"),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: z.string().trim().min(1).optional(),
    systemPrompt: z.string().trim().min(1),
    skills: z
      .array(z.object({
        id: pluginIdSchema,
        title: z.string().trim().min(1),
        content: z.string().trim().min(1),
      }))
      .optional(),
    tools: z
      .array(z.object({
        pluginId: pluginIdSchema,
        required: z.boolean().default(false),
      }))
      .optional(),
    modelRef: pluginIdSchema.optional(),
    inference: z.object({
      temperature: z.number().optional(),
      maxTokens: z.number().int().positive().optional(),
      visionCapable: z.boolean().default(false),
    }).optional(),
    baseUrls: z.array(baseUrlAllowlistEntrySchema).optional(),
    credentials: credentialSpecSchema.optional(),
    mcpServers: z.array(z.object({
      name: pluginIdSchema,
      url: z.string().url("must be an absolute URL"),
      headers: z.record(
        z.string(),
        z.string().refine(
          isMcpHeaderReference,
          "must be an environment reference such as ${MCP_TOKEN}",
        ),
      ).optional(),
    })).optional(),
    // Per-tool MCP allowlist (Phase 1.1). An entry's `readOnly: true` is also
    // the D6 declaration: the binder may classify a tool as read-only only when
    // the server does not mark it non-read-only (`readOnlyHint: false` /
    // `readOnly: false`) and does not mark it destructive (`destructiveHint: true`).
    toolAllowlist: agentToolAllowlistSchema.optional(),
    maxIterations: z.number().int().nonnegative().optional(),
  });

export const templateAgentDefinitionSchema = z.object({
  id: pluginIdSchema,
  version: semverSchema,
  schemaVersion: z.literal(CURRENT_PLUGIN_DEFINITION_SCHEMA_VERSION),
  type: z.literal("agent"),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  category: z.string().trim().min(1).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.object({ id: pluginIdSchema })).optional(),
  mcpServers: z.array(z.object({ name: pluginIdSchema })).optional(),
  tools: z.array(z.object({ pluginId: pluginIdSchema, required: z.boolean().default(false) })).optional(),
  toolAllowlist: agentToolAllowlistSchema.optional(),
  maxIterations: z.number().int().nonnegative().optional(),
  modelRef: pluginIdSchema.optional(),
  inference: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    visionCapable: z.boolean().default(false),
  }).optional(),
  baseUrls: z.array(baseUrlAllowlistEntrySchema).optional(),
  credentials: credentialSpecSchema.optional(),
});

export type TemplateAgentDefinition = z.infer<typeof templateAgentDefinitionSchema>;

export type ResolvedAgentDef = {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  skills: { id: string; title: string; content: string }[];
  mcpServers: {
    name: string;
    url: string;
    headers?: Record<string, string>;
    headerRefs?: Record<string, string>;
  }[];
  tools?: { pluginId: string; required: boolean }[];
  toolAllowlist?: AgentToolAllowlistEntry[];
  maxIterations?: number;
  modelRef?: string;
  inference?: { temperature?: number; maxTokens?: number; visionCapable?: boolean };
};

export const pluginDefinitionSchema = z.discriminatedUnion("type", [
  toolPluginDefinitionSchema,
  modelPluginDefinitionSchema,
  agentPluginDefinitionSchema,
]);

export const manifestDigestSchema = z
  .string()
  .regex(/^sha256:v1:[0-9a-f]{64}$/);

export const pluginStoreConfigSchema: z.ZodType<PluginStoreConfig> = z.object({
  schemaVersion: z.number().int().positive(),
  plugins: z.array(pluginDefinitionSchema),
  approvedDigests: z.record(z.string(), manifestDigestSchema).default({}),
});

export class PluginSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSchemaError";
  }
}

/**
 * Parse a persisted plugin store and fail fast when the on-disk schema version
 * no longer matches this build. Mirrors `config/env.ts`'s load-time fail-fast
 * philosophy, but throws so the caller (the store) can route the error.
 */
export type PluginStoreMigration = {
  config: PluginStoreConfig;
  migratedFromVersion: typeof LEGACY_PLUGIN_STORE_SCHEMA_VERSION | null;
  legacyUnpinned: boolean;
};

export function migratePluginStoreConfig(input: unknown): PluginStoreMigration {
  const result = pluginStoreConfigSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new PluginSchemaError(`Invalid plugin store config:\n${details}`);
  }
  const sourceVersion = result.data.schemaVersion;
  if (
    sourceVersion !== LEGACY_PLUGIN_STORE_SCHEMA_VERSION &&
    sourceVersion !== CURRENT_PLUGIN_STORE_SCHEMA_VERSION
  ) {
    throw new PluginSchemaError(
      `Unsupported plugin store schemaVersion ${sourceVersion}; ` +
        `this build supports ${LEGACY_PLUGIN_STORE_SCHEMA_VERSION} and ${CURRENT_PLUGIN_STORE_SCHEMA_VERSION}.`,
    );
  }
  const legacy = sourceVersion === LEGACY_PLUGIN_STORE_SCHEMA_VERSION;
  const config: PluginStoreConfig = {
    ...result.data,
    schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
    approvedDigests: legacy ? {} : result.data.approvedDigests,
  };
  const seen = new Set<string>();
  for (const plugin of config.plugins) {
    if (seen.has(plugin.id)) {
      throw new PluginSchemaError(
        `Duplicate plugin id '${plugin.id}' in plugin store; ids must be globally unique`,
      );
    }
    seen.add(plugin.id);
  }
  return {
    config,
    migratedFromVersion: legacy ? LEGACY_PLUGIN_STORE_SCHEMA_VERSION : null,
    legacyUnpinned: legacy && config.plugins.length > 0,
  };
}

export function parsePluginStoreConfig(input: unknown): PluginStoreConfig {
  return migratePluginStoreConfig(input).config;
}

export function isToolPlugin(
  plugin: PluginDefinition,
): plugin is ToolPluginDefinition {
  return plugin.type === "tool";
}

export function isModelPlugin(
  plugin: PluginDefinition,
): plugin is ModelPluginDefinition {
  return plugin.type === "model";
}

/**
 * A model plugin available to the chat surface. `mode: "decisions"` plugins
 * (e.g. the Kev-4B internal decision model) are deliberately excluded — they
 * are consumed by the decision transport, never by `/v1/models` or chat.
 * A definition predating the `mode` field parses as `"chat"` (schema default),
 * and an unparsed literal with no `mode` is treated as chat here too.
 */
export function isChatModelPlugin(
  plugin: PluginDefinition,
): plugin is ModelPluginDefinition {
  return isModelPlugin(plugin) && plugin.inference.mode !== "decisions";
}

/** A model plugin reserved for the internal decision path (never chat). */
export function isDecisionModelPlugin(
  plugin: PluginDefinition,
): plugin is ModelPluginDefinition {
  return isModelPlugin(plugin) && plugin.inference.mode === "decisions";
}

export function isAgentPlugin(
  plugin: PluginDefinition,
): plugin is AgentPluginDefinition {
  return plugin.type === "agent";
}

export interface PluginDefinition {
  /** "vikunja", "mealie", "openrouter" */
  id: string;
  /** Semver */
  version: string;
  /** Plugin schema version (zod-validated at boot) */
  schemaVersion: number;
  type: "tool" | "model" | "agent";
  /** Display name for client UI */
  name: string;
  description: string;
  /**
   * Optional display grouping for the client's tool marketplace. Free-form
   * (admins may use their own taxonomy); the client buckets unknown/missing
   * values under "Other". Metadata only — never used for resolution.
   */
  category?: string;
}

export interface ToolPluginDefinition extends PluginDefinition {
  type: "tool";
  tools: ToolDefinition[];
  /** Read-only, zero-arg tool names the gateway may pre-warm per owner. */
  warmupTools?: string[];
  /** Allowlisted backend URLs the tools call */
  baseUrls: BaseUrlAllowlistEntry[];
  credentials?: CredentialSpec;
}

export interface ModelPluginDefinition extends PluginDefinition {
  type: "model";
  inference: InferenceDefinition;
  /** Optional: override/extra allowlisted URLs */
  baseUrls?: BaseUrlAllowlistEntry[];
  /** User supplies their own provider key */
  credentials?: CredentialSpec;
}

export interface AgentPluginDefinition extends PluginDefinition {
  type: "agent";
  systemPrompt: string;
  skills?: { id: string; title: string; content: string }[];
  tools?: { pluginId: string; required: boolean }[];
  toolAllowlist?: AgentToolAllowlistEntry[];
  maxIterations?: number;
  modelRef?: string;
  inference?: { temperature?: number; maxTokens?: number; visionCapable: boolean };
  baseUrls?: BaseUrlAllowlistEntry[];
  credentials?: CredentialSpec;
  mcpServers?: { name: string; url: string; headers?: Record<string, string> }[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Never cached/warmup'd if mutating */
  readOnly: boolean;
  /** OpenAI-style function parameters */
  inputSchema: JsonSchema;
}

export interface InferenceDefinition {
  /** LLM provider base URL (allowlist entry) */
  endpoint: string;
  defaultModel: string;
  tokenLimit: number;
  supportsStreaming: boolean;
  /** Has a vision route */
  visionCapable: boolean;
  parameters: Record<string, unknown>;
  /**
   * Inference role. `"chat"` serves `/v1/chat/completions`; `"decisions"` marks
   * an internal model reached only by the decision transport and hidden from
   * the chat model list and plugin surfaces.
   *
   * The wire definition may omit this (`.default("chat")` in
   * `inferenceDefinitionSchema`), but a PARSED `InferenceDefinition` always
   * carries it, so it is required here.
   */
  mode: InferenceMode;
}

/**
 * A permitted base URL a plugin declares. Users pick an entry *id*; they never
 * supply a free-form URL (kills SSRF).
 */
export interface BaseUrlAllowlistEntry {
  /** Stable identifier clients reference when picking */
  id: string;
  /** The base URL (https enforced in prod) */
  url: string;
  /** Display label */
  label?: string;
}

/** Describes what credentials a plugin requires, so the client can prompt for them. */
export interface CredentialSpec {
  apiKey: { label: string; required: boolean };
  // future: additional typed credential fields
}

export type ManifestHashMismatch = {
  pluginId: string;
  expected: string | null;
  actual: string;
};

/** The persisted shape of `plugins.json`. */
export interface PluginStoreConfig {
  /** Store schema version (not plugin schema version) */
  schemaVersion: number;
  /** Admin-curated enabled plugins (installed) */
  plugins: PluginDefinition[];
  approvedDigests: Record<string, string>;
}

/**
 * Minimal structural JSON Schema for OpenAI-style function parameters:
 * a recursive shape (type/properties/required/items/description) — not a full
 * JSON-Schema realization.
 */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}
