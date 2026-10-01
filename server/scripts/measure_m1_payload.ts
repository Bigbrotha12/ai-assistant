/**
 * Phase 1.4 payload-measurement harness (a standalone measurement run, not a
 * test). It binds the live Mealie MCP surface through the gateway's OWN binder
 * (`bindMcpServers`) exactly as the gateway does, then measures the serialized
 * bound-tool payload in two passes:
 *
 *   Pass 1 — full surface (`allowTools` absent): every exposed tool binds.
 *   Pass 2 — the Phase 1.4 allowlist (read-only tools + `create_mealplan`).
 *
 * Payload definition: for each bound tool, the byte length of
 * `JSON.stringify({ name, description, schema })`, where `schema` is
 * `tool.schema.toJSON()` when available and `JSON.stringify(tool.schema)`
 * otherwise (zod v4 declares no `ZodType#toJSON`). Token estimates use the
 * documented ~4 chars/token heuristic.
 *
 * Run from `server/`: `node --import tsx scripts/measure_m1_payload.ts`.
 *
 * Prerequisite: the mealie MCP SSE server must be reachable at
 * `http://127.0.0.1:8001/sse`. Start it from `/home/bigbrotha/Projects/mcp/
 * mealie-mcp` (the vendored image the cluster runs, real Mealie credentials in
 * its `.env`):
 *   podman run -d --rm --network host \
 *     -e MEALIE_BASE_URL -e MEALIE_API_KEY mealie-mcp-sse:local
 * (build the SSE flavor first with:
 *   podman build -f Dockerfile.sse -t mealie-mcp-sse:local .)
 */
import { bindMcpServers, type McpBinding } from "../src/agents/mcp.ts";
import type { AgentToolAllowlistEntry } from "../src/plugins/types.ts";

const SERVER_URL = "http://127.0.0.1:8001/sse";
const SERVER = { name: "mealie", url: SERVER_URL };
/** Admin-vouched MCP hosts, mirroring `env.MCP_TRUSTED_HOSTS`. */
const TRUSTED_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];

const ALLOW_TOOLS: readonly AgentToolAllowlistEntry[] = [
  { name: "get_recipes", readOnly: true },
  { name: "get_recipe_concise", readOnly: true },
  { name: "get_recipe_detailed", readOnly: true },
  { name: "get_all_mealplans", readOnly: true },
  { name: "get_todays_mealplan", readOnly: true },
  { name: "get_tags", readOnly: true },
  { name: "get_categories", readOnly: true },
  { name: "get_foods", readOnly: true },
  { name: "create_mealplan" },
];

/** The subset of `DynamicStructuredTool` this harness reads. */
type BoundToolLike = {
  name: string;
  description?: string;
  schema?: { toJSON?: () => unknown } | null;
};

type SchemaMode = "toJSON" | "JSON.stringify" | "missing";

type PayloadMeasurement = {
  count: number;
  bytes: number;
  tokens: number;
  names: string[];
  schemaModes: SchemaMode[];
};

function schemaValue(tool: BoundToolLike): { value: unknown; mode: SchemaMode } {
  const schema = tool.schema;
  if (schema === undefined || schema === null) {
    return { value: undefined, mode: "missing" };
  }
  if (typeof schema.toJSON === "function") {
    return { value: schema.toJSON(), mode: "toJSON" };
  }
  return { value: JSON.stringify(schema), mode: "JSON.stringify" };
}

function measureBoundPayload(tools: readonly BoundToolLike[]): PayloadMeasurement {
  const encoder = new TextEncoder();
  const schemaModes = new Set<SchemaMode>();
  let bytes = 0;
  for (const tool of tools) {
    const { value, mode } = schemaValue(tool);
    schemaModes.add(mode);
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      schema: value,
    });
    bytes += encoder.encode(serialized).length;
  }
  return {
    count: tools.length,
    bytes,
    tokens: Math.ceil(bytes / 4),
    names: tools.map((tool) => tool.name).sort(),
    schemaModes: [...schemaModes].sort(),
  };
}

