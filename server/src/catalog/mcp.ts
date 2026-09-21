import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../env.ts";
import { pluginIdSchema } from "../plugins/types.ts";
import {
  SsrfValidationError,
  validateMcpHeaderName,
  validateStaticUrl,
  resolveAndValidateHost,
} from "../plugins/ssrf.ts";

export type McpEntry = {
  name: string;
  url: string;
  headers?: Record<string, string>;
};

const envVarRe = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const controlRe = /[\r\n\u0000-\u001f]/;

const mcpEntrySchema = z.object({
  name: pluginIdSchema,
  url: z.string().url("must be an absolute URL"),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpFileSchema = z.array(mcpEntrySchema);

function resolveHeaderValue(value: string): string {
  const match = value.match(envVarRe);
  if (!match) {
    throw new SsrfValidationError(
      "INVALID_URL",
      `MCP header value must match \${ENV_VAR} pattern, got '${value}'`,
    );
  }
  const varName = value.slice(2, -1);
  const resolved = process.env[varName];
  if (resolved === undefined) {
    throw new SsrfValidationError(
      "INVALID_URL",
      `MCP header references undefined environment variable '${varName}'`,
    );
  }
  if (controlRe.test(resolved)) {
    throw new SsrfValidationError(
      "INVALID_URL",
      `MCP header resolved value for '${varName}' contains control characters or CRLF`,
    );
  }
  return resolved;
}

export async function loadMcpCatalog(filePath: string): Promise<McpEntry[]> {
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

  const entries = result.data;

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate MCP server name '${entry.name}' in ${filePath}`);
    }
    seen.add(entry.name);

    const parsedUrl = validateStaticUrl(entry.url, {
      mode: env.NODE_ENV,
      trustedHosts: env.MCP_TRUSTED_HOSTS,
      httpAllowedHosts: env.MCP_TRUSTED_HOSTS,
    });
    await resolveAndValidateHost(parsedUrl.hostname, {
      trustedHosts: env.MCP_TRUSTED_HOSTS,
    });

    if (entry.headers) {
      for (const headerName of Object.keys(entry.headers)) {
        validateMcpHeaderName(headerName);
        entry.headers[headerName] = resolveHeaderValue(entry.headers[headerName]!);
      }
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