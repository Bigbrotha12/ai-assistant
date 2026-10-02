import type { McpServerConfig } from "../agents/mcp.ts";
import { resolveEnvReference } from "../credentials/env_reference.ts";
import { isMcpHeaderReference } from "../plugins/types.ts";
import type {
  AgentToolAllowlistEntry,
  ResolvedAgentDef,
} from "../plugins/types.ts";
import { validateMcpHeaderName } from "../plugins/ssrf.ts";

import { GoalSetupError } from "./errors.ts";

/**
 * The durable subset of a `ResolvedAgentDef` a goal step consumes. A goal's
 * agent definition is snapshotted at admission so a later template edit cannot
 * change an in-flight goal's behavior.
 *
 * SECURITY: the snapshot deliberately does NOT carry resolved MCP header
 * values. The catalog expands `${VAR}` references into literal secrets in
 * memory (`catalog/mcp.ts`), so persisting the resolved `ResolvedAgentDef`
 * would write provider tokens to SQLite and every backup of it. Serialization
 * mirrors `jobs/runner.ts#serializeJobSpec`: only `headerRefs` are persisted,
 * and `parseAgentSnapshot` re-resolves them from the environment at claim
 * time. A header that is neither a reference nor covered by a `headerRef`
 * makes the snapshot unserializable and the goal fails at admission.
 */
export type GoalAgentSnapshot = {
  id: string;
  systemPrompt?: string;
  modelRef?: string;
  inference?: Record<string, unknown>;
  tools?: { pluginId: string }[];
  toolAllowlist?: AgentToolAllowlistEntry[];
  mcpServers: McpServerConfig[];
};

/**
 * Serialize an agent definition for durable storage. Resolved header values
 * are replaced by their references; a literal (non-reference) header with no
 * matching `headerRef` sets `unresolvedHeaders`, which `parseAgentSnapshot`
 * rejects. Only fields the loop consumes are written.
 */
