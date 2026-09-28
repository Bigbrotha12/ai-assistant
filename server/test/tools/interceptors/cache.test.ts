import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createCacheInterceptor } from "../../../src/tools/interceptors/cache.ts";
import type { ToolCallResult, ToolInterceptor } from "../../../src/tools/pipeline.ts";
import { createToolResultCache } from "../../../src/middleware/cache.ts";
import type { ToolResultCache } from "../../../src/middleware/cache.ts";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARKER,
} from "../../../src/tool_bounds.ts";
import { makeBodies, makeCall } from "../support.ts";

function makeCache(t: TestContext): ToolResultCache {
  const cache = createToolResultCache();
  t.after(() => cache.dispose());
  return cache;
}

/** A call carrying the key components the cache interceptor needs. */
function cacheCall(overrides: Parameters<typeof makeCall>[0] = {}) {
  return makeCall({ owner: "user-1", credentialFingerprint: "fp-1", ...overrides });
}

describe("cache interceptor", () => {
  test("miss executes and stores; hit short-circuits without executing", async (t) => {
    const cache = makeCache(t);
    const results: ToolCallResult[] = [];
    let calls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
      onResult: (_dispatch, result) => results.push(result),
    });
    const bodies = makeBodies({
      plugin: async () => {
        calls += 1;
        return "fresh";
      },
    });

    assert.equal(await pipeline.dispatch({ call: cacheCall(), bodies }), "fresh");
    assert.equal(calls, 1);
    assert.equal(cache.size, 1);
    assert.equal(results[0]!.fromCache, false);

    assert.equal(await pipeline.dispatch({ call: cacheCall(), bodies }), "fresh");
    assert.equal(calls, 1, "the second dispatch is served from cache");
    assert.equal(results[1]!.fromCache, true);
    assert.equal(results[1]!.outputBytes, Buffer.byteLength("fresh", "utf8"));
  });

  test("does not cache a mutating (non-read-only) tool", async (t) => {
    const cache = makeCache(t);
    let calls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
    });
    const bodies = makeBodies({
      plugin: async () => {
        calls += 1;
        return "mutated";
      },
    });
    const call = makeCall({ readOnly: false, tool: "create_task" });
    await pipeline.dispatch({ call, bodies });
    await pipeline.dispatch({ call, bodies });
    assert.equal(calls, 2);
    assert.equal(cache.size, 0);
  });

  test("skips cache when a required key component is absent", async (t) => {
    const cache = makeCache(t);
    let calls = 0;
    const get = cache.get.bind(cache);
    let gets = 0;
    cache.get = (key) => {
      gets += 1;
      return get(key);
    };
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
    });
    const bodies = makeBodies({
      plugin: async () => {
        calls += 1;
        return "uncached";
      },
    });
    await pipeline.dispatch({
      call: makeCall({ credentialFingerprint: undefined }),
      bodies,
    });
    await pipeline.dispatch({ call: makeCall({ pluginVersion: undefined }), bodies });
    assert.equal(calls, 2);
    assert.equal(gets, 0, "no cache lookup without a complete key");
    assert.equal(cache.size, 0);
  });

  test("does not store a result from an inner short-circuit (executed false)", async (t) => {
    const cache = makeCache(t);
    let shortCircuit = true;
    let bodyCalls = 0;
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch, next) {
        if (shortCircuit) {
          dispatch.content = "inner";
          return;
        }
        await next();
      },
    };
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache }), short],
    });
    const bodies = makeBodies({
      plugin: async () => {
        bodyCalls += 1;
        return "executed";
      },
    });

    assert.equal(await pipeline.dispatch({ call: cacheCall(), bodies }), "inner");
    assert.equal(cache.size, 0, "an inner short-circuit is not cached");

    shortCircuit = false;
    assert.equal(await pipeline.dispatch({ call: cacheCall(), bodies }), "executed");
    assert.equal(bodyCalls, 1);
    assert.equal(cache.size, 1);
  });

  test("does not write the cache on a hit", async (t) => {
    const cache = makeCache(t);
    let sets = 0;
    const originalSet = cache.set.bind(cache);
    cache.set = (key, result) => {
      sets += 1;
      originalSet(key, result);
    };
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
    });
    const bodies = makeBodies({ plugin: async () => "value" });
    await pipeline.dispatch({ call: cacheCall(), bodies }); // miss -> set once
    await pipeline.dispatch({ call: cacheCall(), bodies }); // hit -> no set
    assert.equal(sets, 1);
  });

  test("an anonymous job call bypasses the cache (no get, no set)", async (t) => {
    const cache = makeCache(t);
    let gets = 0;
    let sets = 0;
    const get = cache.get.bind(cache);
    cache.get = (key) => {
      gets += 1;
      return get(key);
    };
    const set = cache.set.bind(cache);
    cache.set = (key, value) => {
      sets += 1;
      set(key, value);
    };
    let calls = 0;
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
    });
    const bodies = makeBodies({
      plugin: async () => {
        calls += 1;
        return "fresh";
      },
    });
    const call = cacheCall({ channel: "job", toolCallId: undefined });
    await pipeline.dispatch({ call, bodies });
    await pipeline.dispatch({ call, bodies });
    assert.equal(calls, 2, "production's anonymous job branch never caches");
    assert.equal(gets, 0);
    assert.equal(sets, 0);
    assert.equal(cache.size, 0);
  });

  test("bounds and redacts a cache hit (cache unit only, via an outer observer)", async (t) => {
    // maxValueChars is raised so the RAW over-long, unredacted value can be
    // stored; the interceptor must still apply the DEFAULT bound on serve.
    const cache = createToolResultCache({ maxValueChars: 200_000 });
    t.after(() => cache.dispose());
    // An OUTER interceptor observes `dispatch.content` in its post-next() code,
    // BEFORE the core applies its post-onion default bound. Only the cache's own
    // hit-path `boundToolResult` can satisfy these assertions, so deleting it
    // makes this test fail.
    let observed: string | undefined;
    const observer: ToolInterceptor = {
      name: "observer",
      async around(dispatch, next) {
        await next();
        observed = dispatch.content;
      },
    };
    const pipeline = createToolPipeline({
      interceptors: [observer, createCacheInterceptor({ cache })],
    });
    const call = cacheCall();
    const key = {
      owner: "user-1",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: "fp-1",
      tool: "list_tasks",
      argsHash: cache.argsHash({}),
    };
    const secret = "supersecrettoken1234567890";
    cache.set(
      key,
      `Authorization: Bearer ${secret} ${"x".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 100)}`,
    );
    const content = await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => "never" }),
    });
    assert.equal(
      observed,
      content,
      "the cache hit short-circuits and the outer observer sees its content",
    );
    assert.ok(observed!.length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
    assert.ok(observed!.endsWith(TOOL_RESULT_TRUNCATION_MARKER));
    assert.ok(observed!.includes("***"), "credential-shaped material is redacted");
    assert.ok(!observed!.includes(secret));
  });

  test("bounds and redacts on the SET path when call.maxResultChars exceeds the default cap", async (t) => {
    // The cache stores `boundToolResult(dispatch.content)` at the DEFAULT cap,
    // not `call.maxResultChars`. With maxResultChars > DEFAULT an unbounded body
    // result exceeds the cache's own `maxValueChars` and `set` silently drops it
    // (middleware/cache.ts), so without this bound NOTHING is cached. The stored
    // value must also be redacted.
    const cache = makeCache(t);
    const pipeline = createToolPipeline({
      interceptors: [createCacheInterceptor({ cache })],
    });
    const call = cacheCall({ maxResultChars: 200_000 });
    const secret = "supersecrettoken1234567890";
    const bodyValue = `Authorization: Bearer ${secret} ${"x".repeat(
      DEFAULT_TOOL_RESULT_MAX_CHARS + 1_000,
    )}`;
    await pipeline.dispatch({
      call,
      bodies: makeBodies({ plugin: async () => bodyValue }),
    });
    assert.equal(cache.size, 1, "the bounded result is small enough to store");
    const key = {
      owner: "user-1",
      pluginId: "vikunja",
      pluginVersion: "1.4.0",
      credentialFingerprint: "fp-1",
      tool: "list_tasks",
      argsHash: cache.argsHash({}),
    };
    const stored = cache.get(key);
    assert.ok(stored !== undefined);
    assert.ok(stored!.length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
    assert.ok(stored!.endsWith(TOOL_RESULT_TRUNCATION_MARKER));
    assert.ok(stored!.includes("***"), "credential-shaped material is redacted before storage");
    assert.ok(!stored!.includes(secret));
  });
});
