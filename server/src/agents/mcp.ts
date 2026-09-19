import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import { validatedFetch } from "../plugins/ssrf.ts";
import type { JsonSchema } from "../plugins/types.ts";

export type McpServerConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
};

export class McpError extends Error {
  readonly code: string;
  constructor(message: string, code = "MCP_ERROR") {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export async function mcpCall(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    trustedHosts?: readonly string[];
    lookup?: LookupFn;
    fetchFn?: typeof fetch;
    mode?: Mode;
  },
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id: 1,
  });

  // Combine the caller's signal with a per-call timeout so a hung MCP server
  // cannot block the request indefinitely.
  const timeoutSignal = AbortSignal.timeout(env.MCP_CALL_TIMEOUT_MS);
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await validatedFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...opts.headers,
        },
        body,
        signal: combined,
      },
      {
        trustedHosts: opts.trustedHosts,
        lookup: opts.lookup,
        fetchFn: opts.fetchFn,
        mode: opts.mode,
      },
    );

    if (!response.ok) {
      throw new McpError(`MCP server returned ${response.status}`);
    }

    const json: unknown = await response.json();
    if (typeof json === "object" && json !== null && "error" in json) {
      const err = (json as { error: { message?: string } }).error;
      throw new McpError(`MCP error: ${err.message ?? JSON.stringify(err)}`);
    }
    return (json as { result: unknown }).result;
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      throw new McpError(`MCP call to ${url} timed out`);
    }
    throw err;
  }
}

function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
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
      logger.warn(
        `[mcp] tool schema: unmapped JSON schema type '${String(schema.type)}' → z.any()`,
      );
      return z.any();
    }
  }
}

function withDescription(field: z.ZodType, schema: JsonSchema): z.ZodType {
  return schema.description ? field.describe(schema.description) : field;
}

export async function bindMcpServers(
  mcpServers: McpServerConfig[],
  _credentials?: Record<string, string>,
  opts?: {
    signal?: AbortSignal;
    trustedHosts?: readonly string[];
    lookup?: LookupFn;
    fetchFn?: typeof fetch;
    mode?: Mode;
  },
): Promise<DynamicStructuredTool[]> {
  const tools: DynamicStructuredTool[] = [];
  for (const server of mcpServers) {
    try {
      await mcpCall(server.url, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ai-assistant-gateway", version: "0.1.0" },
      }, { ...opts, headers: server.headers });

      const result = await mcpCall(server.url, "tools/list", undefined, {
        ...opts,
        headers: server.headers,
      });

      const mcpTools = ((result as { tools?: unknown[] })?.tools ?? []) as {
        name: string;
        description?: string;
        inputSchema?: JsonSchema;
      }[];

      for (const tool of mcpTools) {
        if (!tool.name) continue;

        const schema = tool.inputSchema
          ? jsonSchemaToZod(tool.inputSchema as JsonSchema)
          : z.object({});

        tools.push(
          new DynamicStructuredTool({
            name: tool.name,
            description: tool.description ?? "",
            schema,
            func: async (args: Record<string, unknown>) => {
              const callResult = (await mcpCall(server.url, "tools/call", {
                name: tool.name,
                arguments: args,
              }, {
                ...opts,
                headers: server.headers,
                signal: opts?.signal,
              })) as { content?: { type?: string; text?: string }[] };

              const content = callResult?.content ?? [];
              return content.map((c) => c.text ?? "").join("\n");
            },
          }),
        );
      }
    } catch (err) {
      logger.warn(
        `[mcp] failed to bind tools from server '${server.name}':`,
        err instanceof McpError ? err.message : err,
      );
    }
  }
  return tools;
}