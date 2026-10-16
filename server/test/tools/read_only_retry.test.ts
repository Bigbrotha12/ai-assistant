import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  READ_ONLY_RETRY_BACKOFF_MS,
  READ_ONLY_RETRY_MAX_ATTEMPTS,
  isTransientToolFailure,
  withReadOnlyRetry,
} from "../../src/tools/read_only_retry.ts";
import { ToolResourceError } from "../../src/tools/bounds.ts";
import { bindPluginTools } from "../../src/agents/orchestrator.ts";
import {
  bindMcpServers,
  getMcpCircuitState,
  resetMcpRuntimeState,
  resetMcpToolListCache,
  type McpClientFactory,
} from "../../src/agents/mcp.ts";
import { buildPipelineForChannel } from "../../src/tools/channel.ts";
import type { ToolPipeline } from "../../src/tools/pipeline.ts";
import { GoalLedger } from "../../src/goals/ledger.ts";
import { migrateLedger } from "../../src/ledger/index.ts";
import type { ToolPluginDefinition } from "../../src/plugins/types.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";
import { logger } from "../../src/observability/logger.ts";

const NEVER_ABORT = new AbortController().signal;

/**
 * Capture audit records emitted through `emitAuditEvent` (mirrors
 * `test/agents/mcp_pipeline.test.ts`). Audit lines are drained to `logger.info`
 * on a `setImmediate`, so callers must `await flushAuditTelemetry()`.
 */
