import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type {
  ToolDefinition,
  ToolPluginDefinition,
} from "../plugins/types.ts";
import { jsonSchemaToZod } from "./mcp.ts";
import {
  DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  invokeBoundedToolHandler,
  serializeBoundedToolArguments,
} from "../tool_bounds.ts";
import { emitPluginToolAudit } from "../audit/telemetry.ts";

// Single source of truth for JSON-Schema -> zod translation lives in
// `agents/mcp.ts` (it also infers `type` for schema-less MCP tools). Re-export
// it here so the tool-binding path and the runner keep importing from one spot.
export { jsonSchemaToZod };

/**
 * Wiring layer (Phase 2 plan: `orchestrator.ts`): assembles a ready-to-run
 * supervisor agent from the plugin registry + an already-configured model.
 *
 * Tool plugins from the registry are translated into LangChain
 * `DynamicStructuredTool` instances whose `func` delegates to an injected
 * {@link ToolCallHandler}. The transport wires the real handler — the
 * {@link ToolExecutor} from `jobs/runner.ts` (validatedFetch + pinned IPs +
 * per-plugin credentials) for both the synchronous stream and background jobs.
 * Model plugins are NOT wired here: the transport selects the model from the
 * request and passes it in already configured.
 */

/**
 * Executes a tool call against a plugin's backend. The production
 * implementation is the `ToolExecutor` (validatedFetch + pinned IPs + trusted
 * hosts); tests substitute a recording fake. The optional `credentials`
 * parameter carries the per-plugin key the handler should forward.
 */
export interface ToolCallHandler {
  execute(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    credentials?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export type BindPluginToolsOptions = {
  owner?: string;
  requestId?: string;
  timeoutMs?: number;
  maxResultChars?: number;
};

/** Translate installed tool plugins into LangChain tools. Exported for tests. */
export function bindPluginTools(
  registry: PluginRegistry,
  toolHandler: ToolCallHandler,
  enabledPlugins?: readonly string[],
  options: BindPluginToolsOptions = {},
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
      tools.push(bindPluginTool(plugin, toolDef, toolHandler, options));
    }
  }
  return tools;
}

function bindPluginTool(
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  toolHandler: ToolCallHandler,
  options: BindPluginToolsOptions,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (args, _runManager, config) => {
      const startedAt = Date.now();
      let inputBytes = 0;
      let outputBytes = 0;
      let outcome: "ok" | "error" | "timeout" | "cancelled" = "ok";
      let errorCode: string | undefined;
      try {
        const serialized = serializeBoundedToolArguments(args);
        inputBytes = Buffer.byteLength(serialized, "utf8");
        const result = await invokeBoundedToolHandler(
          (signal) => toolHandler.execute(plugin.id, toolDef.name, args, undefined, signal),
          {
            timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
            maxResultChars: options.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
            signal: config?.signal,
            timeoutMessage: `tool '${toolDef.name}' of plugin '${plugin.id}' exceeded the handler timeout`,
          },
        );
        outputBytes = Buffer.byteLength(result, "utf8");
        return result;
      } catch (error) {
        outcome = config?.signal?.aborted || (error instanceof Error && error.name === "AbortError")
          ? "cancelled"
          : error instanceof Error && "code" in error && error.code === "tool_timeout"
            ? "timeout"
            : "error";
        errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
        throw error;
      } finally {
        try {
          emitPluginToolAudit({
            owner: options.owner,
            pluginId: plugin.id,
            tool: toolDef.name,
            requestId: options.requestId,
            outcome,
            durationMs: Math.max(0, Date.now() - startedAt),
            inputBytes,
            outputBytes,
            ...(errorCode === undefined ? {} : { errorCode }),
          });
        } catch {
        }
      }
    },
  });
}

/**
 * Merge plugin-bound tools with MCP tools, deduplicating by name (the MCP
 * version loses ties, matching both the sync transport and the job runner).
 */
export function mergePluginAndMcpTools(
  pluginTools: DynamicStructuredTool[],
  mcpTools: DynamicStructuredTool[],
  logPrefix: string,
): DynamicStructuredTool[] {
  const allTools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  for (const t of [...pluginTools, ...mcpTools]) {
    if (seen.has(t.name)) {
      if (mcpTools.includes(t)) {
        console.warn(
          `${logPrefix} tool '${t.name}' defined by both a plugin and an MCP server; skipping MCP version`,
        );
      }
      continue;
    }
    seen.add(t.name);
    allTools.push(t);
  }
  return allTools;
}