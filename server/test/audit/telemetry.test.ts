import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { logger } from "../../src/logger.ts";
import { bindPluginTools } from "../../src/agents/orchestrator.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";
import {
  bindMcpServers,
  resetMcpRuntimeState,
  resetMcpToolListCache,
  type McpClientFactory,
} from "../../src/agents/mcp.ts";
import {
  AUDIT_TELEMETRY_DROP_POLICY,
  configureAuditTelemetry,
  flushAuditTelemetry,
  getAuditTelemetryDroppedCount,
  emitAuditEvent,
  emitPluginToolAudit,
  emitSentinelShadowAudit,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";

const SECRET = `sk-ant-api03-${"s".repeat(32)}`;

type Captured = {
  info: string[];
  debug: string[];
  warn: string[];
  originalInfo: (...args: unknown[]) => void;
  originalDebug: (...args: unknown[]) => void;
  originalWarn: (...args: unknown[]) => void;
};

let captured: Captured;

function captureLogger(): void {
  const originalInfo = logger.info;
  const originalDebug = logger.debug;
  const originalWarn = logger.warn;
  captured = {
    info: [],
    debug: [],
    warn: [],
    originalInfo,
    originalDebug,
    originalWarn,
  };
  logger.info = (...args) => captured.info.push(args.map(String).join(" "));
  logger.debug = (...args) => captured.debug.push(args.map(String).join(" "));
  logger.warn = (...args) => captured.warn.push(args.map(String).join(" "));
}

function restoreLogger(): void {
  if (!captured) return;
  logger.info = captured.originalInfo;
  logger.debug = captured.originalDebug;
  logger.warn = captured.originalWarn;
}

function records(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("redacted audit telemetry", () => {
  beforeEach(async () => {
    await flushAuditTelemetry();
    resetMcpRuntimeState();
    resetMcpToolListCache();
    resetAuditTelemetryConfig();
    configureAuditTelemetry({ enabled: true, level: "info" });
    captureLogger();
  });

  afterEach(async () => {
    await flushAuditTelemetry();
    restoreLogger();
    resetMcpRuntimeState();
    resetMcpToolListCache();
    resetAuditTelemetryConfig();
  });

  test("redacts secret-shaped fields before emitting a single-line JSON record", async () => {
    emitPluginToolAudit({
      owner: `owner-${SECRET}`,
      pluginId: `plugin-${SECRET}`,
      tool: "lookup",
      outcome: "ok",
      durationMs: 4,
      inputBytes: 10,
      outputBytes: 20,
    });
    await flushAuditTelemetry();
    assert.equal(captured.info.length, 1);
    assert.equal(captured.info[0]!.includes("\n"), false);
    assert.equal(captured.info[0]!.includes(SECRET), false);
    const [record] = records(captured.info);
    assert.equal(record?.outcome, "ok");
    assert.equal(record?.ownerHash !== undefined, true);
    assert.equal(record?.pluginId, "plugin-sk-ant-api03-***");
    assert.equal("args" in (record ?? {}), false);
    assert.equal("result" in (record ?? {}), false);
  });

  test("production plugin tool binding emits one redacted request-scoped record", async () => {
    const plugin: ToolPluginDefinition = {
      id: "audit-plugin",
      version: "1.0.0",
      schemaVersion: 1,
      type: "tool",
      name: "Audit Plugin",
      description: "audit",
      baseUrls: [],
      tools: [{ name: "lookup", description: "lookup", readOnly: true, inputSchema: { type: "object" } }],
    };
    const registry = {
      listInstalledPlugins: () => [plugin],
    } as never;
    const [tool] = bindPluginTools(
      registry,
      { execute: async () => `result ${SECRET}` },
      undefined,
      { owner: "owner-1", requestId: "req-plugin-1" },
    );
    await tool!.func({}, undefined, {} as never);
    await flushAuditTelemetry();
    const pluginRecords = records(captured.info).filter((record) => record.event === "plugin.tool");
    assert.equal(pluginRecords.length, 1);
    assert.equal(pluginRecords[0]?.requestId, "req-plugin-1");
    assert.equal(pluginRecords[0]?.pluginId, "audit-plugin");
    assert.equal(captured.info.some((line) => line.includes(SECRET)), false);
  });

  test("MCP invocation telemetry never includes a secret-bearing result and emits one record per tool call", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "secret", description: "returns" }] }),
      callTool: async () => ({
        content: [
          { type: "text", text: `first ${SECRET}` },
          { type: "text", text: "second" },
        ],
      }),
      close: async () => {},
    });
    const binding = await bindMcpServers(
      [{ name: "audit-server", url: "https://audit.example.com" }],
      { clientFactory: factory, owner: "owner-1" },
    );
    const result = await binding.tools[0]!.func({ input: "not logged" });
    assert.equal(result.includes(SECRET), false);
    await binding.dispose();
    await flushAuditTelemetry();

    const toolRecords = records(captured.info).filter((record) => record.event === "mcp.tool");
    assert.equal(toolRecords.length, 1);
    assert.equal(captured.info.some((line) => line.includes(SECRET)), false);
    assert.equal(typeof toolRecords[0]?.outputBytes, "number");
    assert.equal("content" in (toolRecords[0] ?? {}), false);
  });

  test("shadow telemetry emits one redacted metadata record per report", async () => {
    emitSentinelShadowAudit({
      owner: `owner-${SECRET}`,
      requestId: "turn-1",
      taskId: "task-1",
      direction: "input",
      verdict: "block",
      category: "jailbreak_attempt",
      categories: ["jailbreak_attempt"],
      severity: "high",
      severities: ["high"],
      ruleIds: ["jailbreak_attempt.instruction_override"],
    });
    await flushAuditTelemetry();
    assert.equal(captured.info.length, 1);
    const record = records(captured.info)[0];
    assert.equal(record?.event, "sentinel.shadow");
    assert.equal(record?.direction, "input");
    assert.equal(record?.verdict, "block");
    assert.deepEqual(record?.categories, ["jailbreak_attempt"]);
    assert.equal(captured.info[0]?.includes(SECRET), false);
    assert.equal("text" in (record ?? {}), false);
    assert.equal("content" in (record ?? {}), false);
  });

  test("a telemetry logger failure does not fail a production plugin handler", async () => {
    logger.info = () => {
      throw new Error("logger unavailable");
    };
    const plugin: ToolPluginDefinition = {
      id: "safe-plugin",
      version: "1.0.0",
      schemaVersion: 1,
      type: "tool",
      name: "Safe Plugin",
      description: "safe",
      baseUrls: [],
      tools: [{ name: "lookup", description: "lookup", readOnly: true, inputSchema: { type: "object" } }],
    };
    const [tool] = bindPluginTools(
      { listInstalledPlugins: () => [plugin] } as never,
      { execute: async () => "ok" },
      undefined,
      { requestId: "safe-request" },
    );
    assert.equal(await tool!.func({}, undefined, {} as never), "ok");
    await flushAuditTelemetry();
    assert.equal(captured.warn.length, 1);
  });

  test("a blocked async logger never stalls the tool call", async () => {
    let releaseLogger!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseLogger = resolve; });
    logger.info = ((...args: unknown[]) => {
      captured.info.push(args.map(String).join(" "));
      return blocked;
    }) as typeof logger.info;
    const plugin: ToolPluginDefinition = {
      id: "slow-audit-plugin",
      version: "1.0.0",
      schemaVersion: 1,
      type: "tool",
      name: "Slow Audit Plugin",
      description: "audit",
      baseUrls: [],
      tools: [{ name: "lookup", description: "lookup", readOnly: true, inputSchema: { type: "object" } }],
    };
    const [tool] = bindPluginTools(
      { listInstalledPlugins: () => [plugin] } as never,
      { execute: async () => "ok" },
      undefined,
      { requestId: "slow-audit" },
    );
    const result = await Promise.race([
      Promise.resolve(tool!.func({}, undefined, {} as never)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tool stalled")), 250)),
    ]);
    assert.equal(result, "ok");
    releaseLogger();
    await flushAuditTelemetry();
  });

  test("queue overflow drops newest events with a visible counter", async () => {
    configureAuditTelemetry({ enabled: true, level: "info", maxQueueSize: 2 });
    let releaseLogger!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseLogger = resolve; });
    logger.info = ((...args: unknown[]) => {
      captured.info.push(args.map(String).join(" "));
      return blocked;
    }) as typeof logger.info;
    emitPluginToolAudit({ requestId: "drop-0", outcome: "ok" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    emitPluginToolAudit({ requestId: "drop-1", outcome: "ok" });
    emitPluginToolAudit({ requestId: "drop-2", outcome: "ok" });
    emitPluginToolAudit({ requestId: "drop-3", outcome: "ok" });
    assert.equal(getAuditTelemetryDroppedCount(), 1);
    assert.equal(AUDIT_TELEMETRY_DROP_POLICY, "drop-newest");
    releaseLogger();
    await flushAuditTelemetry();
    assert.deepEqual(
      records(captured.info).map((record) => record.requestId),
      ["drop-0", "drop-1", "drop-2"],
    );
  });

  test("preserves audit ordering within each request id", async () => {
    for (const status of [1, 2, 3]) {
      emitPluginToolAudit({ requestId: "ordered", outcome: "ok", status });
    }
    emitPluginToolAudit({ requestId: "other", outcome: "ok", status: 9 });
    await flushAuditTelemetry();
    assert.deepEqual(
      records(captured.info)
        .filter((record) => record.requestId === "ordered")
        .map((record) => record.status),
      [1, 2, 3],
    );
  });

  test("the disable flag suppresses telemetry without affecting the request path", async () => {
    const previous = process.env.AUDIT_TELEMETRY_ENABLED;
    process.env.AUDIT_TELEMETRY_ENABLED = "false";
    resetAuditTelemetryConfig();
    emitAuditEvent({
      event: "mcp.tool",
      kind: "mcp",
      outcome: "ok",
      server: "disabled",
    });
    assert.equal(captured.info.length, 0);
    if (previous === undefined) delete process.env.AUDIT_TELEMETRY_ENABLED;
    else process.env.AUDIT_TELEMETRY_ENABLED = previous;
  });

  test("telemetry level is configurable", async () => {
    configureAuditTelemetry({ enabled: true, level: "debug" });
    emitAuditEvent({
      event: "mcp.policy",
      kind: "mcp",
      outcome: "policy-denied",
      policyCode: "DISALLOWED_HOST",
    });
    await flushAuditTelemetry();
    assert.equal(captured.info.length, 0);
    assert.equal(captured.debug.length, 1);
    assert.equal(records(captured.debug)[0]?.policyCode, "DISALLOWED_HOST");
  });

  test("telemetry failures are fail-open and logged only once", async () => {
    logger.info = () => {
      throw new Error("logger unavailable");
    };
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    });
    const binding = await bindMcpServers(
      [{ name: "failure-server", url: "https://failure.example.com" }],
      { clientFactory: factory },
    );
    assert.equal(await binding.tools[0]!.func({}), "ok");
    await binding.dispose();
    await flushAuditTelemetry();
    assert.equal(captured.warn.length, 1);
  });
});
