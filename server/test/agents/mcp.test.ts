import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import { bindMcpServers, McpError } from "../../src/agents/mcp.ts";

function okBody(data: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result: data, id: 1 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorBody(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: 1 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const fakeLookup: LookupFn = async () => [{ address: "1.2.3.4", family: 4 }];

/**
 * Returns a fetch function that serves responses from a queue.
 * Asserts if the queue empties before the test completes.
 */
function servingFetch(responseQueue: Response[]): typeof fetch {
  const q = [...responseQueue];
  return async () => q.shift() ?? new Response(null, { status: 500 });
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
    const tools = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      undefined,
      {
        fetchFn: servingFetch([
          okBody({
            protocolVersion: "2025-03-26",
            serverInfo: { name: "test-mcp", version: "1.0.0" },
            capabilities: { tools: {} },
          }),
          okBody({
            tools: [
              {
                name: "echo",
                description: "Echoes input back",
                inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
              },
              { name: "noop", description: "Does nothing", inputSchema: { type: "object", properties: {} } },
            ],
          }),
        ]),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(tools.length, 2);
    assert.ok(tools[0] instanceof DynamicStructuredTool);
    assert.equal(tools[0]!.name, "echo");
    assert.equal(tools[0]!.description, "Echoes input back");
    assert.equal(tools[1]!.name, "noop");
  });

  test("bindMcpServers skips tools without a name", async () => {
    const tools = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      undefined,
      {
        fetchFn: servingFetch([
          okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "x", version: "1" }, capabilities: {} }),
          okBody({ tools: [{ name: "", description: "empty name" }, { name: "valid", description: "ok" }] }),
        ]),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "valid");
  });

  test("bindMcpServers skips server on initialization failure without crashing", async () => {
    const tools = await bindMcpServers(
      [
        { name: "failing-server", url: "https://mcp-fail.example.com" },
        { name: "good-server", url: "https://mcp-good.example.com" },
      ],
      undefined,
      {
        fetchFn: servingFetch([
          errorBody("init failed"),
          okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "g", version: "1" }, capabilities: {} }),
          okBody({ tools: [{ name: "good-tool", description: "works", inputSchema: { type: "object", properties: {} } }] }),
        ]),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "good-tool");
  });

  test("bindMcpServers skips server on tools/list failure", async () => {
    const tools = await bindMcpServers(
      [{ name: "bad-server", url: "https://mcp-bad.example.com" }],
      undefined,
      {
        fetchFn: servingFetch([
          okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "b", version: "1" }, capabilities: {} }),
          errorBody("tools not available"),
        ]),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(tools.length, 0);
  });

  test("bindMcpServers returns empty array for empty input", async () => {
    const tools = await bindMcpServers([]);
    assert.deepEqual(tools, []);
  });

  test("mcp tool func calls tools/call and returns text content", async () => {
    let toolsCallVerified = false;

    const tools = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      undefined,
      {
        fetchFn: (() => {
          let idx = 0;
          const setup: Response[] = [
            okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "x", version: "1" }, capabilities: {} }),
            okBody({
              tools: [{
                name: "greet",
                description: "Greets someone",
                inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
              }],
            }),
          ];
          return async (_url: string | URL | Request, init?: RequestInit) => {
            if (idx >= 2) {
              const body = JSON.parse(init!.body as string);
              assert.equal(body.method, "tools/call");
              assert.equal(body.params.name, "greet");
              assert.deepEqual(body.params.arguments, { name: "world" });
              toolsCallVerified = true;
              return okBody({ content: [{ type: "text", text: "Hello, world!" }] });
            }
            return setup[idx++]!;
          };
        })(),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(tools.length, 1);
    const result = await tools[0]!.func({ name: "world" });
    assert.ok(toolsCallVerified);
    assert.equal(result, "Hello, world!");
  });

  test("mcp tool func joins multiple content items", async () => {
    const tools = await bindMcpServers(
      [{ name: "test-server", url: "https://mcp.example.com" }],
      undefined,
      {
        fetchFn: (() => {
          let idx = 0;
          const setup: Response[] = [
            okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "x", version: "1" }, capabilities: {} }),
            okBody({
              tools: [{
                name: "multi",
                description: "Returns multiple items",
                inputSchema: { type: "object", properties: {} },
              }],
            }),
          ];
          return async () => {
            if (idx >= 2) {
              return okBody({ content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] });
            }
            return setup[idx++]!;
          };
        })(),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    const result = await tools[0]!.func({});
    assert.equal(result, "line1\nline2");
  });

  test("bindMcpServers passes headers to requests", async () => {
    const recorded: { url: string; headers: Record<string, string> }[] = [];

    await bindMcpServers(
      [{ name: "auth-server", url: "https://mcp-auth.example.com", headers: { Authorization: "Bearer test-token" } }],
      undefined,
      {
        fetchFn: (() => {
          let idx = 0;
          const setup: Response[] = [
            okBody({ protocolVersion: "2025-03-26", serverInfo: { name: "a", version: "1" }, capabilities: {} }),
            okBody({ tools: [{ name: "t", description: "", inputSchema: { type: "object", properties: {} } }] }),
          ];
          return async (url: string | URL | Request, init?: RequestInit) => {
            const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
            recorded.push({ url: urlStr, headers: (init?.headers ?? {}) as Record<string, string> });
            return setup[idx++]!;
          };
        })(),
        lookup: fakeLookup,
        mode: "test",
      },
    );

    assert.equal(recorded.length, 2);
    for (const call of recorded) {
      assert.equal(call.headers["Authorization"], "Bearer test-token");
    }
  });
});