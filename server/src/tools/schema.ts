import { z } from "zod";
import { logger } from "../logger.ts";
import type { JsonSchema } from "../plugins/types.ts";

/**
 * `schema.ts` — the single JSON-Schema → Zod translation, in a neutral module.
 *
 * Historically this lived in `agents/mcp.ts`, but `tools/bind.ts` imports it
 * while `agents/mcp.ts` imports `createBoundTool`/`makeToolBodies` from
 * `tools/bind.ts` (finding m2). Moving it here breaks that import cycle: both
 * the plugin-binding path and the MCP binder depend on this module, and neither
 * depends on the other for schema translation. `agents/mcp.ts` and
 * `agents/orchestrator.ts` re-export `jsonSchemaToZod` so existing importers keep
 * working unchanged.
 */

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