function captureTelemetry(): {
  records: Record<string, unknown>[];
  restore: () => void;
} {
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

/** A transport-shaped error carrying an allowlisted `code`. */
function transportError(code: string): Error & { code: string } {
  const error = new Error(`transport failure (${code})`) as Error & { code: string };
  error.code = code;
  return error;
}

describe("read_only_retry — exported policy constants", () => {
  test("two total attempts (one retry) with a 250ms-then-1000ms schedule", () => {
    assert.equal(READ_ONLY_RETRY_MAX_ATTEMPTS, 2);
    assert.deepEqual([...READ_ONLY_RETRY_BACKOFF_MS], [250, 1000]);
  });
});

describe("isTransientToolFailure — conservative allowlist", () => {
  test("retries a tool_timeout ToolResourceError", () => {
    assert.equal(
      isTransientToolFailure(
        new ToolResourceError("tool_timeout", "timed out", 1, "milliseconds"),
      ),
      true,
    );
  });

  test("does not retry deterministic ToolResourceError codes", () => {
    assert.equal(
      isTransientToolFailure(
        new ToolResourceError("tool_result_too_large", "too big", 1, "bytes"),
      ),
      false,
    );
    assert.equal(
      isTransientToolFailure(
        new ToolResourceError("tool_args_too_large", "too big", 1, "bytes"),
      ),
      false,
    );
    assert.equal(
      isTransientToolFailure(
        new ToolResourceError("tool_args_too_deep", "too deep", 1, "depth"),
      ),
      false,
    );
  });

  test("retries every allowlisted transport code", () => {
    for (const code of [
      "timeout",
      "network_error",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "EPIPE",
    ]) {
      assert.equal(isTransientToolFailure(transportError(code)), true, code);
    }
  });

  test("retries transient HTTP status/statusCode markers", () => {
    assert.equal(
      isTransientToolFailure(
        Object.assign(new Error("bad gateway"), { status: 502 }),
      ),
      true,
    );
    assert.equal(
      isTransientToolFailure(
        Object.assign(new Error("unavailable"), { statusCode: 503 }),
      ),
      true,
    );
    assert.equal(
      isTransientToolFailure(
        Object.assign(new Error("gateway timeout"), { status: 504 }),
      ),
      true,
    );
    assert.equal(
      isTransientToolFailure(
        Object.assign(new Error("teapot"), { status: 418 }),
      ),
      false,
    );
  });

  test("retries a transport code nested on the cause (Node 'fetch failed')", () => {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = transportError("ECONNRESET");
    assert.equal(isTransientToolFailure(error), true);
  });

  test("never retries an AbortError (timeout-abort is indistinguishable from cancellation)", () => {
    assert.equal(
      isTransientToolFailure(new DOMException("aborted", "AbortError")),
      false,
    );
    const error = new Error("aborted");
    error.name = "AbortError";
    assert.equal(isTransientToolFailure(error), false);
  });

  test("unknown values are not transient", () => {
    assert.equal(isTransientToolFailure(new Error("boom")), false);
    assert.equal(isTransientToolFailure("ECONNRESET"), false);
    assert.equal(isTransientToolFailure(undefined), false);
    assert.equal(isTransientToolFailure(null), false);
    assert.equal(isTransientToolFailure({ code: "MCP_TIMEOUT" }), false);
  });
});

describe("withReadOnlyRetry — invoke-once vs transient retry", () => {
  test("retries a transient failure once and resolves on the second attempt", async () => {
    let invocations = 0;
    const result = await withReadOnlyRetry(
      async () => {
        invocations += 1;
        if (invocations === 1) throw transportError("ECONNRESET");
        return "ok";
      },
      { readOnly: true, signal: NEVER_ABORT },
    );
    assert.equal(result, "ok");
    assert.equal(invocations, 2);
  });

  test("exhausts attempts and rethrows the LAST error identity unchanged", async () => {
    let invocations = 0;
    const first = transportError("ECONNRESET");
    const second = transportError("ECONNRESET");
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          invocations += 1;
          throw invocations === 1 ? first : second;
        },
        { readOnly: true, signal: NEVER_ABORT },
      ),
      (error: unknown) => error === second,
    );
    assert.equal(invocations, 2);
  });

  test("a non-transient error is invoked once and rethrown", async () => {
    let invocations = 0;
    const boom = new Error("deterministic failure");
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          invocations += 1;
          throw boom;
        },
        { readOnly: true, signal: NEVER_ABORT },
      ),
      (error: unknown) => error === boom,
    );
    assert.equal(invocations, 1);
  });

  test("readOnly:false invokes once even for a transient error", async () => {
    let invocations = 0;
    const boom = transportError("ECONNRESET");
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          invocations += 1;
          throw boom;
        },
        { readOnly: false, signal: NEVER_ABORT },
      ),
      (error: unknown) => error === boom,
    );
    assert.equal(invocations, 1);
  });

  test("onRetry runs exactly once before the retry backoff, after the retry decision", async () => {
    let invocations = 0;
    const retriedAt: number[] = [];
    const result = await withReadOnlyRetry(
      async () => {
        invocations += 1;
        if (invocations === 1) throw transportError("ECONNRESET");
        return "ok";
      },
      {
        readOnly: true,
        signal: NEVER_ABORT,
        onRetry: () => {
          retriedAt.push(invocations);
        },
      },
    );
    assert.equal(result, "ok");
    assert.equal(invocations, 2);
    assert.deepEqual(
      retriedAt,
      [1],
      "one teardown, invoked after attempt 1 failed and before attempt 2",
    );
  });

  test("a throwing onRetry is contained and the retry still happens", async () => {
    let invocations = 0;
    const result = await withReadOnlyRetry(
      async () => {
        invocations += 1;
        if (invocations === 1) throw transportError("ECONNRESET");
        return "ok";
      },
      {
        readOnly: true,
        signal: NEVER_ABORT,
        onRetry: () => {
          throw new Error("teardown exploded");
        },
      },
    );
    assert.equal(result, "ok");
    assert.equal(invocations, 2, "a throwing teardown must not break the retry");
  });

  test("a rejecting onRetry is contained and the retry still happens", async () => {
    let invocations = 0;
    const result = await withReadOnlyRetry(
      async () => {
        invocations += 1;
        if (invocations === 1) throw transportError("ECONNRESET");
        return "ok";
      },
      {
        readOnly: true,
        signal: NEVER_ABORT,
        onRetry: async () => {
          throw new Error("teardown rejected");
        },
      },
    );
    assert.equal(result, "ok");
    assert.equal(invocations, 2, "a rejecting teardown must not break the retry");
  });

  test("onRetry is not invoked without a retry (mutating call or non-transient failure)", async () => {
    let mutatingTeardowns = 0;
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          throw transportError("ECONNRESET");
        },
        {
          readOnly: false,
          signal: NEVER_ABORT,
          onRetry: () => {
            mutatingTeardowns += 1;
          },
        },
      ),
    );
    assert.equal(
      mutatingTeardowns,
      0,
      "a mutating call is never retried, so there is nothing to tear down",
    );

    let deterministicTeardowns = 0;
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          throw new Error("deterministic failure");
        },
        {
          readOnly: true,
          signal: NEVER_ABORT,
          onRetry: () => {
            deterministicTeardowns += 1;
          },
        },
      ),
    );
    assert.equal(
      deterministicTeardowns,
      0,
      "a non-transient failure is never retried, so the hook must not fire",
    );
  });

  test("a signal aborted before the backoff prevents the second attempt", async () => {
    const controller = new AbortController();
    let invocations = 0;
    const boom = transportError("ECONNRESET");
    await assert.rejects(
      withReadOnlyRetry(
        async () => {
          invocations += 1;
          controller.abort();
          throw boom;
        },
        { readOnly: true, signal: controller.signal },
      ),
      (error: unknown) => error === boom,
    );
    assert.equal(invocations, 1, "a cancelled call must not start another attempt");
  });

  test("a signal aborted during the backoff wakes early, clears the timer, and does not retry", async () => {
    const controller = new AbortController();
    let invocations = 0;
    const boom = transportError("ECONNRESET");
    const startedAt = Date.now();
    const run = withReadOnlyRetry(
      async () => {
        invocations += 1;
        // Cancel while the 250ms backoff is pending.
        setTimeout(() => controller.abort(), 20);
        throw boom;
      },
      { readOnly: true, signal: controller.signal },
    );
    await assert.rejects(run, (error: unknown) => error === boom);
    assert.equal(invocations, 1, "the aborted backoff must not start a second attempt");
    assert.ok(
      Date.now() - startedAt < 250,
      "the abort-aware sleep must wake before the full backoff elapses",
    );
    // If the backoff timer leaked, it would fire now and start attempt 2.
    await new Promise((resolve) => setTimeout(resolve, READ_ONLY_RETRY_BACKOFF_MS[0] + 50));
    assert.equal(invocations, 1, "a leaked backoff timer must not fire after an abort");
  });
});

