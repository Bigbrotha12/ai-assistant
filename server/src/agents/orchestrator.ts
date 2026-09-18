import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type {
  JsonSchema,
  ToolDefinition,
  ToolPluginDefinition,
} from "../plugins/types.ts";
import { createAgentGraph } from "./graph.ts";
import type { AgentGraphDeps } from "./graph.ts";

/**
 * Wiring layer (Phase 2 plan: `orchestrator.ts`): assembles a ready-to-run
 * supervisor agent from the plugin registry + an already-configured model.
 *
 * Tool plugins from the registry are translated into LangChain
 * `DynamicStructuredTool` instances whose `func` delegates to an injected
 * {@link ToolCallHandler}. The handler is a stub today — Wave B1/C1 drops in
 * the real executor that performs the outbound HTTP call via `validatedFetch`
 * + `getPinnedIps` (ssrf.ts / store.ts) and resolves plugin credentials
 * (credential pinning is Wave B2). Model plugins are NOT wired here: Phase 3's
 * transport selects the model from the request and passes it in already
 * configured.
 */

/**
 * Executes a tool call against a plugin's backend. Declared, not implemented:
 * Wave B1/C1 supplies the real implementation (validatedFetch + pinned IPs),
 * Wave B2 supplies credential pinning. The optional `credentials` parameter
 * exists so the future implementation can receive pinned plugin credentials.
 */
export interface ToolCallHandler {
  execute(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<string>;
}

/** Placeholder handler: never reaches the network; reports the call honestly. */
export const stubToolCallHandler: ToolCallHandler = {
  async execute(_pluginId, _toolName, args, _credentials) {
    return JSON.stringify({ ok: true, ...args, note: "executor not wired" });
  },
};

export type CreateAgentParams = {
  /** Already-configured chat model (model plugins are chosen by Phase 3 transport). */
  model: BaseChatModel;
  /** Plugin registry to bind tool plugins from. */
  registry: PluginRegistry;
  /** Tool execution handler. Defaults to {@link stubToolCallHandler}. */
  toolHandler?: ToolCallHandler;
  /** Max tool rounds before the graph terminates. Default `MAX_TOOL_ROUNDS`. */
  maxIterations?: number;
};

/**
 * Build a ready-to-run supervisor agent: binds every installed tool plugin's
 * tools into the graph and returns the compiled graph.
 */
export function createAgent(params: CreateAgentParams): ReturnType<typeof createAgentGraph> {
  const { model, registry, toolHandler = stubToolCallHandler, maxIterations } = params;
  const tools = bindPluginTools(registry, toolHandler);
  const deps: AgentGraphDeps = { model, tools, maxIterations };
  return createAgentGraph(deps);
}

/** Alias for parity with the plan's `orchestrator.ts` naming. */
export const createOrchestrator = createAgent;

/** Translate installed tool plugins into LangChain tools. Exported for tests. */
export function bindPluginTools(
  registry: PluginRegistry,
  toolHandler: ToolCallHandler,
  enabledPlugins?: readonly string[],
): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  const enabled = enabledPlugins === undefined ? null : new Set(enabledPlugins);
  for (const plugin of registry.listInstalledPlugins()) {
    if (!isToolPlugin(plugin)) continue;
    if (enabled !== null && !enabled.has(plugin.id)) continue;
    for (const toolDef of plugin.tools) {
      if (seen.has(toolDef.name)) {
        console.warn(
          `[agents] skipping duplicate tool '${toolDef.name}' from plugin '${plugin.id}'`,
        );
        continue;
      }
      seen.add(toolDef.name);
      tools.push(bindPluginTool(plugin, toolDef, toolHandler));
    }
  }
  return tools;
}

function bindPluginTool(
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  toolHandler: ToolCallHandler,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (args) => {
      // Wave B1/C1: the real handler performs the outbound HTTP call
      // (validatedFetch + pinned IPs + pinned credentials). For now this is
      // either the stub or a handler injected by tests/transport.
      return toolHandler.execute(plugin.id, toolDef.name, args);
    },
  });
}

/**
 * Translate the plugins' minimal `JsonSchema` (type/properties/required/items)
 * into a zod schema for `DynamicStructuredTool`. Unknown/unmapped types map to
 * `z.any()` with a warning — one bad tool must never crash the registry.
 * Exported for tests.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  switch (schema.type) {
    case "object": {
      const properties = schema.properties ?? {};
      const entries = Object.entries(properties).map(([key, prop]) => {
        const field = withDescription(jsonSchemaToZod(prop), prop);
        return [key, schema.required?.includes(key) ? field : field.optional()] as const;
      });
      if (entries.length === 0) return z.record(z.string(), z.any());
      return z.object(Object.fromEntries(entries));
    }
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(withDescription(jsonSchemaToZod(schema.items ?? {}), schema));
    default: {
      console.warn(
        `[agents] tool schema: unmapped JSON schema type '${String(schema.type)}' → z.any()`,
      );
      return z.any();
    }
  }
}

/** Attach the JSON Schema `description` to the zod field when present. */
function withDescription(field: z.ZodType, schema: JsonSchema): z.ZodType {
  return schema.description ? field.describe(schema.description) : field;
}