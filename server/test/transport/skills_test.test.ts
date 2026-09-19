import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createSkillsRoutes } from "../../src/transport/skills.ts";
import type { Catalogs } from "../../src/catalog/index.ts";

function testApp(catalogs: Catalogs) {
  const app = new Hono();
  app.route("/v1", createSkillsRoutes({
    catalogs,
    verifyKey: () => Promise.resolve("test-user"),
  }));
  return app;
}

const auth = { authorization: "Bearer test-key" };

describe("GET /v1/skills", () => {
  test("returns redacted skills list (content absent, id+title present)", async () => {
    const app = testApp({
      skills: [
        { id: "svc-restart", title: "Service Restart Guide", content: "hidden content" },
        { id: "debugging", title: "Debugging Tips", content: "more hidden content" },
      ],
      mcps: [],
      agents: [],
    });
    const res = await app.request("/v1/skills", { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json() as { object: string; data: Array<{ id: string; title: string }> };
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0]!.id, "debugging");
    assert.equal(body.data[0]!.title, "Debugging Tips");
    assert.equal(body.data[1]!.id, "svc-restart");
    assert.equal(body.data[1]!.title, "Service Restart Guide");
    for (const item of body.data) {
      assert.equal((item as Record<string, unknown>).content, undefined);
    }
    // Serialization guard: JSON-marshal and verify content is truly absent
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("hidden content"), false);
    assert.equal(serialized.includes("more hidden content"), false);
  });

  test("returns empty list when no skills", async () => {
    const app = testApp({ skills: [], mcps: [], agents: [] });
    const res = await app.request("/v1/skills", { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { object: "list", data: [] });
  });

  test("requires auth (401 without valid key)", async () => {
    const app = new Hono();
    app.route("/v1", createSkillsRoutes({
      catalogs: { skills: [], mcps: [], agents: [] },
      verifyKey: () => Promise.resolve(null),
    }));
    const res = await app.request("/v1/skills", { headers: auth });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("sorted by id", async () => {
    const app = testApp({
      skills: [
        { id: "z-final", title: "Z Final", content: "hidden" },
        { id: "a-first", title: "A First", content: "hidden" },
        { id: "m-middle", title: "M Middle", content: "hidden" },
      ],
      mcps: [],
      agents: [],
    });
    const res = await app.request("/v1/skills", { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map(d => d.id), ["a-first", "m-middle", "z-final"]);
  });
});