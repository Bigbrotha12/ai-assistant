import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPluginAuditSink } from "../../../src/tools/audit.ts";
import type { ToolCallResult, ToolDispatch } from "../../../src/tools/pipeline.ts";
import { logger } from "../../../src/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../../src/audit/telemetry.ts";
import { makeCall } from "../support.ts";

function fakeDispatch(overrides: Parameters<typeof makeCall>[0] = {}): ToolDispatch {
  return { call: makeCall(overrides) } as unknown as ToolDispatch;
}

function fakeResult(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    ok: true,
    content: "x",
    outcome: "ok",
    durationMs: 5,
    inputBytes: 3,
    outputBytes: 7,
    fromCache: false,
    replayed: false,
    ...overrides,
  };
}

/** Emits through the sink and returns the parsed `plugin.tool` audit records. */
async function emitAndCapture(
  dispatch: ToolDispatch,
  result: ToolCallResult,
): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const original = { info: logger.info, debug: logger.debug, warn: logger.warn };
  logger.info = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  logger.debug = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  logger.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  configureAuditTelemetry({ enabled: true, level: "info" });
  try {
    createPluginAuditSink()(dispatch, result);
    await flushAuditTelemetry();
  } finally {
    logger.info = original.info;
    logger.debug = original.debug;
    logger.warn = original.warn;
    resetAuditTelemetryConfig();
    await flushAuditTelemetry();
  }
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter(
      (record): record is Record<string, unknown> =>
        record !== undefined && record.event === "plugin.tool",
    );
}

describe("plugin audit sink", () => {
  test("emits plugin.tool for a plugin-source sync call with the call fields", async () => {
    const records = await emitAndCapture(
      fakeDispatch({
        channel: "sync-stateless",
        pluginId: "vikunja",
        tool: "list_tasks",
        requestId: "req-9",
        owner: "user-1",
      }),
      fakeResult({ inputBytes: 11, outputBytes: 22 }),
    );
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.kind, "plugin");
    assert.equal(record.pluginId, "vikunja");
    assert.equal(record.tool, "list_tasks");
    assert.equal(record.outcome, "ok");
    assert.equal(record.inputBytes, 11);
    assert.equal(record.outputBytes, 22);
    assert.equal(record.requestId, "req-9");
  });

  test("emits for the job channel (non-warmup)", async () => {
    const records = await emitAndCapture(
      fakeDispatch({ channel: "job", tool: "create_task" }),
      fakeResult({ outcome: "timeout", errorCode: "tool_timeout", ok: false }),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.outcome, "timeout");
    assert.equal(records[0]!.errorCode, "tool_timeout");
  });

  test("does not emit for the warmup channel", async () => {
    const records = await emitAndCapture(
      fakeDispatch({ channel: "warmup" }),
      fakeResult(),
    );
    assert.equal(records.length, 0);
  });

  test("does not emit for MCP-sourced calls (audit stays in runMcpOperation)", async () => {
    const records = await emitAndCapture(
      fakeDispatch({ source: "mcp", pluginId: "mcp:demo" }),
      fakeResult(),
    );
    assert.equal(records.length, 0);
  });

  test("omits errorCode when the result carries none", async () => {
    const records = await emitAndCapture(fakeDispatch(), fakeResult());
    assert.equal(records.length, 1);
    assert.equal(Object.hasOwn(records[0]!, "errorCode"), false);
  });
});