/**
 * Goal-channel binding proof (Phase 7.2): the retry lives in the BODY, so a
 * transient read-only failure repeats the outbound attempt while the dispatch
 * count — and therefore the `reserve` transaction and `execution` bound —
 * stays at exactly one. A mutating call is never retried.
 */
function makeGoalLedger(): {
  db: Database.Database;
  ledger: GoalLedger;
  goalId: string;
  leaseToken: string;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new GoalLedger(db);
  const goal = ledger.getOrCreateGoal({
    owner: "owner-1",
    idempotencyKey: "key-retry",
    instruction: "do the thing",
    tokenBudget: 10_000,
  });
  const claimed = ledger.claimGoal(goal.id, "owner-1");
  return { db, ledger, goalId: goal.id, leaseToken: claimed.lease_token! };
}

function goalToolPlugin(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.0.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "tool",
    baseUrls: [],
    tools: [
      { name: "list_tasks", description: "read", readOnly: true, inputSchema: { type: "object" } },
      { name: "create_task", description: "write", readOnly: false, inputSchema: { type: "object" } },
    ],
  };
}

/** Counts executor invocations per tool name. */
function countingExecutor(
  handler: (tool: string, attempt: number) => Promise<string>,
): { execute: (p: string, t: string) => Promise<string>; count: (t: string) => number } {
  const counts = new Map<string, number>();
  return {
    count: (tool) => counts.get(tool) ?? 0,
    async execute(_pluginId, toolName) {
      const attempt = (counts.get(toolName) ?? 0) + 1;
      counts.set(toolName, attempt);
      return handler(toolName, attempt);
    },
  };
}

