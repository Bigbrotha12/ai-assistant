import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { McpTool } from "../../src/agents/mcp.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";
import {
  createMcpToolListCache,
  createToolResultCache,
  DEFAULT_MCP_TOOL_LIST_TTL_MS,
} from "../../src/middleware/cache.ts";
import type { ToolCacheKey } from "../../src/middleware/cache.ts";

/**
 * Phase 4, Wave B: unit tests for the in-memory tool-result cache.
 * Everything is deterministic: a fake clock + injectable setInterval/clearInterval
 * drive TTL and sweep tests without real timers.
 */

type FakeClock = {
  now: () => number;
  advance: (ms: number) => void;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  fireIntervals: () => void;
  pending: () => number;
};

function makeClock(initial = 1_000_000): FakeClock {
  let now = initial;
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setInterval: ((fn: () => void) => {
      const handle = {} as unknown as ReturnType<typeof setInterval>;
      timers.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval,
    fireIntervals: () => {
      for (const fn of [...timers.values()]) fn();
    },
    pending: () => timers.size,
  };
}

/** Convenience: a standard owner/pluginId/version/credential set. */
function baseKey(overrides: Partial<ToolCacheKey> = {}): ToolCacheKey {
  return {
    owner: "user-1",
    pluginId: "vikunja",
    pluginVersion: "1.4.0",
    credentialFingerprint: credentialFingerprint({ apiKey: "tok" }),
    tool: "list_tasks",
    argsHash: "aaa",
    ...overrides,
  };
}

describe("createToolResultCache", () => {
  test("set then get round-trips the raw string; get refreshes MRU recency but not TTL", (t) => {
    const clock = makeClock();
    const cache = createToolResultCache({
      ttlMs: 1000,
      maxEntries: 3,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => cache.dispose());

    const k1 = baseKey();
    cache.set(k1, "result-1");
    assert.equal(cache.get(k1), "result-1");
    assert.equal(cache.size, 1);

    // Advance past TTL — should be a lazy-expiry miss.
    clock.advance(1000);
    assert.equal(cache.get(k1), undefined);
    assert.equal(cache.size, 0);
  });

  test("oversized values are not admitted to the cache", (t) => {
    const cache = createToolResultCache({ maxValueChars: 32, now: () => 1_000_000 });
    t.after(() => cache.dispose());
    cache.set(baseKey(), "x".repeat(33));
    assert.equal(cache.size, 0);
    assert.equal(cache.get(baseKey()), undefined);
  });

  test("argsHash is deterministic and independent of object key order", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const h1 = cache.argsHash({ projectId: "p1" });
    const h2 = cache.argsHash({ projectId: "p1" });
    assert.equal(h1, h2, "same args -> same hash");
    assert.match(h1, /^[0-9a-f]{64}$/, "sha256 hex");

    const h3 = cache.argsHash({ b: 2, a: 1 });
    const h4 = cache.argsHash({ a: 1, b: 2 });
    assert.equal(h3, h4, "key order does not affect the hash");

    const h5 = cache.argsHash({ projectId: "p2" });
    assert.notEqual(h1, h5, "different args -> different hash");
  });

  test("argsHash canonicalization: nested objects and arrays are sorted recursively", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const h1 = cache.argsHash({ items: [{ b: 2, a: 1 }, { x: "y" }] });
    const h2 = cache.argsHash({ items: [{ a: 1, b: 2 }, { x: "y" }] });
    assert.equal(h1, h2, "nested object key order is canonicalized");
  });

  test("LRU eviction: oldest entry is evicted first; get refreshes recency", (t) => {
    const clock = makeClock();
    const cache = createToolResultCache({
      ttlMs: 10_000,
      maxEntries: 3,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => cache.dispose());

    const k1 = baseKey({ argsHash: "1" });
    const k2 = baseKey({ argsHash: "2" });
    const k3 = baseKey({ argsHash: "3" });
    const k4 = baseKey({ argsHash: "4" });

    cache.set(k1, "r1");
    clock.advance(10);
    cache.set(k2, "r2");
    clock.advance(10);
    cache.set(k3, "r3");
    assert.equal(cache.size, 3);

    // Insert a 4th entry — k1 (oldest) should be evicted.
    cache.set(k4, "r4");
    assert.equal(cache.size, 3);
    assert.equal(cache.get(k1), undefined, "k1 was the LRU entry and was evicted");
    assert.equal(cache.get(k2), "r2");
    assert.equal(cache.get(k4), "r4");

    // Get k3 to refresh it to MRU. Then insert a 5th — k2 (now oldest) evicts.
    cache.get(k3);
    const k5 = baseKey({ argsHash: "5" });
    cache.set(k5, "r5");
    assert.equal(cache.size, 3);
    assert.equal(cache.get(k2), undefined, "k2 was evicted after k3 was refreshed");
    assert.equal(cache.get(k3), "r3", "k3 survived (refreshed to MRU)");
  });

  test("periodic sweep removes expired entries; lazy-expiry handles in-between reads", (t) => {
    const clock = makeClock();
    const cache = createToolResultCache({
      ttlMs: 500,
      maxEntries: 10,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => cache.dispose());

    assert.equal(clock.pending(), 1, "one sweep timer registered");

    cache.set(baseKey({ argsHash: "a" }), "result-a");
    cache.set(baseKey({ argsHash: "b" }), "result-b");
    assert.equal(cache.size, 2);

    // Half-TTL: both still live.
    clock.advance(250);
    assert.equal(cache.get(baseKey({ argsHash: "a" })), "result-a");

    // Past TTL: lazy expiry on read.
    clock.advance(260); // 510 total
    assert.equal(cache.get(baseKey({ argsHash: "b" })), undefined);
    assert.equal(cache.size, 1, "lazy expiry removed b");

    // Re-insert 'a' then let sweep fire.
    cache.set(baseKey({ argsHash: "a" }), "result-a-2");
    clock.advance(1000);
    clock.fireIntervals();
    assert.equal(cache.get(baseKey({ argsHash: "a" })), undefined, "sweep removed expired entry");
  });

  test("invalidateForUser drops only that owner's entries", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());

    const ka = baseKey({ owner: "alice", argsHash: "1" });
    const kb = baseKey({ owner: "bob", argsHash: "2" });
    cache.set(ka, "alice-result");
    cache.set(kb, "bob-result");
    assert.equal(cache.size, 2);

    cache.invalidateForUser("alice");
    cache.invalidateForUser("alice");
    assert.equal(cache.size, 1);
    assert.equal(cache.get(ka), undefined);
    assert.equal(cache.get(kb), "bob-result");
  });

  test("disposing stops the sweep timer and is idempotent", () => {
    const clock = makeClock();
    const cache = createToolResultCache({
      ttlMs: 100,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    assert.equal(clock.pending(), 1);
    cache.dispose();
    assert.equal(clock.pending(), 0);
    cache.dispose(); // no-op, no throw
    assert.equal(clock.pending(), 0);
  });

  test("constructor rejects invalid options", () => {
    const clock = makeClock();
    const { setInterval, clearInterval } = clock;
    assert.throws(
      () => createToolResultCache({ ttlMs: 0, setInterval, clearInterval }),
      /ttlMs/,
    );
    assert.throws(
      () => createToolResultCache({ maxEntries: 0, setInterval, clearInterval }),
      /maxEntries/,
    );
    assert.throws(
      () => createToolResultCache({ ttlMs: -1, setInterval, clearInterval }),
      /ttlMs/,
    );
    assert.throws(
      () => createToolResultCache({ maxValueChars: 0, setInterval, clearInterval }),
      /maxValueChars/,
    );
  });

  test("every key part matters: changing any part is a distinct cache entry", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());

    const base = baseKey();
    cache.set(base, "base");

    const variants: Partial<ToolCacheKey>[] = [
      { owner: "user-2" },
      { pluginId: "other" },
      { pluginVersion: "2.0.0" },
      { credentialFingerprint: credentialFingerprint({ apiKey: "other" }) },
      { tool: "create_task" },
      { argsHash: "bbb" },
    ];
    for (const v of variants) {
      assert.equal(cache.get(baseKey(v)), undefined, `changing ${Object.keys(v)[0]} is a miss`);
    }
    assert.equal(cache.size, 1, "only the base entry was inserted");
  });

  test("set on an existing key overwrites the value without growing the cache", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const k = baseKey();
    cache.set(k, "first");
    cache.set(k, "second");
    assert.equal(cache.size, 1);
    assert.equal(cache.get(k), "second");
  });

  test("argsHash distinguishes arrays from objects and special types", (t) => {
    const cache = createToolResultCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const ha = cache.argsHash({ a: [1, 2] });
    const hb = cache.argsHash({ a: { "0": 1, "1": 2 } });
    assert.notEqual(ha, hb, "array vs plain object are different");
    const hc = cache.argsHash({ a: null });
    const hd = cache.argsHash({ a: undefined });
    assert.notEqual(hc, hd, "null vs undefined are different");
  });
});

