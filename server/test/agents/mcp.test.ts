import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  bindMcpServers,
  defaultSseClientFactory,
  getMcpToolListCache,
  jsonSchemaToZod,
  mcpToolListCacheKey,
  McpError,
  resetMcpToolListCache,
  setMcpToolListCache,
  type McpServerConfig,
  type McpClientFactory,
  type McpTool,
} from "../../src/agents/mcp.ts";
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
  beforeEach(() => resetMcpToolListCache());
  afterEach(() => resetMcpToolListCache());

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
});
