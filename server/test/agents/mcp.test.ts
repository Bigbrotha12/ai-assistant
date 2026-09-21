import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  bindMcpServers,
  jsonSchemaToZod,
  McpError,
  type McpServerConfig,
  type McpClientFactory,
  type McpTool,
} from "../../src/agents/mcp.ts";

type CallRecord = {
  server: string;
  params: { name: string; arguments: Record<string, unknown> };
};

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

  test("dispose closes every bound client", async () => {
    const closed: string[] = [];
    const factory: McpClientFactory = async (server) => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed.push(server.name);
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
});
