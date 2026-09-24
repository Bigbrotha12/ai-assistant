import { DynamicStructuredTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import {
  createMcpToolListCache,
  type McpToolListCache,
} from "../middleware/cache.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import {
  buildPinnedAgent,
  normalizeHostname,
  resolveAndValidateHost,
  validateStaticUrl,
} from "../plugins/ssrf.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import { redactForOutbound } from "../redact.ts";
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

type McpTransportLike = {
  close: () => Promise<void>;
};

type McpSdkClient = {
  connect: (transport: McpTransportLike) => Promise<void>;
  listTools: (
    params?: unknown,
    options?: { timeout?: number },
  ) => Promise<{ tools: McpTool[] }>;
  callTool: (
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ) => Promise<McpCallResult>;
  close: () => Promise<void>;
};

type McpAgentLike = {
  destroy: () => Promise<void>;
};

export type McpSseFactoryOverrides = {
  createAgent?: (
    hostname: string,
    parsed: URL,
    pinned: readonly string[],
  ) => McpAgentLike;
  createTransport?: (
    url: URL,
    options: {
      requestInit: RequestInit;
      fetch: (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>;
    },
  ) => McpTransportLike;
  createClient?: (transport: McpTransportLike) => McpSdkClient;
  timeoutMs?: number;
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
export async function defaultSseClientFactory(
  server: McpServerConfig,
  deps: {
    trustedHosts: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    signal?: AbortSignal;
  },
  overrides: McpSseFactoryOverrides = {},
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
  const agent = overrides.createAgent?.(hostname, parsed, pinned) ?? buildPinnedAgent(hostname, parsed, pinned);
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
  const transport: McpTransportLike =
    overrides.createTransport?.(new URL(server.url), {
      requestInit: { headers: server.headers, signal: connectSignal },
      fetch: mcpFetch,
    }) ??
    new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers, signal: connectSignal },
      fetch: mcpFetch,
    });
  const client: McpSdkClient =
    overrides.createClient?.(transport) ??
    (new Client({ name: "ai-assistant-gateway", version: "0.1.0" }) as unknown as McpSdkClient);
  let closePromise: Promise<void> | undefined;
  const closeClient = (): Promise<void> => {
    closePromise ??= (async () => {
      connectController.abort();
      try {
        await agent.destroy();
      } catch {
      }
      try {
        await client.close();
      } catch {
      }
    })();
    return closePromise;
  };
  // The MCP_CALL_TIMEOUT_MS guard covers the JSON-RPC calls (listTools/
  // callTool) but NOT the SSE handshake — a reachable-but-unresponsive server
  // would otherwise hold the request (and, in the runner, the per-thread
  // mutex) until the client aborts. Race connect against the same timeout and
  // abort the underlying SSE fetch on timeout. The timer/controller is cleared
  // once the handshake resolves so the long-lived SSE stream stays live.
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectPromise: Promise<void> | undefined;
  try {
    const pendingConnect = client.connect(transport);
    connectPromise = pendingConnect;
    const timeoutMs = overrides.timeoutMs ?? env.MCP_CALL_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      connectTimer = setTimeout(() => {
        connectController.abort();
        reject(new McpError(`MCP connect to '${server.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    connectTimer?.unref?.();
    await Promise.race([pendingConnect, timeout]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    const pendingConnect = connectPromise;
    if (pendingConnect) {
      void pendingConnect
        .then(
          () => closeClient(),
          () => undefined,
        )
        .catch(() => {});
    }
    await closeClient();
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
    close: closeClient,
  };
}

/**
 * Cache key for a server's tool list: the server URL plus a one-way
 * fingerprint of the resolved auth-header set. Raw header values NEVER
 * appear in the key (they may carry secrets) — reuse `credentialFingerprint`
 * (sorted JSON `[key, value]` pairs → versioned SHA-256), the same derivation
 * used for pin and credential-store identities. Absent headers fingerprint as
 * the empty set, so unkeyed servers dedupe too. NUL-joins like `internalKey` in
 * `middleware/cache.ts` (URLs cannot contain `\u0000`).
 */
export function mcpToolListCacheKey(
  server: Pick<McpServerConfig, "url" | "headers">,
): string {
  return `${server.url}\u0000${credentialFingerprint(server.headers ?? {})}`;
}

let toolListCache: McpToolListCache | undefined;

/**
 * Process-wide MCP tool-list cache singleton. Created on first use so
 * `bindMcpServers([])` never constructs it; sweep timer is unref'd.
 */
export function getMcpToolListCache(): McpToolListCache {
  toolListCache ??= createMcpToolListCache();
  return toolListCache;
}

/**
 * Test seam: install a (possibly fake-clock) cache; disposes the previous
 * instance unless it is the same one. `undefined` = reset.
 */
export function setMcpToolListCache(cache: McpToolListCache | undefined): void {
  if (toolListCache === cache) return;
  toolListCache?.dispose();
  toolListCache = cache;
}

/** Test seam: drop the singleton so the next use creates a fresh default. */
export function resetMcpToolListCache(): void {
  setMcpToolListCache(undefined);
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
    // Resolved after the abort check so an empty/aborted bind never
    // constructs the singleton; tests swap it between binds via the seams.
    const cache = getMcpToolListCache();
    // Per-server client state, shared by the eager (cache-miss) and lazy
    // (cache-hit) paths. `clientPromise` memoizes one connect per binding;
    // a failed connect clears it so a later tool call may retry cleanly,
    // while dispose-after-failure stays a no-op.
    let clientPromise: Promise<McpClientLike> | undefined;
    let closePromise: Promise<void> | undefined;
    let disposed = false;
    const closeClient = (): Promise<void> => {
      disposed = true;
      closePromise ??= (async () => {
        const pendingClient = clientPromise;
        if (!pendingClient) return;
        try {
          const client = await pendingClient;
          await client.close();
        } catch {
        }
      })();
      return closePromise;
    };
    const getClient = (): Promise<McpClientLike> => {
      if (disposed) {
        return Promise.reject(
          new McpError(`MCP binding for '${server.name}' already disposed`),
        );
      }
      clientPromise ??= factory(server, {
        trustedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
        lookup: opts?.lookup,
        mode: opts?.mode,
        signal: opts?.signal,
      }).catch((err) => {
        clientPromise = undefined;
        throw err;
      });
      return clientPromise;
    };
    try {
      const key = mcpToolListCacheKey(server);
      let listed = cache.get(key);
      if (listed === undefined) {
        // Miss: connect now — `listTools` requires the handshake anyway —
        // then snapshot the plain-JSON list (staleness ≤ TTL).
        const client = await getClient();
        listed = (await client.listTools()).tools;
        cache.set(key, listed);
      }
      // Hit and miss share one build path from plain `McpTool` entries;
      // bound `DynamicStructuredTool`s are always rebuilt per request and
      // resolve the client lazily on first invocation (a hit therefore opens
      // no connection until a tool is actually called).
      for (const tool of listed) {
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
              const client = await getClient();
              const result = await client.callTool({ name: tool.name, arguments: args });
              const content = result.content ?? [];
              return redactForOutbound(content.map((c) => c.text ?? "").join("\n"));
            },
          }),
        );
      }
      disposers.push(closeClient);
    } catch (err) {
      await closeClient();
      logger.warn(
        `[mcp] failed to bind tools from server '${server.name}':`,
        err instanceof McpError ? err.message : err,
      );
    }
  }
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= Promise.allSettled(
      disposers.map((d) => Promise.resolve().then(d)),
    ).then(() => undefined);
    return disposePromise;
  };
  return { tools, dispose };
}
