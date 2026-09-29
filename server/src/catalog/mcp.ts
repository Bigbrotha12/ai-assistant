import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../env.ts";
import { pluginIdSchema } from "../plugins/types.ts";
import {
  SsrfValidationError,
  egressTrustOptions,
  validateMcpHeaderName,
} from "../plugins/ssrf.ts";
import { resolvePins } from "../egress/client.ts";
import { resolveEnvReference } from "../credentials/env_reference.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";

export type McpEntry = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  headerRefs?: Record<string, string>;
  pinnedIps?: readonly string[];
};

export type McpCatalogLoadOptions = {
  lookup?: LookupFn;
  trustedHosts?: readonly string[];
  mode?: Mode;
};

const mcpEntrySchema = z.object({
  name: pluginIdSchema,
  url: z.string().url("must be an absolute URL"),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpFileSchema = z.array(mcpEntrySchema);

function resolveHeaderValue(value: string): string {
  const resolution = resolveEnvReference(value);
  if (resolution.ok) return resolution.value;
  if (resolution.reason === "not-a-reference") {
    throw new SsrfValidationError(
      "INVALID_URL",
      `MCP header value must match \${ENV_VAR} pattern, got '${value}'`,
    );
  }
  if (resolution.reason === "undefined") {
    throw new SsrfValidationError(
      "INVALID_URL",
      `MCP header references undefined environment variable '${resolution.variable}'`,
    );
  }
  throw new SsrfValidationError(
    "INVALID_URL",
    `MCP header resolved value for '${resolution.variable}' contains control characters or CRLF`,
  );
}

export async function loadMcpCatalog(
  filePath: string,
  options: McpCatalogLoadOptions = {},
): Promise<McpEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MCP catalog at ${filePath} is not valid JSON`);
  }

  const result = mcpFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid MCP catalog at ${filePath}:\n${details}`);
  }

  const entries: McpEntry[] = result.data;

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate MCP server name '${entry.name}' in ${filePath}`);
    }
    seen.add(entry.name);

    const trustedHosts = options.trustedHosts ?? env.MCP_TRUSTED_HOSTS;
    // M1: the MCP http: carve-out is paired via `egressTrustOptions` and the
    // validation/pinning is the same facade path `openPinned` uses.
    entry.pinnedIps = await resolvePins(entry.url, {
      ...egressTrustOptions(trustedHosts),
      mode: options.mode ?? env.NODE_ENV,
      lookup: options.lookup,
      subject: "mcp-catalog",
    });

    if (entry.headers) {
      const headerRefs: Record<string, string> = {};
      for (const headerName of Object.keys(entry.headers)) {
        validateMcpHeaderName(headerName);
        const reference = entry.headers[headerName]!;
        headerRefs[headerName] = reference;
        entry.headers[headerName] = resolveHeaderValue(reference);
      }
      entry.headerRefs = headerRefs;
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}