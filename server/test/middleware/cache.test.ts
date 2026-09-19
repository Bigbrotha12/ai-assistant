import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { credentialFingerprint } from "../../src/plugins/credential.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
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