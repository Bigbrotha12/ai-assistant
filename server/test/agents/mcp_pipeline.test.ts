import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import {
  bindMcpServers,
  resetMcpRuntimeState,
  resetMcpToolListCache,
  type McpClientFactory,
  type McpClientLike,
  type McpServerConfig,
} from "../../src/agents/mcp.ts";
import {
  BudgetExhaustedError,
  createBudgetManager,
  DEFAULT_MAX_TOOL_CALLS_PER_OWNER,
  DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN,
  DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW,
  DEFAULT_MAX_TOOL_CALLS_PER_PLUGIN,
} from "../../src/middleware/budget.ts";
import { createToolResultCache } from "../../src/middleware/cache.ts";
import { JobError } from "../../src/jobs/errors.ts";
import Database from "better-sqlite3";
import { Ledger, migrateLedger } from "../../src/ledger.ts";
import { logger } from "../../src/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";

/**
 * Step 1.11 pins: MCP tools now dispatch through the shared tool pipeline.
 *
 * D1 — MCP becomes budgeted. `call.pluginId` is `mcp:<serverName>`, so budget's
 *      per-plugin cap binds in addition to MCP's own per-server/per-owner caps.
 *      Effective concurrency is `min(mcp cap, budget cap)`, and the per-turn and
 *      per-window rate caps apply too (finding M3).
 * D2 — MCP read-only results become cacheable, keyed with a fingerprint of the
 *      RESOLVED request headers so a rotated `${MCP_TOKEN}` cannot serve stale.
 * M5 — the conservative read-only AND-merge across duplicate MCP tool names is
 *      restored: a name any server declares non-repeatable is never cached or
 *      job-replayed.
 *
 * Tests use real timers and block inside `callTool` so admitted calls stay
 * in-flight; `.then(ok, err)` handlers are attached immediately so a rejected
 * admission never becomes an unhandled rejection.
 */

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

