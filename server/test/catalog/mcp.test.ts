import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadMcpCatalog } from "../../src/catalog/mcp.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "my-server", url: "https://example.com/api", ...overrides };
}

const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.MCP_TEST_TOKEN = process.env.MCP_TEST_TOKEN;
  envBackup.NODE_ENV = process.env.NODE_ENV;
});

afterEach(() => {
  if (envBackup.MCP_TEST_TOKEN === undefined) {
    delete process.env.MCP_TEST_TOKEN;
  } else {
    process.env.MCP_TEST_TOKEN = envBackup.MCP_TEST_TOKEN;
  }
  if (envBackup.NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = envBackup.NODE_ENV;
  }
});

describe("loadMcpCatalog", () => {
  test("happy path: valid mcp.json returns entries", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(filePath, JSON.stringify([validEntry()]), "utf8");
      const entries = await loadMcpCatalog(filePath);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.name, "my-server");
      assert.equal(entries[0]!.url, "https://example.com/api");
    });
  });

  test("file not found returns empty array", async () => {
    await withDir(async (dir) => {
      const entries = await loadMcpCatalog(join(dir, "nonexistent.json"));
      assert.deepEqual(entries, []);
    });
  });

  test("bad JSON throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(filePath, "not json", "utf8");
      await assert.rejects(
        loadMcpCatalog(filePath),
        /not valid JSON/,
      );
    });
  });

  test("invalid name throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(filePath, JSON.stringify([validEntry({ name: "Bad Name" })]), "utf8");
      await assert.rejects(
        loadMcpCatalog(filePath),
        /must be lowercase kebab-case/,
      );
    });
  });

  test("invalid URL throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(filePath, JSON.stringify([validEntry({ url: "not-a-url" })]), "utf8");
      await assert.rejects(
        loadMcpCatalog(filePath),
        /must be an absolute URL/,
      );
    });
  });

  test("SSRF rejected private IP URL throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(filePath, JSON.stringify([validEntry({ url: "https://10.0.0.1/api" })]), "utf8");
      await assert.rejects(
        loadMcpCatalog(filePath),
        (e: unknown) =>
          e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
      );
    });
  });

  test("duplicate names throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry(), validEntry({ url: "https://example.com/other" })]),
        "utf8",
      );
      await assert.rejects(
        loadMcpCatalog(filePath),
        /Duplicate MCP server name/,
      );
    });
  });

  test("env-var header set in process.env resolves correctly", async () => {
    process.env.MCP_TEST_TOKEN = "sk-secret-token";
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry({ headers: { Authorization: "${MCP_TEST_TOKEN}" } })]),
        "utf8",
      );
      const entries = await loadMcpCatalog(filePath);
      assert.equal(entries[0]!.headers!.Authorization, "sk-secret-token");
    });
  });

  test("env-var header with missing env var throws", async () => {
    delete process.env.MCP_TEST_TOKEN;
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry({ headers: { Authorization: "${MISSING}" } })]),
        "utf8",
      );
      await assert.rejects(
        loadMcpCatalog(filePath),
        /undefined environment variable.*MISSING/,
      );
    });
  });

  test("literal header value not matching env-var grammar throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry({ headers: { Authorization: "Bearer xyz" } })]),
        "utf8",
      );
      await assert.rejects(
        loadMcpCatalog(filePath),
        /must match \$\{ENV_VAR\} pattern/,
      );
    });
  });

  test("CRLF in resolved env value throws", async () => {
    process.env.MCP_TEST_TOKEN = "Bearer\ntoken";
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry({ headers: { Authorization: "${MCP_TEST_TOKEN}" } })]),
        "utf8",
      );
      await assert.rejects(
        loadMcpCatalog(filePath),
        /control characters or CRLF/,
      );
    });
  });

  test("dangerous header name throws", async () => {
    await withDir(async (dir) => {
      const filePath = join(dir, "mcp.json");
      await writeFile(
        filePath,
        JSON.stringify([validEntry({ headers: { "content-type": "text/plain" } })]),
        "utf8",
      );
      await assert.rejects(
        loadMcpCatalog(filePath),
        (e: unknown) =>
          e instanceof SsrfValidationError && e.code === "INVALID_URL" && e.message.includes("reserved/dangerous"),
      );
    });
  });
});