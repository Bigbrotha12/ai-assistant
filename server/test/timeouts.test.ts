import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { envSchema } from "../src/env.ts";
import { bindMcpServers, McpError, mcpCall } from "../src/agents/mcp.ts";
import type { LookupFn } from "../src/plugins/ssrf.ts";

const REQUIRED = {
  BETTER_AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "http://localhost:17600",
};

function parse(input: Record<string, string> = {}) {
  return envSchema.parse({ ...REQUIRED, ...input });
}

describe("timeout + log-level env defaults", () => {
  test("MODEL_CALL_TIMEOUT_MS / MCP_CALL_TIMEOUT_MS / LOG_LEVEL default values", () => {
    const env = parse();
    assert.equal(env.MODEL_CALL_TIMEOUT_MS, 60_000);
    assert.equal(env.MCP_CALL_TIMEOUT_MS, 15_000);
    assert.equal(env.LOG_LEVEL, "info");
  });

  test("timeout + log-level vars are overridable", () => {
    const env = parse({
      MODEL_CALL_TIMEOUT_MS: "120000",
      MCP_CALL_TIMEOUT_MS: "30000",
      LOG_LEVEL: "debug",
    });
    assert.equal(env.MODEL_CALL_TIMEOUT_MS, 120_000);
    assert.equal(env.MCP_CALL_TIMEOUT_MS, 30_000);
    assert.equal(env.LOG_LEVEL, "debug");
  });

  test("LOG_LEVEL rejects values outside the enum", () => {
    assert.throws(() => parse({ LOG_LEVEL: "verbose" }));
  });

  test("timeout vars reject non-positive values", () => {
    assert.throws(() => parse({ MODEL_CALL_TIMEOUT_MS: "0" }));
    assert.throws(() => parse({ MCP_CALL_TIMEOUT_MS: "-1" }));
  });
});

describe("logger threshold filtering (fresh process)", () => {
  function runLogger(level: string): { output: string; status: number } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", `
        const { logger } = await import('./src/logger.ts');
        logger.error('ERR');
        logger.warn('WARN');
        logger.info('INFO');
        logger.debug('DEBUG');
        process.stdout.write('\\n__DONE__\\n');
      `],
      {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          BETTER_AUTH_SECRET: REQUIRED.BETTER_AUTH_SECRET,
          BETTER_AUTH_URL: REQUIRED.BETTER_AUTH_URL,
          PLUGINS_TRUSTED_HOSTS: "",
          LOG_LEVEL: level,
        },
      },
    );
    return { output: `${result.stdout}${result.stderr}`, status: result.status ?? -1 };
  }

  test("threshold 'error' prints error only (warn/info/debug suppressed)", () => {
    const { output, status } = runLogger("error");
    assert.equal(status, 0);
    assert.match(output, /\[ERROR\] ERR/);
    assert.doesNotMatch(output, /\[WARN\] WARN/);
    assert.doesNotMatch(output, /\[INFO\] INFO/);
    assert.doesNotMatch(output, /\[DEBUG\] DEBUG/);
  });

  test("threshold 'warn' prints error + warn (info/debug suppressed)", () => {
    const { output, status } = runLogger("warn");
    assert.equal(status, 0);
    assert.match(output, /\[ERROR\] ERR/);
    assert.match(output, /\[WARN\] WARN/);
    assert.doesNotMatch(output, /\[INFO\] INFO/);
    assert.doesNotMatch(output, /\[DEBUG\] DEBUG/);
  });

  test("threshold 'info' prints error + warn + info (debug suppressed)", () => {
    const { output, status } = runLogger("info");
    assert.equal(status, 0);
    assert.match(output, /\[ERROR\] ERR/);
    assert.match(output, /\[WARN\] WARN/);
    assert.match(output, /\[INFO\] INFO/);
    assert.doesNotMatch(output, /\[DEBUG\] DEBUG/);
  });

  test("threshold 'debug' prints everything", () => {
    const { output, status } = runLogger("debug");
    assert.equal(status, 0);
    assert.match(output, /\[ERROR\] ERR/);
    assert.match(output, /\[WARN\] WARN/);
    assert.match(output, /\[INFO\] INFO/);
    assert.match(output, /\[DEBUG\] DEBUG/);
  });
});

const fakeLookup: LookupFn = async () => [{ address: "1.2.3.4", family: 4 }];

describe("MCP per-call timeout", () => {
  test("mcpCall with an already-aborted signal fails fast with McpError", async () => {
    const aborted = AbortSignal.abort();
    let combinedWasAborted = false;

    await assert.rejects(
      mcpCall("https://mcp.example.com", "initialize", undefined, {
        fetchFn: (_url, init) => {
          combinedWasAborted = init?.signal?.aborted === true;
          throw new DOMException("aborted", "AbortError");
        },
        lookup: fakeLookup,
        mode: "test",
        signal: aborted,
      }),
      (err: unknown) => {
        assert.ok(err instanceof McpError, "expected an McpError");
        assert.match(err.message, /timed out/);
        return true;
      },
    );

    assert.ok(
      combinedWasAborted,
      "the combined signal must reflect the aborted caller signal",
    );
  });

  test("mcpCall does not wrap non-abort errors as timeouts", async () => {
    await assert.rejects(
      mcpCall("https://mcp.example.com", "initialize", undefined, {
        fetchFn: async () => new Response(null, { status: 500 }),
        lookup: fakeLookup,
        mode: "test",
      }),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.match(err.message, /MCP server returned 500/);
        return true;
      },
    );
  });

  test("bindMcpServers with an already-aborted signal skips the server fast", async () => {
    const aborted = AbortSignal.abort();
    const tools = await bindMcpServers(
      [{ name: "slow-server", url: "https://mcp-slow.example.com" }],
      undefined,
      {
        fetchFn: () => {
          throw new DOMException("aborted", "AbortError");
        },
        lookup: fakeLookup,
        mode: "test",
        signal: aborted,
      },
    );
    assert.equal(tools.length, 0);
  });
});