function assertBound(
  measurement: PayloadMeasurement,
  names: readonly string[],
  label: string,
): void {
  const bound = new Set(measurement.names);
  const missing = names.filter((name) => !bound.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${label}: expected bound tool(s) missing: ${missing.join(", ")}`,
    );
  }
}

let fullBinding: McpBinding | undefined;
let allowBinding: McpBinding | undefined;

try {
  console.log(`[measure] binding ${SERVER.url} (pass 1: full surface)`);
  fullBinding = await bindMcpServers([SERVER], { trustedHosts: TRUSTED_HOSTS });
  const full = measureBoundPayload(fullBinding.tools as BoundToolLike[]);
  const fullNames = new Set(full.names);

  if (full.count === 0) {
    throw new Error(
      "pass 1 bound 0 tools — the MCP server is unreachable or exposed no tools",
    );
  }

  console.log("");
  console.log("=== Pass 1 — full surface (no allowlist) ===");
  console.log(`tools bound      : ${full.count}`);
  console.log(`payload bytes    : ${full.bytes}`);
  console.log(
    `payload tokens   : ${full.tokens}  (heuristic: Math.ceil(bytes / 4), "~4 chars/token")`,
  );
  console.log(`schema serialized: ${full.schemaModes.join(", ")}`);
  console.log("sorted tool names:");
  for (const name of full.names) console.log(`  - ${name}`);

  console.log("");
  console.log("[measure] binding (pass 2: allowlist applied)");
  allowBinding = await bindMcpServers([SERVER], {
    trustedHosts: TRUSTED_HOSTS,
    allowTools: ALLOW_TOOLS,
  });
  const allow = measureBoundPayload(allowBinding.tools as BoundToolLike[]);
  const allowNames = new Set(ALLOW_TOOLS.map((entry) => entry.name));
  const boundAllow = new Set(allow.names);

  console.log("");
  console.log("=== Pass 2 — allowlist applied ===");
  console.log(`tools bound      : ${allow.count}`);
  console.log(`payload bytes    : ${allow.bytes}`);
  console.log(
    `payload tokens   : ${allow.tokens}  (heuristic: Math.ceil(bytes / 4), "~4 chars/token")`,
  );
  console.log(`bound names      : ${allow.names.join(", ")}`);

  // --- Assertions (fail loudly) -------------------------------------------
  assertBound(allow, ALLOW_TOOLS.map((entry) => entry.name), "pass 2 allowlist");

  if (!allowNames.has("create_mealplan") || !boundAllow.has("create_mealplan")) {
    throw new Error("pass 2: mutating tool 'create_mealplan' is not bound");
  }

  // Every name in the full surface that the allowlist does not list must be
  // absent from the bound set.
  const outOfAllowlist = [...fullNames].filter((name) => !allowNames.has(name)).sort();
  const leaked = outOfAllowlist.filter((name) => boundAllow.has(name));
  if (leaked.length > 0) {
    throw new Error(
      `pass 2 bound out-of-allowlist tool(s): ${leaked.join(", ")}`,
    );
  }
  console.log(
    `assertions       : all ${ALLOW_TOOLS.length} allowlist names bound; ` +
      `create_mealplan bound; ${outOfAllowlist.length} out-of-allowlist name(s) absent`,
  );

  // Explicitly pin the mutating names called out by the plan when the server
  // exposes them. Absence from the bound set is the assertion; presence in the
  // full surface is reported for provenance.
  const explicitlyNamed = ["delete_recipe", "create_recipe", "update_recipe"];
  for (const name of explicitlyNamed) {
    if (boundAllow.has(name)) {
      throw new Error(`pass 2 bound mutating tool '${name}'`);
    }
    if (!fullNames.has(name)) {
      console.log(`note             : '${name}' absent from the full surface`);
    }
  }
  const otherMutatingLeaks = outOfAllowlist.filter((name) =>
    !name.startsWith("get_") && !explicitlyNamed.includes(name),
  );
  console.log(
    `unmatched        : ${outOfAllowlist.length} full-surface name(s) outside the allowlist` +
      (otherMutatingLeaks.length > 0
        ? ` (e.g. ${otherMutatingLeaks.slice(0, 5).join(", ")})`
        : ""),
  );

  // --- Pass 3: reconciliation note (never fails) --------------------------
  console.log("");
  console.log("=== Pass 3 — count reconciliation (informational, not an assertion) ===");
  console.log(`gateway-bound full count : ${full.count} (authoritative)`);
  const matches68 = full.count === 68;
  const matches70 = full.count === 70;
  if (matches68 && matches70) {
    console.log("matches                  : 68 and 70 (ambiguous)");
  } else if (matches68) {
    console.log("matches                  : 68 (OpenCode MCP client enumeration)");
  } else if (matches70) {
    console.log("matches                  : 70 (2026-10-01 cluster determination)");
  } else {
    console.log(
      "matches                  : neither 68 nor 70; gateway count reported as authoritative",
    );
  }

  const jsonLine = {
    fullCount: full.count,
    fullBytes: full.bytes,
    fullTokens: full.tokens,
    allowlistCount: allow.count,
    allowlistBytes: allow.bytes,
    allowlistTokens: allow.tokens,
    boundNames: allow.names,
    unmatchedOutOfAllowlist: outOfAllowlist,
  };
  console.log("");
  console.log(JSON.stringify(jsonLine));
} finally {
  await Promise.allSettled(
    [fullBinding, allowBinding]
      .filter((binding): binding is McpBinding => binding !== undefined)
      .map((binding) => binding.dispose()),
  );
}
