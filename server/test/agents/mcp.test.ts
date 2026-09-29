import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  bindMcpServers,
  defaultSseClientFactory,
  getMcpCircuitState,
  getMcpToolListCache,
  McpResourceError,
  DEFAULT_MCP_BOUNDARY_LIMITS,
  jsonSchemaToZod,
  mcpToolListCacheKey,
  McpError,
  resetMcpRuntimeState,
  resetMcpToolListCache,
  setMcpToolListCache,
  type McpServerConfig,
  type McpClientFactory,
  type McpClientLike,
  type McpCallResult,
  type McpTool,
  type McpBoundaryLimits,
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  DEFAULT_MCP_MAX_SESSION_LIFETIME_MS,
  MAX_MCP_RUNTIME_STATES,
  MCP_EVICTION_ERROR_CODES,
  MCP_RESOURCE_LIMIT_CODES,
  mcpServerBookkeepingKey,
  mcpServerRuntimeKey,
} from "../../src/agents/mcp.ts";
import { logger } from "../../src/logger.ts";
import { ToolResourceError } from "../../src/tool_bounds.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";
import {
  createMcpToolListCache,
  DEFAULT_MCP_TOOL_LIST_TTL_MS,
} from "../../src/middleware/cache.ts";

type CallRecord = {
  server: string;
  params: { name: string; arguments: Record<string, unknown> };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type FakeClock = {
  now: () => number;
  advance: (ms: number) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  fireTimeouts: () => void;
  pending: () => number;
};

function makeClock(initial = 1_000_000): FakeClock {
  let now = initial;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setTimeout: ((run: () => void, delay: number) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.set(handle, { at: now + delay, run });
      return handle;
    }) as typeof setTimeout,
    clearTimeout: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout,
    fireTimeouts: () => {
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

function captureMcpTelemetry(): {
  records: Record<string, unknown>[];
  restore: () => void;
} {
  const originalInfo = logger.info;
  const records: Record<string, unknown>[] = [];
  logger.info = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      try {
        records.push(JSON.parse(arg) as Record<string, unknown>);
      } catch {
      }
    }
  };
  configureAuditTelemetry({ enabled: true, level: "info" });
  return {
    records,
    restore: () => {
      logger.info = originalInfo;
      resetAuditTelemetryConfig();
    },
  };
}

/**
 * Build a fake `McpClientFactory` for tests. `serverTools` maps a server name
 * to the tools its `listTools` returns; `failServers` are servers whose
 * connect throws (simulating init failure); `contentFor` controls what
 * `callTool` returns so tool-func behavior can be asserted.
 */
function makeFactory(
  serverTools: Record<string, McpTool[]>,
  callLog: CallRecord[],
  contentFor?: (
    server: McpServerConfig,
    params: { name: string; arguments: Record<string, unknown> },
  ) => { type: string; text: string }[],
  failServers: ReadonlySet<string> = new Set(),
): McpClientFactory {
  return async (server: McpServerConfig) => {
    if (failServers.has(server.name)) {
      throw new McpError(`init failed for ${server.name}`);
    }
    const tools = serverTools[server.name] ?? [];
    return {
      listTools: async () => ({ tools }),
      callTool: async (params) => {
        callLog.push({ server: server.name, params });
        return {
          content:
            contentFor?.(server, params) ??
            [{ type: "text", text: `result:${params.name}` }],
        };
      },
      close: async () => {},
    };
  };
}