/** Wraps a pipeline to count dispatches while delegating unchanged. */
function countingPipeline(inner: ToolPipeline): {
  pipeline: ToolPipeline;
  dispatches: () => number;
} {
  let dispatches = 0;
  return {
    dispatches: () => dispatches,
    pipeline: {
      interceptorNames: inner.interceptorNames,
      dispatch(input) {
        dispatches += 1;
        return inner.dispatch(input);
      },
      dispose() {
        inner.dispose();
      },
    },
  };
}

describe("goal-channel binding — retry stays inside ONE dispatch (Phase 7.2)", () => {
  test("a transient read-only failure retries (executor x2) but dispatches once", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const inner = buildPipelineForChannel("goal", { goalLedger: ledger, goalId });
    const counter = countingPipeline(inner);
    const executor = countingExecutor(async (tool, attempt) => {
      if (tool === "list_tasks" && attempt === 1) {
        throw transportError("ECONNRESET");
      }
      return `${tool}:ok`;
    });
    const tools = bindPluginTools(
      { listInstalledPlugins: () => [goalToolPlugin()] } as never,
      executor,
      undefined,
      {
        owner: "owner-1",
        channel: "goal",
        goalId,
        stepSeq: 1,
        goalLeaseToken: leaseToken,
        authorisedTools: new Set(["create_task"]),
        pipeline: counter.pipeline,
      },
    );
    const list = tools.find((tool) => tool.name === "list_tasks")!;

    const result = await list.func({}, undefined, { toolCall: { id: "ro-1" } } as never);

    assert.equal(result, "list_tasks:ok");
    assert.equal(executor.count("list_tasks"), 2, "the transient failure was retried");
    assert.equal(
      counter.dispatches(),
      1,
      "the retry is inside the body: exactly one dispatch (one reserve txn1 + one execution bound)",
    );
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM goal_mutation")
      .get() as { n: number };
    assert.equal(rows.n, 0, "a read-only call never reserves a mutation row");
  });

  test("a read-only failure on a non-goal channel is NOT retried", async () => {
    const executor = countingExecutor(async () => {
      throw transportError("ECONNRESET");
    });
    const tools = bindPluginTools(
      { listInstalledPlugins: () => [goalToolPlugin()] } as never,
      executor,
      undefined,
      {
        owner: "owner-1",
        channel: "sync-stateless",
        pipeline: buildPipelineForChannel("sync-stateless", {}),
      },
    );
    const list = tools.find((tool) => tool.name === "list_tasks")!;

    await assert.rejects(
      () => list.func({}, undefined, { toolCall: { id: "sync-1" } } as never) as Promise<unknown>,
      (error: unknown) => (error as { code?: unknown }).code === "ECONNRESET",
    );
    assert.equal(executor.count("list_tasks"), 1, "only the goal channel opts into retry");
  });

  test("a mutating call is never retried and reserves exactly once", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const inner = buildPipelineForChannel("goal", { goalLedger: ledger, goalId });
    const counter = countingPipeline(inner);
    const executor = countingExecutor(async () => {
      throw transportError("ECONNRESET");
    });
    const tools = bindPluginTools(
      { listInstalledPlugins: () => [goalToolPlugin()] } as never,
      executor,
      undefined,
      {
        owner: "owner-1",
        channel: "goal",
        goalId,
        stepSeq: 1,
        goalLeaseToken: leaseToken,
        authorisedTools: new Set(["create_task"]),
        pipeline: counter.pipeline,
      },
    );
    const create = tools.find((tool) => tool.name === "create_task")!;

    await assert.rejects(
      () =>
        create.func({}, undefined, { toolCall: { id: "mut-1" } } as never) as Promise<unknown>,
      (error: unknown) => (error as { code?: unknown }).code === "ECONNRESET",
    );

    assert.equal(executor.count("create_task"), 1, "a mutating call is never retried");
    assert.equal(counter.dispatches(), 1);
    const rows = db
      .prepare("SELECT state FROM goal_mutation")
      .all() as { state: string }[];
    assert.equal(rows.length, 1, "one dispatch reserves exactly once");
    assert.equal(rows[0]!.state, "unresolved", "a thrown mutation is unresolved");
  });
});