export function serializeAgentSnapshot(agent: ResolvedAgentDef): string {
  const mcpServers = agent.mcpServers.map((server) => {
    const headerRefs: Record<string, string> = {};
    let unresolvedHeaders = false;
    const names = new Set([
      ...Object.keys(server.headerRefs ?? {}),
      ...Object.keys(server.headers ?? {}),
    ]);
    for (const name of names) {
      const ref = server.headerRefs?.[name];
      const value = server.headers?.[name];
      // Prefer a genuine `${VAR}` reference from EITHER map and NEVER copy a
      // literal: a literal in `headerRefs` (installed agents set it to a copy
      // of `headers`) is a secret and must not reach disk.
      if (ref !== undefined && isMcpHeaderReference(ref)) {
        headerRefs[name] = ref;
      } else if (value !== undefined && isMcpHeaderReference(value)) {
        headerRefs[name] = value;
      } else {
        unresolvedHeaders = true;
      }
    }
    return {
      name: server.name,
      url: server.url,
      ...(Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
      ...(unresolvedHeaders ? { unresolvedHeaders: true } : {}),
    };
  });
  return JSON.stringify({
    id: agent.id,
    ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
    ...(agent.modelRef === undefined ? {} : { modelRef: agent.modelRef }),
    ...(agent.inference === undefined ? {} : { inference: agent.inference }),
    ...(agent.tools === undefined
      ? {}
      : { tools: agent.tools.map((tool) => ({ pluginId: tool.pluginId })) }),
    ...(agent.toolAllowlist === undefined
      ? {}
      : { toolAllowlist: agent.toolAllowlist }),
    mcpServers,
  });
}

/**
 * Deserialize `goal.agent_snapshot`, re-resolving `${VAR}` header references
 * from the environment. Defensive: a missing/malformed snapshot, an
 * unresolvable reference, or a literal header that was never a reference is a
 * `GoalSetupError` (a SETUP failure), never a throw into the claim pass.
 */
export function parseAgentSnapshot(json: string | null): GoalAgentSnapshot {
  if (json === null || json.trim() === "") {
    throw new GoalSetupError(
      "invalid_agent_snapshot: goal has no agent snapshot; it cannot run",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GoalSetupError(
      "invalid_agent_snapshot: goal agent snapshot is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoalSetupError(
      "invalid_agent_snapshot: goal agent snapshot is not an object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const stringField = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string) !== ""
      ? (record[key] as string)
      : undefined;
  const agentId = stringField("id") ?? "";
  const mcpServers: McpServerConfig[] = [];
  if (Array.isArray(record["mcpServers"])) {
    for (const raw of record["mcpServers"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const server = raw as Record<string, unknown>;
      if (typeof server["name"] !== "string" || typeof server["url"] !== "string") {
        continue;
      }
      const name = server["name"];
      if (server["unresolvedHeaders"] === true) {
        throw new GoalSetupError(
          `invalid_agent_snapshot: MCP server '${name}' carries a literal header ` +
            "that is not a header reference; it cannot be stored safely",
        );
      }
      const headers: Record<string, string> = {};
      if (server["headerRefs"] !== undefined) {
        if (
          typeof server["headerRefs"] !== "object" ||
          server["headerRefs"] === null ||
          Array.isArray(server["headerRefs"])
        ) {
          throw new GoalSetupError(
            `invalid_agent_snapshot: MCP server '${name}' headerRefs is malformed`,
          );
        }
        for (const [header, reference] of Object.entries(
          server["headerRefs"] as Record<string, unknown>,
        )) {
          try {
            validateMcpHeaderName(header);
          } catch {
            throw new GoalSetupError(
              `invalid_agent_snapshot: MCP server '${name}' has invalid header '${header}'`,
            );
          }
          if (typeof reference !== "string" || !isMcpHeaderReference(reference)) {
            throw new GoalSetupError(
              `invalid_agent_snapshot: MCP server '${name}' header '${header}' is not a reference`,
            );
          }
          const resolution = resolveEnvReference(reference);
          if (!resolution.ok) {
            throw new GoalSetupError(
              `invalid_agent_snapshot: MCP server '${name}' header '${header}' ` +
                `reference ${reference} is ${resolution.reason}`,
            );
          }
          headers[header] = resolution.value;
        }
      }
      // Legacy/defensive: a literal `headers` object (never written by the
      // serializer) is accepted only when it carries no string secrets — it is
      // ignored unless it supplies a value missing from `headerRefs`.
      if (typeof server["headers"] === "object" && server["headers"] !== null) {
        for (const [header, value] of Object.entries(
          server["headers"] as Record<string, unknown>,
        )) {
          if (headers[header] === undefined && typeof value === "string") {
            headers[header] = value;
          }
        }
      }
      mcpServers.push({
        name,
        url: server["url"],
        // `McpServerConfig.id` is the AGENT plugin id (the `agentId:mcp:name`
        // pin key); stamp the snapshot's so `resolvePins` can find the pins.
        ...(agentId === "" ? {} : { id: agentId }),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  }
  const tools: { pluginId: string }[] = [];
  if (Array.isArray(record["tools"])) {
    for (const raw of record["tools"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const pluginId = (raw as Record<string, unknown>)["pluginId"];
      if (typeof pluginId === "string" && pluginId !== "") tools.push({ pluginId });
    }
  }
  let toolAllowlist: AgentToolAllowlistEntry[] | undefined;
  if (Array.isArray(record["toolAllowlist"])) {
    toolAllowlist = [];
    for (const raw of record["toolAllowlist"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry["name"] !== "string") continue;
      toolAllowlist.push({
        name: entry["name"],
        ...(entry["readOnly"] === true ? { readOnly: true } : {}),
      });
    }
  }
  return {
    id: agentId,
    ...(stringField("systemPrompt") === undefined
      ? {}
      : { systemPrompt: record["systemPrompt"] as string }),
    ...(stringField("modelRef") === undefined
      ? {}
      : { modelRef: record["modelRef"] as string }),
    ...(typeof record["inference"] === "object" && record["inference"] !== null
      ? { inference: record["inference"] as Record<string, unknown> }
      : {}),
    tools,
    ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
    mcpServers,
  };
}