describe("mcp", () => {
  // The tool-list cache is a module-level singleton: several tests below
  // reuse `https://mcp.example.com` with different tool lists, so each test
  // must start from a cold cache (and leave no sweep timer behind).
  beforeEach(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
  });
  afterEach(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
  });

  test("McpError sets name and code", () => {
    const err = new McpError("test message", "MY_CODE");
    assert.equal(err.name, "McpError");
    assert.equal(err.message, "test message");
    assert.equal(err.code, "MY_CODE");
  });

  test("McpError defaults code to MCP_ERROR", () => {
    const err = new McpError("fallback");
    assert.equal(err.code, "MCP_ERROR");
  });

  test("bindMcpServers discovers tools and returns DynamicStructuredTool instances", async () => {
    const callLog: CallRecord[] = [];
    const factory = makeFactory(
      {
        "test-server": [
          {
            name: "echo",
            description: "Echoes input back",
            inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          },
          { name: "noop", description: "Does nothing" },
        ],
      },
      callLog,
    );
    const binding = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      { clientFactory: factory },
    );

    assert.equal(binding.tools.length, 2);
    assert.ok(binding.tools[0] instanceof DynamicStructuredTool);
    assert.equal(binding.tools[0]!.name, "echo");
    assert.equal(binding.tools[0]!.description, "Echoes input back");
    assert.equal(binding.tools[1]!.name, "noop");
    await binding.dispose();
  });

  test("bindMcpServers skips tools without a name", async () => {
    const callLog: CallRecord[] = [];
    const factory = makeFactory(
      {
        "test-server": [
          { name: "", description: "empty name" },
          { name: "valid", description: "ok" },
        ],
      },
      callLog,
    );
    const binding = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      { clientFactory: factory },
    );

    assert.equal(binding.tools.length, 1);
    assert.equal(binding.tools[0]!.name, "valid");
    await binding.dispose();
  });

  test("bindMcpServers skips a failing server without crashing", async () => {
    const callLog: CallRecord[] = [];
    const factory = makeFactory(
      {
        "good-server": [{ name: "good-tool", description: "works" }],
      },
      callLog,
      undefined,
      new Set(["failing-server"]),
    );
    const binding = await bindMcpServers(
      [
        { name: "failing-server", url: "https://mcp-fail.example.com" },
        { name: "good-server", url: "https://mcp-good.example.com" },
      ],
      { clientFactory: factory },
    );

    assert.equal(binding.tools.length, 1);
    assert.equal(binding.tools[0]!.name, "good-tool");
    await binding.dispose();
  });

  test("dispose after a failed connect is an idempotent no-op", async () => {
    let factoryCalls = 0;
    const factory: McpClientFactory = async () => {
      factoryCalls++;
      throw new McpError("connect failed");
    };
    const binding = await bindMcpServers(
      [{ name: "failed-server", url: "https://mcp-failed.example.com" }],
      { clientFactory: factory },
    );

    assert.equal(binding.tools.length, 0);
    const firstDispose = binding.dispose();
    const secondDispose = binding.dispose();
    assert.equal(firstDispose, secondDispose);
    await firstDispose;
    await binding.dispose();
    assert.equal(factoryCalls, 1);
  });

  test("a failed lazy connect resets for a later retry and closes once", async () => {
    const config: McpServerConfig = { name: "retry-server", url: "https://mcp-retry.example.com" };
    const seedFactory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const seed = await bindMcpServers([config], { clientFactory: seedFactory });
    await seed.dispose();

    let attempts = 0;
    let closes = 0;
    const retryFactory: McpClientFactory = async () => {
      attempts++;
      if (attempts === 1) throw new McpError("temporary connect failure");
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {
          closes++;
        },
      };
    };
    const binding = await bindMcpServers([config], { clientFactory: retryFactory });
    await assert.rejects(
      Promise.resolve(binding.tools[0]!.func({})),
      /temporary connect failure/,
    );
    assert.equal(await binding.tools[0]!.func({}), "ok");
    await binding.dispose();
    await binding.dispose();
    assert.equal(attempts, 2);
    assert.equal(closes, 1);
  });

  test("bindMcpServers returns no tools for empty input", async () => {
    const binding = await bindMcpServers([]);
    assert.equal(binding.tools.length, 0);
    await binding.dispose();
  });

  test("tools/list rejects item, byte, string, and schema-depth limits with typed errors", async () => {
    const baseFactory = (tools: McpTool[]): McpClientFactory => async () => ({
      listTools: async () => ({ tools }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const cases: Array<{
      name: string;
      tools: McpTool[];
      bounds: Partial<McpBoundaryLimits>;
      code: string;
      unit: string;
    }> = [
      {
        name: "items",
        tools: [{ name: "one" }, { name: "two" }],
        bounds: { maxToolCount: 1 },
        code: "mcp_tool_list_item_limit",
        unit: "items",
      },
      {
        name: "bytes",
        tools: [{ name: "one", description: "a".repeat(100) }],
        bounds: { maxToolListBytes: 32 },
        code: "mcp_tool_list_byte_limit",
        unit: "bytes",
      },
      {
        name: "strings",
        tools: [{ name: "one", description: "too-long" }],
        bounds: { maxToolStringChars: 3 },
        code: "mcp_tool_string_limit",
        unit: "characters",
      },
      {
        name: "schema depth",
        tools: [{
          name: "deep",
          inputSchema: {
            type: "object",
            properties: {
              outer: {
                type: "object",
                properties: { inner: { type: "string" } },
              },
            },
          },
        }],
        bounds: { maxSchemaDepth: 2 },
        code: "mcp_tool_schema_depth_limit",
        unit: "depth",
      },
    ];
    for (const testCase of cases) {
      await assert.rejects(
        bindMcpServers(
          [{ name: `limits-${testCase.name}`, url: `https://${testCase.name}.example.com` }],
          { clientFactory: baseFactory(testCase.tools), bounds: testCase.bounds },
        ),
        (error: unknown) =>
          error instanceof McpResourceError &&
          error.code === testCase.code &&
          error.unit === testCase.unit,
      );
    }
  });

  test("tools/call content is bounded before graph return and telemetry", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "large", description: "large" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "x".repeat(10_000) }] }),
      close: async () => {},
    });
    const binding = await bindMcpServers(
      [{ name: "large-call", url: "https://large-call.example.com" }],
      {
        clientFactory: factory,
        bounds: { ...DEFAULT_MCP_BOUNDARY_LIMITS, maxCallResultChars: 64 },
      },
    );
    const result = await binding.tools[0]!.func({});
    assert.equal(typeof result, "string");
    assert.ok((result as string).length <= 64);
    assert.match(result as string, /\[tool result truncated\]$/);
    await binding.dispose();
  });

  test("mcp tool func calls tools/call and returns text content", async () => {
    const callLog: CallRecord[] = [];
    const factory = makeFactory(
      {
        "test-server": [
          {
            name: "greet",
            description: "Greets someone",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
        ],
      },
      callLog,
      (_server, params) => {
        assert.equal(params.name, "greet");
        assert.deepEqual(params.arguments, { name: "world" });
        return [{ type: "text", text: "Hello, world!" }];
      },
    );
    const binding = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      { clientFactory: factory },
    );

    assert.equal(binding.tools.length, 1);
    const result = await binding.tools[0]!.func({ name: "world" });
    assert.equal(callLog.length, 1);
    assert.equal(callLog[0]!.server, "test-server");
    assert.equal(callLog[0]!.params.name, "greet");
    assert.equal(result, "Hello, world!");
    await binding.dispose();
  });

  test("rejects oversized MCP arguments before connecting or calling the server", async () => {
    let factoryCalls = 0;
    let toolCalls = 0;
    const factory: McpClientFactory = async () => {
      factoryCalls += 1;
      return {
        listTools: async () => ({ tools: [{ name: "large-args", description: "large" }] }),
        callTool: async () => {
          toolCalls += 1;
          return { content: [] };
        },
        close: async () => {},
      };
    };
    const binding = await bindMcpServers(
      [{ name: "large-args-server", url: "https://large-args.example.com" }],
      { clientFactory: factory },
    );
    await assert.rejects(
      Promise.resolve(binding.tools[0]!.func({ value: "x".repeat(1_100_000) })),
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_args_too_large",
    );
    assert.equal(factoryCalls, 1);
    assert.equal(toolCalls, 0);
    await binding.dispose();
  });

  test("mcp tool func redacts secret-bearing text before returning it to the graph", async () => {
    const callLog: CallRecord[] = [];
    const secret = `sk-ant-api03-${"s".repeat(32)}`;
    const factory = makeFactory(
      {
        "test-server": [{ name: "secret", description: "Returns a secret" }],
      },
      callLog,
      () => [{ type: "text", text: `provider=${secret}` }],
    );
    const binding = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      { clientFactory: factory },
    );

    const result = await binding.tools[0]!.func({});
    assert.equal(result, "provider=sk-ant-api03-***");
    assert.ok(!result.includes(secret));
    await binding.dispose();
  });

  test("mcp tool func joins multiple content items", async () => {
    const callLog: CallRecord[] = [];
    const factory = makeFactory(
      {
        "test-server": [{ name: "multi", description: "Returns multiple items" }],
      },
      callLog,
      () => [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    );
    const binding = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      { clientFactory: factory },
    );

    const result = await binding.tools[0]!.func({});
    assert.equal(result, "line1\nline2");
    await binding.dispose();
  });

  test("dispose is idempotent, closes every bound client, and isolates failures", async () => {
    const closed: string[] = [];
    const factory: McpClientFactory = async (server) => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed.push(server.name);
        if (server.name === "a") throw new Error("close failed");
      },
    });
    const binding = await bindMcpServers(
      [
        { name: "a", url: "https://a.example.com" },
        { name: "b", url: "https://b.example.com" },
      ],
      { clientFactory: factory },
    );

    assert.deepEqual(closed, []);
    const firstDispose = binding.dispose();
    const secondDispose = binding.dispose();
    assert.equal(firstDispose, secondDispose);
    await firstDispose;
    assert.deepEqual(closed.sort(), ["a", "b"]);
    await binding.dispose();
    assert.deepEqual(closed.sort(), ["a", "b"]);
  });

  test("dispose force-releases a never-closing client at the bound and emits telemetry", async () => {
    const clock = makeClock();
    const telemetry = captureMcpTelemetry();
    let forceCloseCalls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => ({ content: [] }),
      close: () => new Promise<void>(() => undefined),
      forceClose: () => {
        forceCloseCalls += 1;
      },
    });
    try {
      const binding = await bindMcpServers(
        [{ name: "stuck-close", url: "https://stuck-close.example.com", id: "close-agent" }],
        {
          clientFactory: factory,
          closeTimeoutMs: 100,
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        },
      );
      const first = binding.dispose();
      const second = binding.dispose();
      assert.equal(first, second);
      clock.advance(100);
      clock.fireTimeouts();
      await first;
      await flushAuditTelemetry();
      assert.equal(forceCloseCalls, 1);
      assert.equal(
        telemetry.records.some((record) =>
          record.event === "mcp.connect" &&
          record.errorCode === MCP_RESOURCE_LIMIT_CODES.close &&
          record.status === "force_released"),
        true,
      );
      await binding.dispose();
      assert.equal(forceCloseCalls, 1);
    } finally {
      await flushAuditTelemetry();
      telemetry.restore();
    }
  });

  test("a closing connection keeps its slot until the client settles", async () => {
    const closeGate = deferred<void>();
    let connects = 0;
    const factory: McpClientFactory = async () => {
      connects += 1;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: () => closeGate.promise,
      };
    };
    const limits = {
      maxConnectionsPerServer: 1,
      maxConnectionsPerOwner: 1,
      maxInFlightCallsPerServer: 4,
      maxInFlightCallsPerOwner: 4,
    };
    const first = await bindMcpServers(
      [{ name: "slow-close", url: "https://slow-close.example.com" }],
      { clientFactory: factory, limits },
    );
    const closing = first.dispose();
    const second = await bindMcpServers(
      [{ name: "slow-close", url: "https://slow-close.example.com" }],
      { clientFactory: factory, limits },
    );
    await assert.rejects(
      Promise.resolve(second.tools[0]!.func({})),
      (error: unknown) =>
        error instanceof McpError && error.code === "MCP_CONCURRENCY_LIMIT",
    );
    assert.equal(connects, 1);
    closeGate.resolve();
    await closing;
    assert.equal(await second.tools[0]!.func({}), "ok");
    assert.equal(connects, 2);
    await second.dispose();
  });
  test("jsonSchemaToZod infers object when type is omitted but properties present", () => {
    const schema = jsonSchemaToZod({
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    assert.ok(schema.safeParse({ a: "x" }).success);
    assert.ok(!schema.safeParse({ b: 1 }).success, "required 'a' must be present");
    assert.ok(!schema.safeParse({ a: 1 }).success, "'a' must be a string");
  });

  test("jsonSchemaToZod infers array when type is omitted but items present", () => {
    const schema = jsonSchemaToZod({ items: { type: "string" } });
    assert.ok(schema.safeParse(["a", "b"]).success);
    assert.ok(!schema.safeParse("a").success);
    assert.ok(!schema.safeParse(["a", 1]).success);
  });

  test("jsonSchemaToZod maps an empty schema to z.any()", () => {
    const schema = jsonSchemaToZod({});
    assert.ok(schema.safeParse({ anything: 1 }).success);
    assert.ok(schema.safeParse("str").success);
  });

  test("jsonSchemaToZod maps integer and null types", () => {
    assert.ok(jsonSchemaToZod({ type: "integer" }).safeParse(5).success);
    assert.ok(!jsonSchemaToZod({ type: "integer" }).safeParse(5.5).success);
    assert.ok(jsonSchemaToZod({ type: "null" }).safeParse(null).success);
    assert.ok(!jsonSchemaToZod({ type: "null" }).safeParse(0).success);
  });

  test("jsonSchemaToZod falls back to z.any() for unrecognized types", () => {
    const schema = jsonSchemaToZod({ type: "custom" });
    assert.ok(schema.safeParse({ anything: 1 }).success);
  });

  test("connect timeout closes the client, transport, and agent once without masking the timeout", async () => {
    const connect = deferred<void>();
    let agentDestroyCalls = 0;
    let clientCloseCalls = 0;
    let transportCloseCalls = 0;
    const transport = {
      close: async () => {
        transportCloseCalls++;
      },
    };
    const client = {
      connect: () => connect.promise,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        clientCloseCalls++;
        await transport.close();
        throw new Error("close failed");
      },
    };

    const bindingPromise = defaultSseClientFactory(
      { name: "slow-server", url: "https://mcp.example.com" },
      {
        trustedHosts: [],
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      {
        timeoutMs: 1,
        createAgent: () => ({
          destroy: async () => {
            agentDestroyCalls++;
            throw new Error("destroy failed");
          },
        }),
        createTransport: () => transport,
        createClient: () => client,
      },
    );

    const rejection = assert.rejects(bindingPromise, /timed out after 1ms/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await rejection;
    assert.equal(agentDestroyCalls, 1);
    assert.equal(clientCloseCalls, 1);
    assert.equal(transportCloseCalls, 1);

    connect.resolve(undefined);
    await nextTurn();
    assert.equal(agentDestroyCalls, 1);
    assert.equal(clientCloseCalls, 1);
    assert.equal(transportCloseCalls, 1);
  });

  test("late connect rejection is observed and cleanup remains once-only", async () => {
    const connect = deferred<void>();
    let clientCloseCalls = 0;
    let transportCloseCalls = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const transport = {
        close: async () => {
          transportCloseCalls++;
        },
      };
      const bindingPromise = defaultSseClientFactory(
        { name: "slow-server", url: "https://mcp.example.com" },
        {
          trustedHosts: [],
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        },
        {
          timeoutMs: 1,
          createAgent: () => ({ destroy: async () => {} }),
          createTransport: () => transport,
          createClient: () => ({
            connect: () => connect.promise,
            listTools: async () => ({ tools: [] }),
            callTool: async () => ({ content: [] }),
            close: async () => {
              clientCloseCalls++;
              await transport.close();
            },
          }),
        },
      );

      const rejection = assert.rejects(bindingPromise, /timed out after 1ms/);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await rejection;
      connect.reject(new Error("late connect failure"));
      await nextTurn();
      await nextTurn();
      assert.deepEqual(unhandled, []);
      assert.equal(clientCloseCalls, 1);
      assert.equal(transportCloseCalls, 1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // --- tool-list cache (open-gaps P1) -----------------------------------

  test("mcpToolListCacheKey never contains raw header values and separates url/header sets", () => {
    const secret = "Bearer super-secret-token-abc";
    const key1 = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { authorization: secret },
    });
    assert.ok(!key1.includes(secret), "raw header value must not appear in the key");
    assert.ok(!key1.includes("super-secret-token"), "even a fragment of the value");
    assert.ok(key1.startsWith("https://mcp.example.com\u0000"), "URL + NUL prefix");
    const fingerprint = key1.split("\u0000")[1];
    assert.match(fingerprint ?? "", /^[0-9a-f]{64}$/, "fingerprint is sha256 hex");

    // Header order is irrelevant (fingerprint sorts keys).
    const key2 = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { "x-api-key": "k1", authorization: secret },
    });
    const key3 = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { authorization: secret, "x-api-key": "k1" },
    });
    assert.equal(key2, key3, "header insertion order does not affect the key");

    const collisionKeyA = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { x: "a|y=b", y: "c" },
    });
    const collisionKeyB = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { x: "a", y: "b|y=c" },
    });
    assert.notEqual(collisionKeyA, collisionKeyB, "delimiter-bearing header sets stay distinct");

    // Different URL, different header value, absent vs empty headers → distinct keys.
    const keyOtherUrl = mcpToolListCacheKey({
      url: "https://other.example.com",
      headers: { authorization: secret },
    });
    const keyOtherVal = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: { authorization: "Bearer different" },
    });
    const keyNoHeaders = mcpToolListCacheKey({ url: "https://mcp.example.com" });
    const keyEmptyHeaders = mcpToolListCacheKey({
      url: "https://mcp.example.com",
      headers: {},
    });
    assert.notEqual(key1, keyOtherUrl, "different URL → different key");
    assert.notEqual(key1, keyOtherVal, "different header value → different key");
    assert.equal(
      keyNoHeaders,
      keyEmptyHeaders,
      "absent headers fingerprint as the empty set",
    );
    assert.notEqual(key1, keyNoHeaders, "keyed vs unkeyed → different key");
  });

  test("cache hit within TTL skips listTools and the handshake (lazy connect on first tool call)", async () => {
    let factoryCalls = 0;
    let listCalls = 0;
    const callLog: CallRecord[] = [];
    const factory: McpClientFactory = async () => {
      factoryCalls++;
      return {
        listTools: async () => {
          listCalls++;
          return {
            tools: [
              {
                name: "echo",
                description: "Echoes input back",
                inputSchema: { type: "object", properties: { message: { type: "string" } } },
              },
            ],
          };
        },
        callTool: async (params) => {
          callLog.push({ server: "test-server", params });
          return { content: [{ type: "text", text: `result:${params.name}` }] };
        },
        close: async () => {},
      };
    };

    const cfg: McpServerConfig = { name: "test-server", url: "https://mcp.example.com" };
    const b1 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(factoryCalls, 1, "miss connects eagerly");
    assert.equal(listCalls, 1, "miss calls listTools once");
    assert.equal(b1.tools.length, 1);
    await b1.dispose();

    // Second bind, same server, cold client factory: pure cache hit.
    const b2 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 1, "cache hit skips tools/list");
    assert.equal(factoryCalls, 1, "cache hit skips the handshake entirely (lazy)");
    assert.equal(b2.tools.length, 1, "tools are rebuilt from the cached list");
    assert.ok(b2.tools[0] instanceof DynamicStructuredTool);
    assert.equal(b2.tools[0]!.name, "echo");

    // First invocation opens the connection.
    const out = await b2.tools[0]!.func({ message: "hi" });
    assert.equal(factoryCalls, 2, "handshake deferred to the first tool call");
    assert.equal(callLog.length, 1);
    assert.equal(out, "result:echo");

    // A later invocation on the same binding reuses the connection.
    await b2.tools[0]!.func({ message: "again" });
    assert.equal(factoryCalls, 2, "one connection per binding, reused");
    assert.equal(callLog.length, 2);
    await b2.dispose();
  });

  test("separate cache entries for different URL or header sets; same URL+headers hits", async () => {
    let listCalls = 0;
    const factory: McpClientFactory = async () => {
      return {
        listTools: async () => {
          listCalls++;
          return { tools: [{ name: `tool-${listCalls}`, description: "t" }] };
        },
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    };
    const base = { name: "srv", url: "https://mcp.example.com" };

    const b1 = await bindMcpServers(
      [{ ...base, headers: { authorization: "A" } }],
      { clientFactory: factory },
    );
    assert.equal(listCalls, 1);
    await b1.dispose();

    // Same URL + same headers → hit.
    const b2 = await bindMcpServers(
      [{ ...base, headers: { authorization: "A" } }],
      { clientFactory: factory },
    );
    assert.equal(listCalls, 1, "same URL+headers → cache hit");
    assert.equal(b2.tools[0]!.name, "tool-1", "hit serves the earlier list");
    await b2.dispose();

    // Same URL, different auth header → different credential fingerprint → miss.
    const b3 = await bindMcpServers(
      [{ ...base, headers: { authorization: "B" } }],
      { clientFactory: factory },
    );
    assert.equal(listCalls, 2, "different headers → separate entry");
    assert.equal(b3.tools[0]!.name, "tool-2");
    await b3.dispose();

    // Different URL, same headers → miss.
    const b4 = await bindMcpServers(
      [{ name: "srv", url: "https://other.example.com", headers: { authorization: "A" } }],
      { clientFactory: factory },
    );
    assert.equal(listCalls, 3, "different URL → separate entry");
    await b4.dispose();
  });

  test("TTL expiry: a stale entry misses after ttlMs even if never read", async () => {
    let fakeNow = 1_000_000;
    setMcpToolListCache(createMcpToolListCache({ now: () => fakeNow }));
    let listCalls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => {
        listCalls++;
        return { tools: [{ name: "tool", description: "t" }] };
      },
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "srv", url: "https://mcp.example.com" };

    const b1 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 1);
    await b1.dispose();

    // Within TTL → hit.
    fakeNow += Math.floor(DEFAULT_MCP_TOOL_LIST_TTL_MS / 2);
    const b2 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 1, "still fresh within TTL");
    await b2.dispose();

    // Past TTL → miss (insertion-based expiry, not read-refreshed).
    fakeNow += DEFAULT_MCP_TOOL_LIST_TTL_MS + 1;
    const b3 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 2, "expired entry forces a fresh listTools");
    await b3.dispose();
  });

  test("cached value is a plain-JSON snapshot, never a DynamicStructuredTool, and rebuilt per bind", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({
        tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
      }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "srv", url: "https://mcp.example.com" };

    const b1 = await bindMcpServers([cfg], { clientFactory: factory });
    await b1.dispose();

    const cached = getMcpToolListCache().get(mcpToolListCacheKey(cfg));
    assert.ok(cached, "entry stored after a miss");
    assert.deepEqual(cached, [
      { name: "echo", description: "d", inputSchema: { type: "object" } },
    ]);
    for (const t of cached) {
      assert.ok(!(t instanceof DynamicStructuredTool), "cache stores JSON, not bound tools");
    }

    const b2 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.notEqual(
      b1.tools[0],
      b2.tools[0],
      "bound DynamicStructuredTool instances are rebuilt per bind",
    );
    assert.equal(b2.tools[0]!.name, "echo");
    await b2.dispose();
  });

  test("setMcpToolListCache/resetMcpToolListCache are the test seams", async () => {
    let listCalls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => {
        listCalls++;
        return { tools: [{ name: "tool", description: "t" }] };
      },
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "srv", url: "https://mcp.example.com" };

    // Install a custom cache — bind uses it without any opts.
    const custom = createMcpToolListCache();
    setMcpToolListCache(custom);
    const b1 = await bindMcpServers([cfg], { clientFactory: factory });
    await b1.dispose();
    assert.equal(listCalls, 1);
    assert.equal(custom.size, 1, "bind wrote into the installed instance");

    const b2 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 1, "installed instance served the hit");
    await b2.dispose();

    // Reset drops the singleton (disposing its sweep timer); the old
    // instance's entries are untouched — the caller owned it.
    resetMcpToolListCache();
    assert.equal(custom.size, 1, "reset leaves the old instance's entries alone");
    const b3 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(listCalls, 2, "after reset the next bind is a cold miss");
    await b3.dispose();
  });

  test("dispose after a cache hit with no tool invocation never connects or closes", async () => {
    let factoryCalls = 0;
    let closes = 0;
    const factory: McpClientFactory = async () => {
      factoryCalls++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closes++;
        },
      };
    };
    const cfg: McpServerConfig = { name: "srv", url: "https://mcp.example.com" };

    const b1 = await bindMcpServers([cfg], { clientFactory: factory });
    await b1.dispose();
    assert.equal(factoryCalls, 1);
    assert.equal(closes, 1, "eager miss connection is closed on dispose");

    const b2 = await bindMcpServers([cfg], { clientFactory: factory });
    assert.equal(factoryCalls, 1, "hit is fully lazy");
    const firstDispose = b2.dispose();
    const secondDispose = b2.dispose();
    assert.equal(firstDispose, secondDispose);
    await firstDispose;
    await b2.dispose();
    assert.equal(factoryCalls, 1, "dispose without invocation opens nothing");
    assert.equal(closes, 1, "nothing to close → close not called");
  });

  test("MCP connection cap rejects excess per-owner connections without opening another client", async () => {
    let connects = 0;
    let closes = 0;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closes++;
        },
      };
    };
    const cfg: McpServerConfig = { name: "capped", url: "https://capped.example.com" };
    const limits = {
      maxConnectionsPerServer: 4,
      maxConnectionsPerOwner: 1,
      maxInFlightCallsPerServer: 4,
      maxInFlightCallsPerOwner: 4,
    };
    const first = await bindMcpServers([cfg], {
      clientFactory: factory,
      owner: "owner-a",
      limits,
    });
    const second = await bindMcpServers([cfg], {
      clientFactory: factory,
      owner: "owner-a",
      limits,
    });
    await assert.rejects(
      Promise.resolve(second.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CONCURRENCY_LIMIT",
    );
    assert.equal(connects, 1, "the owner cap rejects before factory/connect");
    await first.dispose();
    await second.dispose();
    assert.equal(closes, 1, "the one admitted client closes exactly once");
  });

  test("MCP server-wide connection cap rejects excess sessions across owners", async () => {
    let connects = 0;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    };
    const cfg: McpServerConfig = { name: "server-cap", url: "https://server-cap.example.com" };
    const limits = {
      maxConnectionsPerServer: 2,
      maxConnectionsPerOwner: 2,
      maxInFlightCallsPerServer: 4,
      maxInFlightCallsPerOwner: 4,
    };
    const first = await bindMcpServers([cfg], { clientFactory: factory, owner: "a", limits });
    const second = await bindMcpServers([cfg], { clientFactory: factory, owner: "b", limits });
    const third = await bindMcpServers([cfg], { clientFactory: factory, owner: "c", limits });
    assert.equal(await second.tools[0]!.func({}), "");
    await assert.rejects(
      Promise.resolve(third.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CONCURRENCY_LIMIT",
    );
    assert.equal(connects, 2, "the third server session is rejected before connect");
    await first.dispose();
    await second.dispose();
    await third.dispose();
  });

  test("runtime cap rejects when every state is active and none is evictable", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    });
    const bindings = [];
    for (let index = 0; index < MAX_MCP_RUNTIME_STATES; index += 1) {
      bindings.push(await bindMcpServers(
        [{ name: `runtime-${index}`, url: `https://runtime-${index}.example.com` }],
        {
          clientFactory: factory,
          limits: {
            maxConnectionsPerServer: 1,
            maxConnectionsPerOwner: 1,
            maxInFlightCallsPerServer: 4,
            maxInFlightCallsPerOwner: 4,
          },
        },
      ));
    }
    await assert.rejects(
      bindMcpServers(
        [{ name: "runtime-overflow", url: "https://runtime-overflow.example.com" }],
        { clientFactory: factory },
      ),
      (error: unknown) =>
        error instanceof McpError && error.code === MCP_RESOURCE_LIMIT_CODES.runtime,
    );
    await Promise.all(bindings.map((binding) => binding.dispose()));
  });

  test("MCP runtime identity uses normalized origin while path and configured id remain bookkeeping-only", () => {
    const first: McpServerConfig = {
      name: "path-a",
      id: "server-a",
      url: "https://Identity.Example.com:443/one",
    };
    const second: McpServerConfig = {
      name: "path-b",
      id: "server-b",
      url: "https://identity.example.com/two",
    };
    assert.equal(mcpServerRuntimeKey(first), "https://identity.example.com");
    assert.equal(mcpServerRuntimeKey(second), mcpServerRuntimeKey(first));
    assert.notEqual(mcpServerBookkeepingKey(first), mcpServerBookkeepingKey(second));
  });

  test("path variants share the server connection cap and reject the second path before connect", async () => {
    let connects = 0;
    let closes = 0;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closes++;
        },
      };
    };
    const limits = {
      maxConnectionsPerServer: 1,
      maxConnectionsPerOwner: 1,
      maxInFlightCallsPerServer: 4,
      maxInFlightCallsPerOwner: 4,
    };
    const first = await bindMcpServers(
      [{ name: "path-a", url: "https://identity-cap.example.com/a" }],
      { clientFactory: factory, limits },
    );
    const second = await bindMcpServers(
      [{ name: "path-b", url: "https://identity-cap.example.com/b" }],
      { clientFactory: factory, limits },
    );
    assert.equal(first.tools.length, 1);
    assert.equal(second.tools.length, 0);
    assert.equal(connects, 1, "the second path shares the origin connection ledger");
    await first.dispose();
    await second.dispose();
    assert.equal(closes, 1);
  });

  test("path variants share the in-flight cap", async () => {
    const pending = deferred<McpCallResult>();
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => pending.promise,
      close: async () => {},
    });
    const limits = {
      maxConnectionsPerServer: 2,
      maxConnectionsPerOwner: 2,
      maxInFlightCallsPerServer: 1,
      maxInFlightCallsPerOwner: 1,
    };
    const first = await bindMcpServers(
      [{ name: "path-a", url: "https://identity-inflight.example.com/a" }],
      { clientFactory: factory, limits },
    );
    const second = await bindMcpServers(
      [{ name: "path-b", url: "https://identity-inflight.example.com/b" }],
      { clientFactory: factory, limits },
    );
    const firstCall = first.tools[0]!.func({});
    await nextTurn();
    await assert.rejects(
      Promise.resolve(second.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CONCURRENCY_LIMIT",
    );
    pending.resolve({ content: [] });
    assert.equal(await firstCall, "");
    await first.dispose();
    await second.dispose();
  });

  test("a failure on one path opens the shared-origin circuit for another path, while another origin stays independent", async () => {
    let fail = true;
    const factory: McpClientFactory = async (server) => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => {
        if (fail) throw new Error("server unavailable");
        return { content: [{ type: "text", text: server.name }] };
      },
      close: async () => {},
    });
    const limits = {
      circuitFailureThreshold: 2,
      circuitFailureWindowMs: 100,
      circuitCooldownMs: 100,
    };
    const firstCfg: McpServerConfig = { name: "path-a", url: "https://identity-circuit.example.com/a" };
    const secondCfg: McpServerConfig = { name: "path-b", url: "https://identity-circuit.example.com/b" };
    const otherCfg: McpServerConfig = { name: "other", url: "https://other-circuit.example.com/a" };
    const first = await bindMcpServers([firstCfg], { clientFactory: factory, limits });
    const second = await bindMcpServers([secondCfg], { clientFactory: factory, limits });
    const other = await bindMcpServers([otherCfg], { clientFactory: factory, limits });
    await assert.rejects(Promise.resolve(first.tools[0]!.func({})), /server unavailable/);
    await assert.rejects(Promise.resolve(first.tools[0]!.func({})), /server unavailable/);
    assert.equal(getMcpCircuitState(secondCfg).state, "open");
    await assert.rejects(
      Promise.resolve(second.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CIRCUIT_OPEN",
    );
    assert.equal(getMcpCircuitState(otherCfg).state, "closed");
    fail = false;
    assert.equal(await other.tools[0]!.func({}), "other");
    await first.dispose();
    await second.dispose();
    await other.dispose();
  });

  test("MCP in-flight cap rejects a concurrent call and releases the slot after completion", async () => {
    const pending = deferred<McpCallResult>();
    let calls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
      callTool: async () => {
        calls++;
        return pending.promise;
      },
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "inflight", url: "https://inflight.example.com" };
    const limits = {
      maxConnectionsPerServer: 2,
      maxConnectionsPerOwner: 2,
      maxInFlightCallsPerServer: 1,
      maxInFlightCallsPerOwner: 1,
    };
    const first = await bindMcpServers([cfg], { clientFactory: factory, limits });
    const second = await bindMcpServers([cfg], { clientFactory: factory, limits });
    const firstCall = first.tools[0]!.func({});
    await nextTurn();
    await assert.rejects(
      Promise.resolve(second.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CONCURRENCY_LIMIT",
    );
    assert.equal(calls, 1);
    pending.resolve({ content: [{ type: "text", text: "done" }] });
    assert.equal(await firstCall, "done");
    await first.dispose();
    await second.dispose();
  });

  test("circuit-open transitions emit owner-safe MCP audit records", async () => {
    const telemetry = captureMcpTelemetry();
    const cfg: McpServerConfig = { name: "audit-circuit", url: "https://audit-circuit.example.com" };
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => { throw new Error("down"); },
      close: async () => {},
    });
    try {
      const binding = await bindMcpServers([cfg], {
        clientFactory: factory,
        owner: "owner-audit",
        requestId: "mcp-req-1",
        limits: { circuitFailureThreshold: 1 },
      });
      await assert.rejects(Promise.resolve(binding.tools[0]!.func({})), /down/);
      await flushAuditTelemetry();
      assert.equal(
        telemetry.records.some((record) =>
          record.event === "mcp.connect" &&
          record.status === "open" &&
          record.requestId === "mcp-req-1",
        ),
        true,
      );
      await binding.dispose();
    } finally {
      telemetry.restore();
    }
  });

  test("MCP circuit opens after consecutive failures, short-circuits, half-opens, and closes on probe success", async () => {
    let now = 1_000;
    let connects = 0;
    let calls = 0;
    let closes = 0;
    let fail = true;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
        callTool: async () => {
          calls++;
          if (fail) throw new Error("server unavailable");
          return { content: [{ type: "text", text: "recovered" }] };
        },
        close: async () => {
          closes++;
        },
      };
    };
    const cfg: McpServerConfig = { name: "circuit", url: "https://circuit.example.com" };
    const limits = {
      circuitFailureThreshold: 2,
      circuitFailureWindowMs: 100,
      circuitCooldownMs: 10,
      now: () => now,
    };
    const binding = await bindMcpServers([cfg], { clientFactory: factory, limits });
    await assert.rejects(Promise.resolve(binding.tools[0]!.func({})), /server unavailable/);
    await assert.rejects(Promise.resolve(binding.tools[0]!.func({})), /server unavailable/);
    assert.equal(getMcpCircuitState(cfg).state, "open");
    const callsBeforeShortCircuit = calls;
    await assert.rejects(
      Promise.resolve(binding.tools[0]!.func({})),
      (err: unknown) => err instanceof McpError && err.code === "MCP_CIRCUIT_OPEN",
    );
    assert.equal(calls, callsBeforeShortCircuit, "open circuit does not invoke the server");

    now += limits.circuitCooldownMs;
    fail = false;
    assert.equal(await binding.tools[0]!.func({}), "recovered");
    assert.equal(getMcpCircuitState(cfg).state, "closed");
    assert.equal(connects, 3, "half-open probe creates one fresh connection");
    await binding.dispose();
    await binding.dispose();
    assert.equal(closes, 3, "circuit-open and binding disposal close each client once");
  });

  test("MCP timeouts are counted failures and open the circuit (finding M1)", async () => {
    const telemetry = captureMcpTelemetry();
    // A hung server: `callTool` never settles, so the pipeline's `execution`
    // bound (which shares `timeoutMs` with MCP's own `withMcpTimeout` and
    // schedules its timer first) fires. The `AbortError` it produces must be
    // attributed as MCP_TIMEOUT so `completeMcpOperation` records a countable
    // failure — before the fix it classified as `cancelled`/`MCP_ABORTED` and
    // the circuit never opened.
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
      callTool: async () => new Promise<McpCallResult>(() => {}),
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "timeout-circuit", url: "https://timeout-circuit.example.com" };
    // Threshold 2 so two timeouts open the circuit; cooldown raised so the
    // circuit stays open for the assertion.
    const binding = await bindMcpServers([cfg], {
      clientFactory: factory,
      timeoutMs: 5,
      limits: { circuitFailureThreshold: 2, circuitCooldownMs: 30_000 },
    });
    try {
      await assert.rejects(
        Promise.resolve(binding.tools[0]!.func({})),
        (err: unknown) => err instanceof ToolResourceError && err.code === "tool_timeout",
      );
      await assert.rejects(
        Promise.resolve(binding.tools[0]!.func({})),
        (err: unknown) => err instanceof ToolResourceError && err.code === "tool_timeout",
      );
      assert.equal(
        getMcpCircuitState(cfg).state,
        "open",
        "a timeout is a countable failure, so repeated timeouts open the circuit",
      );
      await flushAuditTelemetry();
      const toolAudits = telemetry.records.filter((record) => record.event === "mcp.tool");
      assert.ok(
        toolAudits.some((record) => record.outcome === "timeout" && record.errorCode === "MCP_TIMEOUT"),
        "the mcp.tool audit records a countable timeout, not a cancellation",
      );
      assert.equal(
        toolAudits.some((record) => record.outcome === "cancelled"),
        false,
        "no timeout is misclassified as cancelled",
      );
    } finally {
      telemetry.restore();
      resetMcpRuntimeState();
    }
  });

  test("MCP failure window resets consecutive failures before the threshold", async () => {
    let now = 0;
    let fail = true;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
      callTool: async () => {
        if (fail) throw new Error("temporary");
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "window", url: "https://window.example.com" };
    const limits = {
      circuitFailureThreshold: 2,
      circuitFailureWindowMs: 10,
      circuitCooldownMs: 10,
      now: () => now,
    };
    const binding = await bindMcpServers([cfg], { clientFactory: factory, limits });
    await assert.rejects(Promise.resolve(binding.tools[0]!.func({})), /temporary/);
    now = 11;
    await assert.rejects(Promise.resolve(binding.tools[0]!.func({})), /temporary/);
    assert.equal(getMcpCircuitState(cfg).state, "closed");
    fail = false;
    assert.equal(await binding.tools[0]!.func({}), "ok");
    await binding.dispose();
  });

  test("MCP connect, list, and invoke operations all enforce the configured timeout", async () => {
    const connectPending = deferred<McpClientLike>();
    const listPending = deferred<{ tools: McpTool[] }>();
    const invokePending = deferred<McpCallResult>();
    let phase = "connect";
    const factory: McpClientFactory = async () => {
      if (phase === "connect") return connectPending.promise;
      return {
        listTools: async () => {
          if (phase === "list") return listPending.promise;
          return { tools: [{ name: "tool", description: "t" }] };
        },
        callTool: async () => invokePending.promise,
        close: async () => {},
      };
    };
    const connectCfg: McpServerConfig = { name: "connect-timeout", url: "https://connect-timeout.example.com" };
    const connectBinding = await bindMcpServers([connectCfg], { clientFactory: factory, timeoutMs: 5 });
    assert.equal(connectBinding.tools.length, 0, "connect timeout fails the bind safely");
    await connectBinding.dispose();
    connectPending.reject(new Error("late connect"));

    phase = "list";
    const listCfg: McpServerConfig = { name: "list-timeout", url: "https://list-timeout.example.com" };
    const listBinding = await bindMcpServers([listCfg], { clientFactory: factory, timeoutMs: 5 });
    assert.equal(listBinding.tools.length, 0);
    await listBinding.dispose();
    listPending.reject(new Error("late list"));

    phase = "invoke";
    const invokeCfg: McpServerConfig = { name: "invoke-timeout", url: "https://invoke-timeout.example.com" };
    const invokeBinding = await bindMcpServers([invokeCfg], { clientFactory: factory, timeoutMs: 5 });
    // Step 1.11 routes the MCP tool call through the pipeline whose `execution`
    // interceptor applies the SAME `timeoutMs` as MCP's own `withMcpTimeout`
    // (requirement 7). Both timers are scheduled and the pipeline's is first, so
    // the INVOKE phase is bounded by the pipeline: the rejection is the
    // pipeline's `tool_timeout` ToolResourceError. The connect and list phases
    // above are NOT pipeline-routed and still surface MCP's own `MCP_TIMEOUT`.
    await assert.rejects(
      Promise.resolve(invokeBinding.tools[0]!.func({})),
      (err: unknown) => err instanceof ToolResourceError && err.code === "tool_timeout",
      "the invoke bound is the pipeline's `execution` interceptor",
    );
    await invokeBinding.dispose();
    invokePending.reject(new Error("late invoke"));
  });

  test("the MCP invoke is bounded by the pipeline, not MCP's own withMcpTimeout (finding m3)", async () => {
    // Both bounds are `timeoutMs` and the pipeline's timer is scheduled first,
    // so a hung `callTool` must reject with the PIPELINE's `tool_timeout`
    // (`ToolResourceError`), never MCP's own `MCP_TIMEOUT` (`McpError`). The
    // error TYPE is what pins which layer fired; the widened assertion above
    // cannot distinguish them (finding m3).
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "t" }] }),
      callTool: async () => new Promise<McpCallResult>(() => {}),
      close: async () => {},
    });
    const cfg: McpServerConfig = { name: "pipeline-bound", url: "https://pipeline-bound.example.com" };
    const binding = await bindMcpServers([cfg], { clientFactory: factory, timeoutMs: 5 });
    try {
      await assert.rejects(
        Promise.resolve(binding.tools[0]!.func({})),
        (err: unknown) =>
          err instanceof ToolResourceError &&
          err.code === "tool_timeout" &&
          err.message.includes("exceeded the handler timeout"),
      );
    } finally {
      await binding.dispose();
    }
  });

  test("default SSE factory uses retained pins and never re-resolves after DNS changes", async () => {
    let lookups = 0;
    let capturedPins: readonly string[] = [];
    const connected = await defaultSseClientFactory(
      {
        name: "retained-pins",
        url: "https://retained-pins.example.com/mcp",
        pinnedIps: ["93.184.216.34"],
      },
      {
        trustedHosts: [],
        lookup: async () => {
          lookups++;
          return [{ address: "1.1.1.1", family: 4 }];
        },
      },
      {
        createAgent: (_hostname, _parsed, pinned) => {
          capturedPins = pinned;
          return { destroy: async () => {} };
        },
        createTransport: () => ({ close: async () => {} }),
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        }),
      },
    );
    assert.equal(lookups, 0);
    assert.deepEqual(capturedPins, ["93.184.216.34"]);
    await connected.close();
  });

  test("an unpinned SSE factory performs one validated DNS resolution", async () => {
    let lookups = 0;
    const connected = await defaultSseClientFactory(
      { name: "unpinned-sse", url: "https://unpinned-sse.example.com/mcp" },
      {
        trustedHosts: [],
        lookup: async () => {
          lookups++;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      },
      {
        createAgent: () => ({ destroy: async () => {} }),
        createTransport: () => ({ close: async () => {} }),
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        }),
      },
    );
    assert.equal(lookups, 1);
    await connected.close();
  });

  // --- MCP-seam SSRF enforcement (plan step 2.4 coverage gap) -----------
  //
  // Step 2.4 moved MCP's SSE egress behind `EgressClient.openPinned`, but the
  // private-URL rejection and redirect-refusal assertions lived only at the
  // facade. These pin them at the MCP seam so a future change to the factory
  // cannot silently drop the policy again.
  test("default SSE factory rejects private/loopback/link-local MCP URLs before any client or transport is built", async () => {
    for (const url of [
      "https://10.0.0.5/mcp",
      "https://127.0.0.1/mcp",
      "https://192.168.1.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
    ]) {
      let agents = 0;
      let transports = 0;
      let clients = 0;
      await assert.rejects(
        defaultSseClientFactory(
          { name: "private-url", url },
          { trustedHosts: [], mode: "test" },
          {
            createAgent: () => {
              agents++;
              return { destroy: async () => {} };
            },
            createTransport: () => {
              transports++;
              return { close: async () => {} };
            },
            createClient: () => {
              clients++;
              return {
                connect: async () => {},
                listTools: async () => ({ tools: [] }),
                callTool: async () => ({ content: [] }),
                close: async () => {},
              };
            },
          },
        ),
        (error: unknown) =>
          error instanceof SsrfValidationError && error.code === "DISALLOWED_HOST",
        url,
      );
      assert.equal(agents, 0, `no agent may be built for ${url}`);
      assert.equal(transports, 0, `no transport may be built for ${url}`);
      assert.equal(clients, 0, `no client may be built for ${url}`);
    }
  });

  test("default SSE factory rejects a hostname resolving into a private range (DNS_REBINDING)", async () => {
    let agents = 0;
    await assert.rejects(
      defaultSseClientFactory(
        { name: "rebind", url: "https://rebind.example.com/mcp" },
        {
          trustedHosts: [],
          mode: "test",
          lookup: async () => [{ address: "10.0.0.5", family: 4 }],
        },
        {
          createAgent: () => {
            agents++;
            return { destroy: async () => {} };
          },
        },
      ),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "DNS_REBINDING",
    );
    assert.equal(agents, 0, "the private resolution is refused before any agent exists");
  });

  test("default SSE factory accepts a private MCP URL that IS in the trusted list", async () => {
    let agents = 0;
    const connected = await defaultSseClientFactory(
      { name: "trusted-private", url: "https://10.0.0.5/mcp" },
      { trustedHosts: ["10.0.0.5"], mode: "test" },
      {
        createAgent: () => {
          agents++;
          return { destroy: async () => {} };
        },
        createTransport: () => ({ close: async () => {} }),
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        }),
      },
    );
    assert.equal(agents, 1, "an admin-trusted private host builds one pinned agent");
    await connected.close();
  });

  test("default SSE factory refuses a 3xx on the pinned stream (never surfaced)", async (t) => {
    let capturedInit: RequestInit | undefined;
    let networkCalls = 0;
    const fetchStub: typeof fetch = async (_input, init) => {
      networkCalls++;
      capturedInit = init;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.internal/steal" },
      });
    };
    t.mock.method(globalThis, "fetch", fetchStub);

    let transportFetch:
      | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
      | undefined;
    const connected = await defaultSseClientFactory(
      { name: "redirect", url: "https://redirect.example.com/mcp" },
      {
        trustedHosts: [],
        mode: "test",
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      {
        createAgent: () => ({ destroy: async () => {} }),
        createTransport: (_url, options) => {
          transportFetch = options.fetch;
          return { close: async () => {} };
        },
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        }),
      },
    );
    assert.ok(transportFetch, "the transport receives the pinned fetch");
    // Behaviour change (plan Phase 2, M2): the pinned stream now refuses a 3xx
    // via `isRedirectStatus`, matching the documented redirect policy and the
    // short path (`validatedFetch`/`policyFetch`). A caller has no legitimate
    // use for a 3xx from a pinned stream, so it is never surfaced.
    await assert.rejects(
      transportFetch("https://redirect.example.com/mcp"),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "REDIRECT_REFUSED",
      "the 3xx is refused, never surfaced to the transport",
    );
    assert.equal(
      capturedInit?.redirect,
      "manual",
      "the pinned stream forces redirect: manual (redirect refusal)",
    );
    assert.equal(networkCalls, 1, "a redirect is not retried or followed");
    await connected.close();
  });

  test("default SSE factory rejects a non-http(s) MCP URL scheme before any client or transport is built", async () => {
    // M4: this case is ONLY catchable by `validateStaticUrl`. A literal private
    // IP or a rebinding hostname is also rejected by `resolveAndValidateHost`,
    // so the tests above would pass even if the facade's static check were
    // removed. A non-http(s) scheme never reaches host resolution at all, so it
    // pins the facade call itself.
    for (const url of ["file:///etc/passwd", "ftp://files.example.com/mcp"]) {
      let agents = 0;
      let transports = 0;
      let clients = 0;
      await assert.rejects(
        defaultSseClientFactory(
          { name: "bad-scheme", url },
          { trustedHosts: [], mode: "test" },
          {
            createAgent: () => {
              agents++;
              return { destroy: async () => {} };
            },
            createTransport: () => {
              transports++;
              return { close: async () => {} };
            },
            createClient: () => {
              clients++;
              return {
                connect: async () => {},
                listTools: async () => ({ tools: [] }),
                callTool: async () => ({ content: [] }),
                close: async () => {},
              };
            },
          },
        ),
        (error: unknown) =>
          error instanceof SsrfValidationError && error.code === "UNSUPPORTED_SCHEME",
        url,
      );
      assert.equal(agents, 0, `no agent may be built for ${url}`);
      assert.equal(transports, 0, `no transport may be built for ${url}`);
      assert.equal(clients, 0, `no client may be built for ${url}`);
    }
  });

  test("bindMcpServers passes retained pins to the client factory and retains an unpinned resolution", async () => {
    const received: Array<readonly string[] | undefined> = [];
    let resolutions = 0;
    const factory: McpClientFactory = async (_server, deps) => {
      received.push(deps.pinnedIps);
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    };
    const pinnedBinding = await bindMcpServers(
      [{
        name: "pinned-binding",
        url: "https://pinned-binding.example.com",
        pinnedIps: ["93.184.216.34"],
      }],
      { clientFactory: factory },
    );
    assert.deepEqual(received.at(-1), ["93.184.216.34"]);
    await pinnedBinding.dispose();

    const unpinnedFactory: McpClientFactory = async (_server, deps) => {
      received.push(deps.pinnedIps);
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    };
    const unpinned = await bindMcpServers(
      [{ name: "unpinned-binding", url: "https://unpinned-binding.example.com" }],
      {
        clientFactory: unpinnedFactory,
        resolvePins: async () => {
          resolutions++;
          return ["93.184.216.34"];
        },
      },
    );
    await unpinned.tools[0]!.func({});
    await unpinned.tools[0]!.func({});
    assert.equal(resolutions, 1, "one pin resolution is retained for the binding lifetime");
    await unpinned.dispose();
  });

  test("idle lifetime eviction closes once, emits telemetry, and permits a fresh connect", async () => {
    const clock = makeClock();
    const telemetry = captureMcpTelemetry();
    let connects = 0;
    let closes = 0;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {
          closes++;
        },
      };
    };
    const binding = await bindMcpServers(
      [{ name: "idle-lifetime", url: "https://idle-lifetime.example.com" }],
      {
        clientFactory: factory,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        idleTimeoutMs: 100,
        maxSessionLifetimeMs: 1_000,
        timeoutMs: 1_000,
      },
    );
    try {
      assert.equal(connects, 1);
      clock.advance(100);
      clock.fireTimeouts();
      await nextTurn();
      await nextTurn();
      await flushAuditTelemetry();
      assert.equal(closes, 1);
      assert.equal(
        telemetry.records.some(
          (record) => record.event === "mcp.connect" && record.errorCode === MCP_EVICTION_ERROR_CODES.idle,
        ),
        true,
      );
      assert.equal(await binding.tools[0]!.func({}), "ok");
      assert.equal(connects, 2, "the binding can establish a new client after eviction");
      await binding.dispose();
      await binding.dispose();
      assert.equal(closes, 2, "eviction and later disposal each close one client");
    } finally {
      telemetry.restore();
    }
  });

  test("maximum lifetime eviction closes once, emits telemetry, and permits a fresh connect", async () => {
    const clock = makeClock();
    const telemetry = captureMcpTelemetry();
    let connects = 0;
    let closes = 0;
    const factory: McpClientFactory = async () => {
      connects++;
      return {
        listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {
          closes++;
        },
      };
    };
    const binding = await bindMcpServers(
      [{ name: "max-lifetime", url: "https://max-lifetime.example.com" }],
      {
        clientFactory: factory,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        idleTimeoutMs: 1_000,
        maxSessionLifetimeMs: 100,
        timeoutMs: 1_000,
      },
    );
    try {
      clock.advance(100);
      clock.fireTimeouts();
      await nextTurn();
      await nextTurn();
      await flushAuditTelemetry();
      assert.equal(closes, 1);
      assert.equal(
        telemetry.records.some(
          (record) => record.event === "mcp.connect" && record.errorCode === MCP_EVICTION_ERROR_CODES.max_lifetime,
        ),
        true,
      );
      assert.equal(await binding.tools[0]!.func({}), "ok");
      assert.equal(connects, 2);
      await binding.dispose();
      assert.equal(closes, 2);
    } finally {
      telemetry.restore();
    }
  });

  test("lifetime eviction settles an in-flight tool call and memoizes close", async () => {
    const clock = makeClock();
    const telemetry = captureMcpTelemetry();
    const pending = deferred<McpCallResult>();
    let closes = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", description: "tool" }] }),
      callTool: async () => pending.promise,
      close: async () => {
        closes++;
      },
    });
    const binding = await bindMcpServers(
      [{ name: "inflight-lifetime", url: "https://inflight-lifetime.example.com" }],
      {
        clientFactory: factory,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        idleTimeoutMs: 1_000,
        maxSessionLifetimeMs: 100,
        timeoutMs: 1_000,
      },
    );
    try {
      const call = binding.tools[0]!.func({});
      await nextTurn();
      clock.advance(100);
      clock.fireTimeouts();
      await assert.rejects(
        Promise.resolve(call),
        (err: unknown) => err instanceof McpError && err.code === MCP_EVICTION_ERROR_CODES.max_lifetime,
      );
      await nextTurn();
      await flushAuditTelemetry();
      assert.equal(closes, 1);
      assert.equal(
        telemetry.records.some(
          (record) => record.event === "mcp.connect" && record.errorCode === MCP_EVICTION_ERROR_CODES.max_lifetime,
        ),
        true,
      );
      pending.resolve({ content: [] });
      await binding.dispose();
      await binding.dispose();
      assert.equal(closes, 1, "eviction and cleanup share the close promise");
    } finally {
      telemetry.restore();
    }
  });

  test("default MCP session bounds are finite and generous", () => {
    assert.equal(DEFAULT_MCP_IDLE_TIMEOUT_MS, 15 * 60_000);
    assert.equal(DEFAULT_MCP_MAX_SESSION_LIFETIME_MS, 24 * 60 * 60_000);
  });
});