/**
 * MCP tool-list cache (open-gaps P1). Same fake-clock harness as
 * createToolResultCache — TTL and sweep are fully deterministic.
 */
describe("createMcpToolListCache", () => {
  const toolA: McpTool = {
    name: "alpha",
    description: "first",
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
  };
  const toolB: McpTool = { name: "beta", description: "second" };

  test("set/get round-trips the plain JSON list; default TTL is 60s", (t) => {
    const clock = makeClock();
    const cache = createMcpToolListCache({
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => cache.dispose());

    assert.equal(DEFAULT_MCP_TOOL_LIST_TTL_MS, 60_000);
    assert.equal(cache.get("k"), undefined);
    cache.set("k", [toolA, toolB]);
    assert.deepEqual(cache.get("k"), [toolA, toolB]);
    assert.equal(cache.size, 1);

    // Fresh within TTL (get refreshes recency, not the insertion TTL).
    clock.advance(DEFAULT_MCP_TOOL_LIST_TTL_MS - 1);
    assert.deepEqual(cache.get("k"), [toolA, toolB]);

    // Past TTL → lazy-expiry miss.
    clock.advance(2);
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.size, 0);
  });

  test("set snapshots through JSON: mutating the source later does not leak in", (t) => {
    const cache = createMcpToolListCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const source: McpTool[] = [{ name: "a", description: "orig" }];
    cache.set("k", source);
    source[0]!.name = "mutated";
    source.push({ name: "sneaky" });
    assert.deepEqual(cache.get("k"), [{ name: "a", description: "orig" }]);
  });

  test("a bound DynamicStructuredTool never survives as a live instance in the cache", (t) => {
    const cache = createMcpToolListCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const bound = new DynamicStructuredTool({
      name: "echo",
      description: "d",
      schema: (new Object()) as never,
      func: async () => "x",
    });
    // A bound tool slipped in as a McpTool-shaped value: what lands in the
    // cache must be a plain-JSON snapshot — never the instance itself, and
    // never its live `func` closure (which closes over a client).
    cache.set("k", [bound as unknown as McpTool]);
    const got = cache.get("k");
    assert.ok(got, "entry stored");
    assert.ok(!(got[0] instanceof DynamicStructuredTool), "only JSON data stored");
    assert.notEqual(got[0], bound as unknown as McpTool, "snapshot, not the live instance");
    assert.deepEqual(
      JSON.parse(JSON.stringify(got)),
      got,
      "stored value is plain JSON data",
    );
  });

  test("non-serializable value skips caching instead of throwing", (t) => {
    const cache = createMcpToolListCache({ now: () => 1_000_000 });
    t.after(() => cache.dispose());
    const cyclic: Record<string, unknown> = { name: "c" };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => cache.set("k", [cyclic as unknown as McpTool]));
    assert.equal(cache.get("k"), undefined, "unserializable value was not stored");
    assert.equal(cache.size, 0);
  });

  test("LRU eviction: oldest evicted first; get refreshes recency", (t) => {
    const clock = makeClock();
    const cache = createMcpToolListCache({
      ttlMs: 60_000,
      maxEntries: 2,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    t.after(() => cache.dispose());

    cache.set("a", [toolA]);
    clock.advance(10);
    cache.set("b", [toolB]);
    assert.equal(cache.size, 2);

    cache.get("a"); // refresh a → b is now oldest
    clock.advance(10);
    cache.set("c", [toolA, toolB]);
    assert.equal(cache.size, 2, "capacity enforced");
    assert.equal(cache.get("b"), undefined, "b was LRU and got evicted");
    assert.deepEqual(cache.get("a"), [toolA], "a survived (refreshed)");
    assert.deepEqual(cache.get("c"), [toolA, toolB]);
  });

  test("periodic sweep removes expired entries; dispose stops the timer (idempotent)", (t) => {
    const clock = makeClock();
    const cache = createMcpToolListCache({
      ttlMs: 500,
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    assert.equal(clock.pending(), 1, "one sweep timer registered");
    cache.set("a", [toolA]);
    cache.set("b", [toolB]);
    clock.advance(501);
    clock.fireIntervals();
    assert.equal(cache.size, 0, "sweep dropped both expired entries");

    cache.set("c", [toolA]);
    cache.dispose();
    assert.equal(clock.pending(), 0, "dispose clears the sweep timer");
    cache.dispose(); // no-op, no throw
    assert.equal(clock.pending(), 0);
    t.after(() => cache.dispose());
  });

  test("constructor rejects invalid options", () => {
    const clock = makeClock();
    const { setInterval, clearInterval } = clock;
    assert.throws(
      () => createMcpToolListCache({ ttlMs: 0, setInterval, clearInterval }),
      /ttlMs/,
    );
    assert.throws(
      () => createMcpToolListCache({ maxEntries: 0, setInterval, clearInterval }),
      /maxEntries/,
    );
    assert.throws(
      () => createMcpToolListCache({ ttlMs: -1, setInterval, clearInterval }),
      /ttlMs/,
    );
  });
});