/** Drain microtasks so every launched call has reached admission. */
function settleAdmissions(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

type TrackedCall = {
  readonly promise: Promise<unknown>;
  state: () => "pending" | "fulfilled" | "rejected";
  error: () => unknown;
};

function track(promise: Promise<unknown>): TrackedCall {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  let error: unknown;
  promise.then(
    () => {
      state = "fulfilled";
    },
    (thrown: unknown) => {
      state = "rejected";
      error = thrown;
    },
  );
  return { promise, state: () => state, error: () => error };
}

async function releaseAndSettle(
  gate: Deferred<void>,
  calls: readonly TrackedCall[],
): Promise<void> {
  gate.resolve();
  await Promise.allSettled(calls.map((call) => call.promise));
}

/** Invoke a bound tool with empty args, normalizing LangChain's union return. */
function invoke(tool: DynamicStructuredTool): Promise<unknown> {
  return Promise.resolve(tool.func({}));
}

/** Minimal in-memory ledger with one claimed (running) task for the job path. */
function makeClaimedTask(owner: string): {
  ledger: Ledger;
  taskId: string;
  fenceToken: string;
  db: Database.Database;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new Ledger(db);
  const task = ledger.createTask({ owner, intentKey: `msg-${owner}`, spec: "{}" });
  const claimed = ledger.claimTask(task.id, owner);
  return { ledger, taskId: claimed.id, fenceToken: claimed.fence_token, db };
}

/** Capture audit records emitted through `emitAuditEvent`. */
function captureTelemetry(): { records: Record<string, unknown>[]; restore: () => void } {
  const originalInfo = logger.info;
  const records: Record<string, unknown>[] = [];
  logger.info = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      try {
        records.push(JSON.parse(arg) as Record<string, unknown>);
      } catch {}
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
 * A factory whose `callTool` blocks on a shared gate, counting concurrent
 * invocations. The client is reused per binding, so every admitted call lands
 * on the same gate and counter.
 */
function gatedFactory(
  gate: Promise<void>,
  counter: { active: number; peak: number; calls: number },
): McpClientFactory {
  return async (): Promise<McpClientLike> => ({
    listTools: async () => ({ tools: [{ name: "tool", readOnly: true }] }),
    callTool: async () => {
      counter.active += 1;
      counter.calls += 1;
      counter.peak = Math.max(counter.peak, counter.active);
      await gate;
      counter.active = Math.max(0, counter.active - 1);
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => {},
  });
}

describe("mcp → tool pipeline (step 1.11)", () => {
  beforeEach(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
  });
  afterEach(() => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
  });

  // --- D2 ------------------------------------------------------------------

  test("D2: a read-only MCP result is cached; the second call does not re-invoke the server", async () => {
    const calls: string[] = [];
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "read", readOnly: true }] }),
      callTool: async (params) => {
        calls.push(params.name);
        return { content: [{ type: "text", text: "fresh" }] };
      },
      close: async () => {},
    });
    const cache = createToolResultCache();
    const budget = createBudgetManager();
    const binding = await bindMcpServers(
      [{ name: "cache-server", url: "https://cache.example.com" }],
      {
        clientFactory: factory,
        owner: "owner-1",
        requestId: "req-1",
        channel: "sync-stateless",
        budget,
        toolCache: cache,
      },
    );
    try {
      assert.equal(await binding.tools[0]!.func({}), "fresh");
      assert.equal(await binding.tools[0]!.func({}), "fresh");
      assert.equal(calls.length, 1, "the second call is served from the result cache");
      assert.equal(cache.size, 1);
    } finally {
      await binding.dispose();
      cache.dispose();
    }
  });

  test("D2: a mutating (non-read-only) MCP result is never cached", async () => {
    let calls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "write", readOnly: false }] }),
      callTool: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "applied" }] };
      },
      close: async () => {},
    });
    const cache = createToolResultCache();
    const budget = createBudgetManager();
    const binding = await bindMcpServers(
      [{ name: "mutate-server", url: "https://mutate.example.com" }],
      {
        clientFactory: factory,
        owner: "owner-1",
        requestId: "req-1",
        channel: "sync-stateless",
        budget,
        toolCache: cache,
      },
    );
    try {
      await binding.tools[0]!.func({});
      await binding.tools[0]!.func({});
      assert.equal(calls, 2, "a mutating tool always executes");
      assert.equal(cache.size, 0);
    } finally {
      await binding.dispose();
      cache.dispose();
    }
  });

  test("D2: the cache key uses the RESOLVED headers, so rotated credentials miss", async () => {
    let calls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "read", readOnly: true }] }),
      callTool: async () => {
        calls += 1;
        return { content: [{ type: "text", text: `value-${calls}` }] };
      },
      close: async () => {},
    });
    const cache = createToolResultCache();
    const budget = createBudgetManager();
    const base = { name: "rotate-server", url: "https://rotate.example.com" };
    const opts = {
      clientFactory: factory,
      owner: "owner-1",
      requestId: "req-1" as const,
      channel: "sync-stateless" as const,
      budget,
      toolCache: cache,
    };
    // `${MCP_TEST_TOKEN}` is an UNRESOLVED reference in `headerRefs`: the
    // tool-list cache key fingerprints the literal `${REF}` string (stable), so
    // the SECOND bind hits the SAME list-cache entry and only re-fetches if the
    // RESULT cache key includes the RESOLVED-header fingerprint. Literal headers
    // (the previous form) fingerprint their values in `mcpToolListCacheKey`
    // too, so they would miss on `pluginVersion` alone and leave the property
    // unpinned (finding M2).
    const previous = process.env.MCP_TEST_TOKEN;
    process.env.MCP_TEST_TOKEN = "Bearer A";
    let first: Awaited<ReturnType<typeof bindMcpServers>> | undefined;
    let second: Awaited<ReturnType<typeof bindMcpServers>> | undefined;
    try {
      first = await bindMcpServers(
        [{ ...base, headerRefs: { authorization: "${MCP_TEST_TOKEN}" } }],
        opts,
      );
      assert.equal(await first.tools[0]!.func({}), "value-1");
      assert.equal(calls, 1);

      process.env.MCP_TEST_TOKEN = "Bearer B";
      second = await bindMcpServers(
        [{ ...base, headerRefs: { authorization: "${MCP_TEST_TOKEN}" } }],
        opts,
      );
      assert.equal(
        await second.tools[0]!.func({}),
        "value-2",
        "a different resolved header fingerprint does not serve the first entry",
      );
      assert.equal(calls, 2, "the rotated token re-invokes the server");
    } finally {
      if (previous === undefined) delete process.env.MCP_TEST_TOKEN;
      else process.env.MCP_TEST_TOKEN = previous;
      await first?.dispose();
      await second?.dispose();
      cache.dispose();
    }
  });

  // --- D1 ------------------------------------------------------------------

  test("D1: a single owner is capped at the per-owner limit (4) with default budget caps", async () => {
    const gate = deferred<void>();
    const counter = { active: 0, peak: 0, calls: 0 };
    const budget = createBudgetManager();
    const binding = await bindMcpServers(
      [{ name: "single-owner", url: "https://single-owner.example.com" }],
      {
        clientFactory: gatedFactory(gate.promise, counter),
        owner: "owner-1",
        requestId: "req-1",
        channel: "sync-stateless",
        budget,
      },
    );
    const calls = Array.from({ length: DEFAULT_MAX_TOOL_CALLS_PER_OWNER + 1 }, () =>
      track(invoke(binding.tools[0]!)),
    );
    try {
      await settleAdmissions();
      assert.equal(counter.active, DEFAULT_MAX_TOOL_CALLS_PER_OWNER, "exactly 4 in flight");
      const rejected = calls.filter((call) => call.state() === "rejected");
      assert.equal(rejected.length, 1, "the 5th call is rejected");
      assert.ok(
        rejected[0]!.error() instanceof BudgetExhaustedError,
        "rejection is the budget limiter",
      );
    } finally {
      await releaseAndSettle(gate, calls);
      await binding.dispose();
    }
  });

  test("D1: a single owner is bound by the per-owner cap, not the new per-plugin cap", async () => {
    const gate = deferred<void>();
    const counter = { active: 0, peak: 0, calls: 0 };
    // Raise ONLY the per-plugin cap: if the single owner's limit were the new
    // per-plugin cap, it would now admit more than 4.
    const budget = createBudgetManager({
      maxToolCallsPerPlugin: DEFAULT_MAX_TOOL_CALLS_PER_PLUGIN * 4,
    });
    const binding = await bindMcpServers(
      [{ name: "per-owner", url: "https://per-owner.example.com" }],
      {
        clientFactory: gatedFactory(gate.promise, counter),
        owner: "owner-1",
        requestId: "req-1",
        channel: "sync-stateless",
        budget,
      },
    );
    const calls = Array.from({ length: DEFAULT_MAX_TOOL_CALLS_PER_OWNER + 1 }, () =>
      track(invoke(binding.tools[0]!)),
    );
    try {
      await settleAdmissions();
      assert.equal(counter.active, DEFAULT_MAX_TOOL_CALLS_PER_OWNER, "per-owner caps at 4");
      const rejected = calls.filter((call) => call.state() === "rejected");
      assert.equal(rejected.length, 1);
      const error = rejected[0]!.error();
      assert.ok(error instanceof BudgetExhaustedError);
      assert.equal(
        error.message.includes("for plugin"),
        false,
        "the rejection is the per-owner cap, not the per-plugin cap",
      );
    } finally {
      await releaseAndSettle(gate, calls);
      await binding.dispose();
    }
  });

  test("D1: one server's combined concurrency across owners is min(mcpPerServer, budgetPerPlugin) = 4", async () => {
    const gate = deferred<void>();
    const counter = { active: 0, peak: 0, calls: 0 };
    const budget = createBudgetManager();
    const server: McpServerConfig = { name: "shared-server", url: "https://shared-server.example.com" };
    const bind = (owner: string) =>
      bindMcpServers([server], {
        clientFactory: gatedFactory(gate.promise, counter),
        owner,
        requestId: `req-${owner}`,
        channel: "sync-stateless",
        budget,
      });
    const [ownerA, ownerB] = await Promise.all([bind("owner-a"), bind("owner-b")]);
    // 2 owners x 3 concurrent = 6 attempted. MCP's per-server cap is 8 and its
    // per-owner cap is 4, so only budget's global per-plugin cap of 4 binds.
    const calls = [
      ...Array.from({ length: 3 }, () => track(invoke(ownerA.tools[0]!))),
      ...Array.from({ length: 3 }, () => track(invoke(ownerB.tools[0]!))),
    ];
    try {
      await settleAdmissions();
      assert.equal(
        counter.active,
        DEFAULT_MAX_TOOL_CALLS_PER_PLUGIN,
        "exactly 4 in flight across both owners (budget per-plugin)",
      );
      assert.equal(
        calls.filter((call) => call.state() === "rejected").length,
        2,
        "the 5th and 6th attempts are rejected",
      );
    } finally {
      await releaseAndSettle(gate, calls);
      await Promise.all([ownerA.dispose(), ownerB.dispose()]);
    }
  });

  test("D1: MCP calls also inherit budget's per-turn same-tool rate cap", async () => {
    let calls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "tool", readOnly: true }] }),
      callTool: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => {},
    });
    const budget = createBudgetManager();
    const binding = await bindMcpServers(
      [{ name: "rate-server", url: "https://rate.example.com" }],
      {
        clientFactory: factory,
        owner: "owner-1",
        requestId: "turn-1",
        channel: "sync-stateless",
        budget,
      },
    );
    try {
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN; i += 1) {
        assert.equal(await binding.tools[0]!.func({}), "ok");
      }
      await assert.rejects(
        invoke(binding.tools[0]!),
        (error: unknown) =>
          error instanceof BudgetExhaustedError && error.message.includes("in this turn"),
        "the same MCP tool is rate-capped per turn now that MCP is budgeted",
      );
      assert.equal(calls, DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN);
    } finally {
      await binding.dispose();
    }
  });

  test("D1: MCP calls also inherit budget's per-window rate cap across tools of one server", async () => {
    // 20 calls across ALL tools of one server per owner per 60 s, regardless of
    // tool name or turn id (finding M3: the per-window cap was previously
    // untested for MCP).
    let calls = 0;
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({
        tools: [
          { name: "alpha", readOnly: true },
          { name: "beta", readOnly: true },
        ],
      }),
      callTool: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => {},
    });
    // Defaults: turn cap 8, window cap 20. Raise ONLY the turn cap so every call
    // uses the SAME anonymous `requestId` (→ the same turn key) and the
    // PER-WINDOW cap (20) is the single bound under test, across BOTH tools.
    const budget = createBudgetManager({
      maxToolCallsPerOwnerPluginPerTurn:
        DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW + 1,
    });
    const binding = await bindMcpServers(
      [{ name: "window-server", url: "https://window.example.com" }],
      {
        clientFactory: factory,
        owner: "owner-1",
        requestId: "turn-1",
        channel: "sync-stateless",
        budget,
      },
    );
    try {
      assert.equal(binding.tools.length, 2, "both distinct tool names are bound");
      const toolFor = (index: number) => binding.tools[index % binding.tools.length]!;
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW; i += 1) {
        assert.equal(
          await toolFor(i).func({}, undefined, { toolCall: { id: `call-${i}` } } as never),
          "ok",
          `call ${i} is admitted`,
        );
      }
      await assert.rejects(
        Promise.resolve(
          toolFor(DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW).func({}),
        ),
        (error: unknown) =>
          error instanceof BudgetExhaustedError && error.message.includes("in this window"),
        "the (N+1)th call to ANY tool of the server is window-rate-capped",
      );
      assert.equal(calls, DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW);
    } finally {
      await binding.dispose();
    }
  });

  test("m1: the mcp.tool audit does not claim the tool-list cache hit", async () => {
    // A warm tool-list cache (`mcp.list` cacheHit:true) must not make every
    // `mcp.tool` audit claim `cacheHit:true`: this call executes, so its audit
    // must report false (finding m1).
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "read", readOnly: true }] }),
      callTool: async () => ({ content: [{ type: "text", text: "fresh" }] }),
      close: async () => {},
    });
    const telemetry = captureTelemetry();
    // A mutating tool always executes, so this pins the audit of an EXECUTED
    // call against a WARM list cache (no result cache involved).
    const factoryMutating: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "write", readOnly: false }] }),
      callTool: async () => ({ content: [{ type: "text", text: "applied" }] }),
      close: async () => {},
    });
    try {
      // Warm the shared tool-list cache for this URL without emitting an
      // `mcp.tool` audit: bind once, then dispose WITHOUT invoking.
      const warm = await bindMcpServers(
        [{ name: "audit-server", url: "https://audit.example.com" }],
        { clientFactory: factory },
      );
      await warm.dispose();

      const binding = await bindMcpServers(
        [{ name: "audit-server", url: "https://audit.example.com" }],
        { clientFactory: factoryMutating },
      );
      try {
        await binding.tools[0]!.func({});
        await flushAuditTelemetry();
        const toolAudits = telemetry.records.filter(
          (record) => record.event === "mcp.tool" && record.server === "audit-server",
        );
        assert.equal(toolAudits.length, 1);
        assert.equal(toolAudits[0]!.outcome, "ok");
        assert.equal(
          toolAudits[0]!.cacheHit,
          false,
          "an executed tool call audits cacheHit:false even on a warm tool-list cache",
        );
      } finally {
        await binding.dispose();
      }
    } finally {
      telemetry.restore();
    }
  });

  // --- M5: conservative read-only AND-merge --------------------------------

  test("M5: a duplicate name any server declares destructive is not read-only (never cached)", async () => {
    const calls: string[] = [];
    const factory: McpClientFactory = async (server) => ({
      listTools: async () =>
        server.name === "ro-server"
          ? { tools: [{ name: "shared", readOnly: true }] }
          : { tools: [{ name: "shared", readOnly: false, annotations: { destructiveHint: true } }] },
      callTool: async (params) => {
        calls.push(`${server.name}:${params.name}`);
        return { content: [{ type: "text", text: `${server.name}-result` }] };
      },
      close: async () => {},
    });
    const cache = createToolResultCache();
    const budget = createBudgetManager();
    const binding = await bindMcpServers(
      [
        { name: "ro-server", url: "https://ro.example.com" },
        { name: "destructive-server", url: "https://destructive.example.com" },
      ],
      {
        clientFactory: factory,
        owner: "owner-1",
        requestId: "req-1",
        channel: "sync-stateless",
        budget,
        toolCache: cache,
      },
    );
    try {
      // The first (read-only) occurrence wins the binding; the second is skipped
      // as a name duplicate. The AND-merge must still make it non-read-only.
      assert.equal(binding.tools.length, 1);
      await binding.tools[0]!.func({});
      await binding.tools[0]!.func({});
      assert.equal(calls.length, 2, "a name any server declares destructive is never cached");
      assert.equal(cache.size, 0);
    } finally {
      await binding.dispose();
      cache.dispose();
    }
  });

  test("M5: a destructive duplicate is not job-replayable (tool_retry_forbidden)", async () => {
    const factory: McpClientFactory = async (server) => ({
      listTools: async () =>
        server.name === "ro-server"
          ? { tools: [{ name: "shared", readOnly: true }] }
          : { tools: [{ name: "shared", readOnly: false, annotations: { destructiveHint: true } }] },
      callTool: async () => ({ content: [{ type: "text", text: "ran" }] }),
      close: async () => {},
    });
    const { ledger, taskId, fenceToken, db } = makeClaimedTask("owner-1");
    try {
      const binding = await bindMcpServers(
        [
          { name: "ro-server", url: "https://ro-j.example.com" },
          { name: "destructive-server", url: "https://destructive-j.example.com" },
        ],
        {
          clientFactory: factory,
          owner: "owner-1",
          requestId: "req-1",
          channel: "job",
          ledger,
          taskId,
          fenceToken,
          allowMutatingRetry: false,
        },
      );
      try {
        assert.equal(binding.tools.length, 1);
        // A retry (`allowMutatingRetry:false`) with no ticketed result must
        // refuse rather than re-execute a possibly-applied side effect.
        await assert.rejects(
          Promise.resolve(binding.tools[0]!.func({}, undefined, { toolCall: { id: "call-1" } } as never)),
          (error: unknown) => error instanceof JobError && error.code === "tool_retry_forbidden",
        );
      } finally {
        await binding.dispose();
      }
    } finally {
      ledger.close();
      db.close();
    }
  });

  // --- tie-break preservation ----------------------------------------------

  test("plugin tools win name ties; the MCP duplicate is skipped with the merge warning", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const factory: McpClientFactory = async () => ({
        listTools: async () => ({ tools: [{ name: "echo" }, { name: "other" }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      });
      const binding = await bindMcpServers(
        [{ name: "tie-server", url: "https://tie.example.com" }],
        {
          clientFactory: factory,
          excludeToolNames: new Set(["echo"]),
          duplicateLogPrefix: "[test]",
        },
      );
      assert.deepEqual(binding.tools.map((tool) => tool.name), ["other"]);
      assert.equal(
        warnings.some((line) =>
          line === "[test] tool 'echo' defined by both a plugin and an MCP server; skipping MCP version",
        ),
        true,
        "the plugin-wins warning is preserved verbatim",
      );
      await binding.dispose();
    } finally {
      console.warn = original;
    }
  });

  test("m4: an MCP-vs-MCP duplicate is described accurately, not as a plugin tie", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const factory: McpClientFactory = async (server) => ({
        listTools: async () =>
          server.name === "server-a"
            ? { tools: [{ name: "shared" }] }
            : { tools: [{ name: "shared" }] },
        callTool: async () => ({ content: [] }),
        close: async () => {},
      });
      const binding = await bindMcpServers(
        [
          { name: "server-a", url: "https://a.example.com" },
          { name: "server-b", url: "https://b.example.com" },
        ],
        { clientFactory: factory, duplicateLogPrefix: "[test]" },
      );
      assert.deepEqual(binding.tools.map((tool) => tool.name), ["shared"]);
      assert.equal(
        warnings.some((line) =>
          line === "[test] tool 'shared' defined by multiple MCP servers; skipping MCP version",
        ),
        true,
        "a duplicate between two MCP servers is not misworded as a plugin tie",
      );
      await binding.dispose();
    } finally {
      console.warn = original;
    }
  });
});
