import { DynamicStructuredTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import {
  buildPinnedAgent,
  normalizeHostname,
  resolveAndValidateHost,
  validateStaticUrl,
} from "../plugins/ssrf.ts";
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

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

export type McpCallResult = {
  content?: { type?: string; text?: string }[];
};

/**
 * A connected MCP client. The default implementation speaks the SSE transport
 * over a pinned, SSRF-validated connection; tests substitute a fake so the
 * tool-binding logic is exercised without a real server.
 */
export type McpClientLike = {
  listTools: () => Promise<{ tools: McpTool[] }>;
  callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<McpCallResult>;
  close: () => Promise<void>;
};

export type McpClientFactory = (
  server: McpServerConfig,
  deps: {
    trustedHosts: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    signal?: AbortSignal;
  },
) => Promise<McpClientLike>;

export type McpBinding = {
  tools: DynamicStructuredTool[];
  dispose: () => Promise<void>;
};

/**
 * Map a JSON schema to a Zod schema for a tool's arguments. MCP tool schemas
 * frequently omit a top-level `type` (e.g. `{ properties: {...} }`), so the
 * shape is inferred from `properties`/`items` when absent. Only genuinely
 * unrecognized `type` values fall back to `z.any()` (and warn) — an empty or
 * inferable schema maps cleanly without a warning.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  const rawType = typeof schema.type === "string" ? schema.type : undefined;
  const inferred =
    rawType ?? (schema.properties ? "object" : schema.items ? "array" : undefined);

  switch (inferred) {
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
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = schema.items ?? {};
      return z.array(withDescription(jsonSchemaToZod(items), items));
    }
    case "null":
      return z.null();
    default: {
      if (rawType !== undefined) {
        logger.warn(`[mcp] tool schema: unrecognized type '${rawType}' → z.any()`);
      }
      return z.any();
    }
  }
}

function withDescription(field: z.ZodType, schema: JsonSchema): z.ZodType {
  return schema.description ? field.describe(schema.description) : field;
}

/**
 * Default client: opens an SSRF-pinned SSE session to the MCP server. The
 * pinned Agent is kept open for the lifetime of the session (the SSE stream is
 * long-lived) and destroyed on close — it must NOT be closed right after the
 * initial response, which would kill the stream.
 */
async function defaultSseClientFactory(
  server: McpServerConfig,
  deps: {
    trustedHosts: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    signal?: AbortSignal;
  },
): Promise<McpClientLike> {
  const trusted = deps.trustedHosts;
  const parsed = validateStaticUrl(server.url, {
    trustedHosts: trusted,
    httpAllowedHosts: trusted,
    mode: deps.mode,
  });
  const hostname = normalizeHostname(parsed.hostname);
  const pinned = await resolveAndValidateHost(hostname, {
    trustedHosts: trusted,
    lookup: deps.lookup,
  });
  const agent = buildPinnedAgent(hostname, parsed, pinned);
  const mcpFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    validateStaticUrl(url, {
      trustedHosts: trusted,
      httpAllowedHosts: trusted,
      mode: deps.mode,
    });
    return globalThis.fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher: agent,
    } as unknown as RequestInit);
  };
  const connectController = new AbortController();
  const connectSignal = deps.signal
    ? AbortSignal.any([deps.signal, connectController.signal])
    : connectController.signal;
  const transport = new SSEClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers, signal: connectSignal },
    fetch: mcpFetch,
  });
  const client = new Client({ name: "ai-assistant-gateway", version: "0.1.0" });
  // The MCP_CALL_TIMEOUT_MS guard covers the JSON-RPC calls (listTools/
  // callTool) but NOT the SSE handshake — a reachable-but-unresponsive server
  // would otherwise hold the request (and, in the runner, the per-thread
  // mutex) until the client aborts. Race connect against the same timeout and
  // abort the underlying SSE fetch on timeout. The timer/controller is cleared
  // once the handshake resolves so the long-lived SSE stream stays live.
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connectPromise = client.connect(transport);
    const timeout = new Promise<never>((_, reject) => {
      connectTimer = setTimeout(() => {
        connectController.abort();
        reject(new McpError(`MCP connect to '${server.name}' timed out after ${env.MCP_CALL_TIMEOUT_MS}ms`));
      }, env.MCP_CALL_TIMEOUT_MS);
    });
    connectTimer?.unref?.();
    await Promise.race([connectPromise, timeout]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    connectController.abort();
    await agent.destroy().catch(() => {});
    throw new McpError(err instanceof Error ? err.message : String(err));
  }
  return {
    listTools: async () => {
      const r = await client.listTools(undefined, { timeout: env.MCP_CALL_TIMEOUT_MS });
      return {
        tools: (r.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as JsonSchema,
        })),
      };
    },
    callTool: async (params: { name: string; arguments: Record<string, unknown> }) => {
      const r = await client.callTool(params, undefined, { timeout: env.MCP_CALL_TIMEOUT_MS });
      return { content: r.content as McpCallResult["content"] };
    },
    close: () => {
      void agent.destroy().catch(() => {});
      return client.close();
    },
  };
}

export async function bindMcpServers(
  mcpServers: McpServerConfig[],
  opts?: {
    signal?: AbortSignal;
    trustedHosts?: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    clientFactory?: McpClientFactory;
  },
): Promise<McpBinding> {
  const tools: DynamicStructuredTool[] = [];
  const disposers: Array<() => Promise<void>> = [];
  const factory = opts?.clientFactory ?? defaultSseClientFactory;
  for (const server of mcpServers) {
    if (opts?.signal?.aborted) break;
    let bound: McpClientLike | undefined;
    try {
      const client = await factory(server, {
        trustedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
        lookup: opts?.lookup,
        mode: opts?.mode,
        signal: opts?.signal,
      });
      bound = client;
      const listed = await client.listTools();
      for (const tool of listed.tools) {
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
              const result = await client.callTool({ name: tool.name, arguments: args });
              const content = result.content ?? [];
              return content.map((c) => c.text ?? "").join("\n");
            },
          }),
        );
      }
      disposers.push(() => client.close());
    } catch (err) {
      await bound?.close().catch(() => {});
      logger.warn(
        `[mcp] failed to bind tools from server '${server.name}':`,
        err instanceof McpError ? err.message : err,
      );
    }
  }
  return {
    tools,
    dispose: async () => {
      // One failing close must never prevent the remaining servers from being
      // closed (a rejected close would otherwise hang the caller's dispose).
      await Promise.allSettled(disposers.map((d) => d()));
    },
  };
}
