import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { logger } from "../../src/logger.ts";
import {
  bindMcpServers,
  resetMcpRuntimeState,
  resetMcpToolListCache,
  type McpClientFactory,
} from "../../src/agents/mcp.ts";
import {
  configureAuditTelemetry,
  emitAuditEvent,
  emitPluginToolAudit,
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
  beforeEach(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
    resetAuditTelemetryConfig();
    configureAuditTelemetry({ enabled: true, level: "info" });
    captureLogger();
  });

  afterEach(() => {
    restoreLogger();
    resetMcpRuntimeState();
    resetMcpToolListCache();
    resetAuditTelemetryConfig();
  });

  test("redacts secret-shaped fields before emitting a single-line JSON record", () => {
    emitPluginToolAudit({
      owner: `owner-${SECRET}`,
      pluginId: `plugin-${SECRET}`,
      tool: "lookup",
      outcome: "ok",
      durationMs: 4,
      inputBytes: 10,
      outputBytes: 20,
    });
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

    const toolRecords = records(captured.info).filter((record) => record.event === "mcp.tool");
    assert.equal(toolRecords.length, 1);
    assert.equal(captured.info.some((line) => line.includes(SECRET)), false);
    assert.equal(typeof toolRecords[0]?.outputBytes, "number");
    assert.equal("content" in (toolRecords[0] ?? {}), false);
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

  test("telemetry level is configurable", () => {
    configureAuditTelemetry({ enabled: true, level: "debug" });
    emitAuditEvent({
      event: "mcp.policy",
      kind: "mcp",
      outcome: "policy-denied",
      policyCode: "DISALLOWED_HOST",
    });
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
    assert.equal(captured.warn.length, 1);
  });
});