/**
 * H1: the MCP goal-channel retry lives INSIDE `runMcpOperation`. One dispatch
 * therefore emits exactly ONE `mcp.tool` audit and performs ONE circuit
 * classification, even when the first outbound attempt fails transiently and
 * the retry succeeds. Under the old body-level retry the whole
 * `runMcpOperation` (including its audit and `completeMcpOperation`) ran twice.
 */
describe("goal-channel MCP — retry stays inside runMcpOperation (Phase 7.2 / H1)", () => {
  test("a transient-then-success read-only call: executor x2, exactly one mcp.tool audit, circuit untouched", async () => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const telemetry = captureTelemetry();
    const server = { name: "mealie", url: "https://mealie.example.com" };
    let callAttempts = 0;
    let factoryCalls = 0;
    let closeCalls = 0;
    const factory: McpClientFactory = async () => {
      factoryCalls += 1;
      return {
        listTools: async () => ({ tools: [{ name: "list_meals", readOnly: true }] }),
        callTool: async () => {
          callAttempts += 1;
          if (callAttempts === 1) throw transportError("ECONNRESET");
          return { content: [{ type: "text", text: "meals" }] };
        },
        close: async () => {
          closeCalls += 1;
        },
      };
    };
    const pipeline = buildPipelineForChannel("goal", { goalLedger: ledger, goalId });
    let binding: Awaited<ReturnType<typeof bindMcpServers>> | undefined;
    try {
      binding = await bindMcpServers([server], {
        clientFactory: factory,
        owner: "owner-1",
        requestId: goalId,
        channel: "goal",
        goalId,
        stepSeq: 1,
        goalLeaseToken: leaseToken,
        authorisedTools: new Set<string>(),
        pipeline,
      });
      const tool = binding.tools.find((candidate) => candidate.name === "list_meals")!;

      const result = await tool.func(
        {},
        undefined,
        { toolCall: { id: "mcp-ro-1" } } as never,
      );

      assert.equal(result, "meals");
      assert.equal(
        callAttempts,
        2,
        "the transient failure is retried internally (two outbound attempts)",
      );

      await flushAuditTelemetry();
      const toolAudits = telemetry.records.filter(
        (record) => record.event === "mcp.tool" && record.server === "mealie",
      );
      assert.equal(
        toolAudits.length,
        1,
        "one dispatch = one mcp.tool audit; the retry is not audited as a second call",
      );
      assert.equal(toolAudits[0]!.outcome, "ok");

      // B: the first attempt's transient failure invalidated the dead
      // connection, so the retry RECONNECTED a fresh client (factory called
      // twice) instead of reusing the stale one. The dead first client was
      // closed by `onRetry` before the retry.
      assert.equal(
        factoryCalls,
        2,
        "the retry reconnects a fresh client; the first connection was invalidated",
      );
      assert.equal(
        closeCalls,
        1,
        "onRetry closed the dead first connection before the retry",
      );

      // The retried failure never reached `completeMcpOperation`, so it did not
      // count toward the circuit.
      const circuit = getMcpCircuitState(server);
      assert.equal(circuit.state, "closed");
      assert.equal(
        circuit.consecutiveFailures,
        0,
        "a retried transient failure must not open/count toward the circuit",
      );
    } finally {
      await binding?.dispose();
      telemetry.restore();
      db.close();
      resetMcpRuntimeState();
      resetMcpToolListCache();
    }
  });

  /**
   * F: the both-attempts-transient path is the one where the circuit IS
   * classified — exactly ONCE, after the FINAL attempt. The retry's own
   * teardown (`onRetry`) must not count a failure or take a permit, and the
   * dispatch must still emit exactly ONE error `mcp.tool` audit.
   */
  test("both attempts transiently fail: two attempts, one error audit, ONE circuit count", async () => {
    resetMcpRuntimeState();
    resetMcpToolListCache();
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const telemetry = captureTelemetry();
    const server = { name: "mealie", url: "https://mealie.example.com" };
    let callAttempts = 0;
    let factoryCalls = 0;
    let closeCalls = 0;
    const factory: McpClientFactory = async () => {
      factoryCalls += 1;
      return {
        listTools: async () => ({ tools: [{ name: "list_meals", readOnly: true }] }),
        callTool: async () => {
          callAttempts += 1;
          throw transportError("ECONNRESET");
        },
        close: async () => {
          closeCalls += 1;
        },
      };
    };
    const pipeline = buildPipelineForChannel("goal", { goalLedger: ledger, goalId });
    let binding: Awaited<ReturnType<typeof bindMcpServers>> | undefined;
    try {
      binding = await bindMcpServers([server], {
        clientFactory: factory,
        owner: "owner-1",
        requestId: goalId,
        channel: "goal",
        goalId,
        stepSeq: 1,
        goalLeaseToken: leaseToken,
        authorisedTools: new Set<string>(),
        pipeline,
      });
      const tool = binding.tools.find((candidate) => candidate.name === "list_meals")!;

      await assert.rejects(
        () =>
          tool.func({}, undefined, {
            toolCall: { id: "mcp-ro-both-fail" },
          } as never) as Promise<unknown>,
        (error: unknown) => (error as { code?: unknown }).code === "ECONNRESET",
        "the ORIGINAL transport error identity is preserved after both attempts fail",
      );

      assert.equal(callAttempts, 2, "both attempts ran (one retry)");
      assert.equal(
        factoryCalls,
        2,
        "the retry reconnected a fresh client after the first connection was invalidated",
      );
      assert.ok(
        closeCalls >= 1,
        "the first (dead) connection was closed before the retry",
      );

      await flushAuditTelemetry();
      const toolAudits = telemetry.records.filter(
        (record) => record.event === "mcp.tool" && record.server === "mealie",
      );
      assert.equal(
        toolAudits.length,
        1,
        "one dispatch = one mcp.tool audit, even when both attempts fail",
      );
      assert.equal(toolAudits[0]!.outcome, "error");

      // F: with the default circuit threshold of 3, `state === "closed"` is
      // weak. Assert the actual count: the failure is classified ONCE (after
      // the final attempt), so it increments by exactly one. The retry's own
      // `onRetry` teardown never counts.
      const circuit = getMcpCircuitState(server);
      assert.equal(circuit.state, "closed");
      assert.equal(
        circuit.consecutiveFailures,
        1,
        "exactly ONE failure classification for the whole dispatch (retry did not count)",
      );
    } finally {
      await binding?.dispose();
      telemetry.restore();
      db.close();
      resetMcpRuntimeState();
      resetMcpToolListCache();
    }
  });
});

