import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createMcpRoutes } from "../../src/transport/mcps.ts";
import type { Catalogs } from "../../src/catalog/index.ts";

function testApp(catalogs: Catalogs) {
  const app = new Hono();
  app.route("/v1", createMcpRoutes({
    catalogs,
    verifyKey: () => Promise.resolve("test-user"),
  }));
  return app;
}

const auth = { authorization: "Bearer test-key" };

describe("GET /v1/mcps", () => {
  test("returns redacted mcps (url/headers absent, name present)", async () => {
    const app = testApp({
      skills: [],
      mcps: [
        { name: "filesystem", url: "https://fs.example.com/api", headers: { Authorization: "${FS_TOKEN}" } },
        { name: "database", url: "https://db.example.com/query" },
      ],
      agents: [],
    });
    const res = await app.request("/v1/mcps", { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json() as { object: string; data: Array<{ name: string }> };
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0]!.name, "database");
    assert.equal(body.data[1]!.name, "filesystem");
    for (const item of body.data) {
      assert.equal((item as Record<string, unknown>).url, undefined);
      assert.equal((item as Record<string, unknown>).headers, undefined);
    }
    // Serialization guard: url and headers must never leak
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("https://fs.example.com"), false);
    assert.equal(serialized.includes("https://db.example.com"), false);
    assert.equal(serialized.includes("Authorization"), false);
    assert.equal(serialized.includes("FS_TOKEN"), false);
  });

  test("returns empty list when no mcps", async () => {
    const app = testApp({ skills: [], mcps: [], agents: [] });
    const res = await app.request("/v1/mcps", { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { object: "list", data: [] });
  });

  test("requires auth (401 without valid key)", async () => {
    const app = new Hono();
    app.route("/v1", createMcpRoutes({
      catalogs: { skills: [], mcps: [], agents: [] },
      verifyKey: () => Promise.resolve(null),
    }));
    const res = await app.request("/v1/mcps", { headers: auth });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("sorted by name", async () => {
    const app = testApp({
      skills: [],
      mcps: [
        { name: "z-last", url: "https://z.example.com" },
        { name: "a-first", url: "https://a.example.com" },
      ],
      agents: [],
    });
    const res = await app.request("/v1/mcps", { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ name: string }> };
    assert.deepEqual(body.data.map(d => d.name), ["a-first", "z-last"]);
  });
});