/**
 * M2: a handler/model TIMEOUT is intentionally not retried. The `execution`
 * interceptor's bound wraps OUTSIDE the body; the retry (inside the body) sees
 * the composed signal abort, whose `AbortError` the predicate rejects. One
 * invocation, and the dispatch surfaces the bound's `ToolResourceError`.
 */
describe("execution bound — a read-only goal timeout is NOT retried (M2)", () => {
  test("a timed-out read-only goal call invokes the handler exactly once", async () => {
    const { db, ledger, goalId, leaseToken } = makeGoalLedger();
    const inner = buildPipelineForChannel("goal", { goalLedger: ledger, goalId });
    const counter = countingPipeline(inner);
    let invocations = 0;
    const executor = {
      async execute(
        _pluginId: string,
        _toolName: string,
        _args: Record<string, unknown>,
        _credentials?: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<string> {
        invocations += 1;
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void =>
            reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
        return "never";
      },
    };
    const tools = bindPluginTools(
      { listInstalledPlugins: () => [goalToolPlugin()] } as never,
      executor,
      undefined,
      {
        owner: "owner-1",
        channel: "goal",
        goalId,
        stepSeq: 1,
        goalLeaseToken: leaseToken,
        authorisedTools: new Set(["create_task"]),
        pipeline: counter.pipeline,
        timeoutMs: 20,
      },
    );
    const list = tools.find((tool) => tool.name === "list_tasks")!;

    await assert.rejects(
      () =>
        list.func({}, undefined, { toolCall: { id: "ro-timeout" } } as never) as Promise<unknown>,
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_timeout",
    );
    assert.equal(invocations, 1, "a timeout abort must not start a retry");
    assert.equal(counter.dispatches(), 1, "one dispatch, one execution bound");

    db.close();
  });
});
