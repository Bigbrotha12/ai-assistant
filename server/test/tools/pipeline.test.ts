import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../src/tools/pipeline.ts";
import type {
  ToolBody,
  ToolCallResult,
  ToolCallScope,
  ToolInterceptor,
} from "../../src/tools/pipeline.ts";
import { createSerializeInterceptor } from "../../src/tools/interceptors/serialize.ts";
import { createExecutionInterceptor } from "../../src/tools/interceptors/execution.ts";
import { createBudgetInterceptor } from "../../src/tools/interceptors/budget.ts";
import { makePluginBodies } from "../../src/tools/bind.ts";
import { createBudgetManager } from "../../src/middleware/budget.ts";
import { ToolResourceError } from "../../src/tool_bounds.ts";
import { makeBodies, makeCall, tracingInterceptor } from "./support.ts";

function captureResults(): {
  results: ToolCallResult[];
  sink: (dispatch: unknown, result: ToolCallResult) => void;
} {
  const results: ToolCallResult[] = [];
  return {
    results,
    sink: (_dispatch, result) => {
      results.push(result);
    },
  };
}

describe("ToolPipeline — dispatch semantics", () => {
  test("runs interceptors outer→inner and the body last, unwinding LIFO", async () => {
    const order: string[] = [];
    const pipeline = createToolPipeline({
      interceptors: [tracingInterceptor("a", order), tracingInterceptor("b", order)],
    });
    const bodies = makeBodies({
      plugin: async () => {
        order.push("body");
        return "ok";
      },
    });
    const content = await pipeline.dispatch({ call: makeCall(), bodies });
    assert.equal(content, "ok");
    assert.deepEqual(order, ["a", "b", "body", "b:after", "a:after"]);
  });

  test("a short-circuit prevents inner interceptors AND the body", async () => {
    const order: string[] = [];
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        order.push("short");
        dispatch.content = "cached";
      },
    };
    const pipeline = createToolPipeline({
      interceptors: [
        tracingInterceptor("outer", order),
        short,
        tracingInterceptor("inner", order),
      ],
    });
    const bodies = makeBodies({
      plugin: async () => {
        order.push("body");
        return "never";
      },
    });
    const content = await pipeline.dispatch({ call: makeCall(), bodies });
    assert.equal(content, "cached");
    assert.deepEqual(order, ["outer", "short", "outer:after"]);
  });

  test("calling next() twice is rejected at runtime and runs the body once", async () => {
    let bodyCalls = 0;
    const double: ToolInterceptor = {
      name: "double",
      async around(_dispatch, next) {
        await next();
        await next();
      },
    };
    const pipeline = createToolPipeline({ interceptors: [double] });
    const bodies = makeBodies({
      plugin: async () => {
        bodyCalls += 1;
        return "ok";
      },
    });
    await assert.rejects(
      pipeline.dispatch({ call: makeCall(), bodies }),
      /ToolInterceptor 'double' called next\(\) more than once/,
    );
    assert.equal(bodyCalls, 1);
  });

  test("interceptorNames reports names in dispatch order", () => {
    const pipeline = createToolPipeline({
      interceptors: [tracingInterceptor("a", []), tracingInterceptor("b", [])],
    });
    assert.deepEqual([...pipeline.interceptorNames], ["a", "b"]);
  });

  test("dispose() is a no-op today and leaves the pipeline usable", async () => {
    const pipeline = createToolPipeline({ interceptors: [] });
    pipeline.dispose();
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "still usable" }),
    });
    assert.equal(content, "still usable");
  });
});

describe("ToolPipeline — onResult", () => {
  test("fires exactly once on success with outcome ok and computed bytes", async () => {
    const { results, sink } = captureResults();
    const pipeline = createToolPipeline({ interceptors: [], onResult: sink });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "héllo" }),
    });
    assert.equal(content, "héllo");
    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "ok");
    assert.equal(result.content, "héllo");
    assert.equal(result.outputBytes, Buffer.byteLength("héllo", "utf8"));
    assert.equal(result.fromCache, false);
    assert.equal(result.replayed, false);
    assert.equal(result.errorCode, undefined);
  });

  test("fires exactly once on a body throw and rethrows the error unchanged", async () => {
    const { results, sink } = captureResults();
    const boom = new Error("body boom");
    const pipeline = createToolPipeline({ interceptors: [], onResult: sink });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({ plugin: async () => Promise.reject(boom) }),
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.outcome, "error");
  });

  test("fires exactly once on an interceptor throw", async () => {
    const { results, sink } = captureResults();
    const boom = new Error("interceptor boom");
    const interceptor: ToolInterceptor = {
      name: "boom",
      async around() {
        throw boom;
      },
    };
    const pipeline = createToolPipeline({ interceptors: [interceptor], onResult: sink });
    await assert.rejects(
      pipeline.dispatch({ call: makeCall(), bodies: makeBodies() }),
      (error: unknown) => error === boom,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, "error");
  });

  test("fires exactly once on a serialization failure with the tool_args_* code", async () => {
    const { results, sink } = captureResults();
    let bodyRan = false;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const pipeline = createToolPipeline({
      interceptors: [createSerializeInterceptor()],
      onResult: sink,
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ args: cyclic }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      (error: unknown) =>
        error instanceof ToolResourceError &&
        error.code === "tool_args_not_serializable",
    );
    assert.equal(bodyRan, false, "serialization fails before the body runs");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, "error");
    assert.equal(results[0]!.errorCode, "tool_args_not_serializable");
    assert.equal(results[0]!.inputBytes, 0);
  });

  test("a throwing onResult sink does not break a successful dispatch", async () => {
    const pipeline = createToolPipeline({
      interceptors: [],
      onResult: () => {
        throw new Error("sink boom");
      },
    });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "survives" }),
    });
    assert.equal(content, "survives");
  });

  test("a throwing onResult sink does not mask a body throw", async () => {
    const boom = new Error("body boom");
    const pipeline = createToolPipeline({
      interceptors: [],
      onResult: () => {
        throw new Error("sink boom");
      },
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({ plugin: async () => Promise.reject(boom) }),
      }),
      (error: unknown) => error === boom,
    );
  });

  test("a short-circuiting denial via dispatch.errorCode is reported as not-ok", async () => {
    const { results, sink } = captureResults();
    const deny: ToolInterceptor = {
      name: "guardrail",
      async around(dispatch) {
        dispatch.content = "denied";
        dispatch.errorCode = "guardrail_denied";
      },
    };
    let bodyRan = false;
    const pipeline = createToolPipeline({ interceptors: [deny], onResult: sink });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "never";
        },
      }),
    });
    assert.equal(content, "denied");
    assert.equal(bodyRan, false);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.outcome, "error");
    assert.equal(results[0]!.errorCode, "guardrail_denied");
  });

  test("a body resolving a non-string does not throw inside the audit finally", async () => {
    const { results, sink } = captureResults();
    const pipeline = createToolPipeline({ interceptors: [], onResult: sink });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: (async () => undefined) as unknown as () => Promise<string> }),
    });
    assert.equal(content, "");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outputBytes, 0);
  });

  test("a thrown error's code wins over a stale dispatch.errorCode set before delegation (N3)", async () => {
    const { results, sink } = captureResults();
    const stale: ToolInterceptor = {
      name: "stale",
      async around(dispatch, next) {
        dispatch.errorCode = "stale_code";
        await next();
      },
    };
    const bodyError = Object.assign(new Error("body boom"), { code: "real_code" });
    const pipeline = createToolPipeline({ interceptors: [stale], onResult: sink });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({ plugin: async () => Promise.reject(bodyError) }),
      }),
      (error: unknown) => error === bodyError,
    );
    assert.equal(results.length, 1);
    assert.equal(
      results[0]!.errorCode,
      "real_code",
      "a stale dispatch.errorCode must not mask the thrown error's code",
    );
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.outcome, "error");
  });

  test("a short-circuit denial still honours dispatch.errorCode when nothing is thrown", async () => {
    const { results, sink } = captureResults();
    const deny: ToolInterceptor = {
      name: "guardrail",
      async around(dispatch) {
        dispatch.content = "denied";
        dispatch.errorCode = "guardrail_denied";
      },
    };
    const pipeline = createToolPipeline({ interceptors: [deny], onResult: sink });
    await pipeline.dispatch({ call: makeCall(), bodies: makeBodies() });
    assert.equal(results[0]!.errorCode, "guardrail_denied");
  });
});

describe("ToolPipeline — signal propagation", () => {
  test("a signal passed to next() reaches the body", async () => {
    const controller = new AbortController();
    let bodySignal: AbortSignal | undefined;
    const narrow: ToolInterceptor = {
      name: "narrow",
      async around(_dispatch, next) {
        await next(controller.signal);
      },
    };
    const body: ToolBody = (_dispatch, signal) => {
      bodySignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const pipeline = createToolPipeline({ interceptors: [narrow] });
    const pending = pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }) });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("narrowed"));
    await assert.rejects(pending, /narrowed/);
    assert.equal(bodySignal?.aborted, true);
  });

  test("an outer call.signal abort propagates to the body without next(signal)", async () => {
    const controller = new AbortController();
    let bodySignal: AbortSignal | undefined;
    const body: ToolBody = (_dispatch, signal) => {
      bodySignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const pipeline = createToolPipeline({ interceptors: [] });
    const pending = pipeline.dispatch({
      call: makeCall({ signal: controller.signal }),
      bodies: makeBodies({ plugin: body }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("channel abort"));
    await assert.rejects(pending, /channel abort/);
    assert.equal(bodySignal?.aborted, true);
  });

  test("next(signal) COMPOSES with the channel signal; an outer abort still reaches the body", async () => {
    // If `next(signal)` assigned `bodySignal = signal` (replacement) instead of
    // `AbortSignal.any([bodySignal, signal])`, the outer abort below would not
    // reach the body and this promise would never settle.
    const outer = new AbortController();
    const inner = new AbortController();
    let bodySignal: AbortSignal | undefined;
    let outcome: string | undefined;
    const narrow: ToolInterceptor = {
      name: "narrow",
      async around(_dispatch, next) {
        await next(inner.signal);
      },
    };
    const body: ToolBody = (_dispatch, signal) => {
      bodySignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const pipeline = createToolPipeline({
      interceptors: [narrow],
      onResult: (_dispatch, result) => {
        outcome = result.outcome;
      },
    });
    const pending = pipeline.dispatch({
      call: makeCall({ signal: outer.signal }),
      bodies: makeBodies({ plugin: body }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The inner signal is NOT aborted; only the outer channel signal is.
    assert.equal(inner.signal.aborted, false);
    outer.abort(new Error("outer abort"));
    await assert.rejects(pending, /outer abort/);
    assert.equal(bodySignal?.aborted, true);
    // m8: `call.signal` is aborted here too, but the composed `bodySignal` is
    // what an inner-only abort would rely on; either way this is a cancellation.
    assert.equal(outcome, "cancelled");
  });

  test("an inner-only bodySignal abort classifies as cancelled, not error", async () => {
    // `call.signal` is NEVER aborted; only the interceptor-supplied signal is.
    const inner = new AbortController();
    let outcome: string | undefined;
    const narrow: ToolInterceptor = {
      name: "narrow",
      async around(_dispatch, next) {
        // Abort after the body has started.
        setTimeout(() => inner.abort(new Error("inner abort")), 0);
        await next(inner.signal);
      },
    };
    const body: ToolBody = (_dispatch, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const pipeline = createToolPipeline({
      interceptors: [narrow],
      onResult: (_dispatch, result) => {
        outcome = result.outcome;
      },
    });
    await assert.rejects(
      pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }) }),
      /inner abort/,
    );
    assert.equal(outcome, "cancelled");
  });
});

describe("ToolPipeline — outputBytes and executed", () => {
  test("outputBytes is computed after the onion settles on an executed call", async () => {
    const { results, sink } = captureResults();
    const pipeline = createToolPipeline({ interceptors: [], onResult: sink });
    await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "executed-result" }),
    });
    assert.equal(results[0]!.outputBytes, Buffer.byteLength("executed-result", "utf8"));
  });

  test("outputBytes is computed on a short-circuit too", async () => {
    const { results, sink } = captureResults();
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "cached-result";
        dispatch.fromCache = true;
      },
    };
    const pipeline = createToolPipeline({ interceptors: [short], onResult: sink });
    const content = await pipeline.dispatch({ call: makeCall(), bodies: makeBodies() });
    assert.equal(content, "cached-result");
    assert.equal(results[0]!.outputBytes, Buffer.byteLength("cached-result", "utf8"));
    assert.equal(results[0]!.fromCache, true);
  });

  test("executed is false on a short-circuit and true once the body is invoked", async () => {
    let executedAtBody: boolean | undefined;
    let executedAtShortCircuit: boolean | undefined;
    const body: ToolBody = async (dispatch) => {
      executedAtBody = dispatch.executed;
      return "ok";
    };
    const pipeline = createToolPipeline({ interceptors: [] });
    await pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }) });
    assert.equal(executedAtBody, true);

    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        executedAtShortCircuit = dispatch.executed;
        dispatch.content = "short";
      },
    };
    const shortPipeline = createToolPipeline({ interceptors: [short] });
    await shortPipeline.dispatch({ call: makeCall(), bodies: makeBodies() });
    assert.equal(executedAtShortCircuit, false);
  });

  test("onToolStart/onToolEnd fire around the bounded body (execution interceptor)", async () => {
    const events: string[] = [];
    const scope: ToolCallScope = {
      onToolStart: (actionId) => events.push(`start:${actionId}`),
      onToolEnd: (actionId) => events.push(`end:${actionId}`),
    };
    const body: ToolBody = async () => {
      events.push("body");
      return "ok";
    };
    const pipeline = createToolPipeline({
      interceptors: [createExecutionInterceptor()],
    });
    await pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }), scope });
    assert.deepEqual(events, ["start:action-1", "body", "end:action-1"]);

    // A short-circuit OUTER of `execution` (a replay/cache hit) never fires
    // them, because `execution` is never entered.
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "short";
      },
    };
    const shortPipeline = createToolPipeline({
      interceptors: [short, createExecutionInterceptor()],
    });
    events.length = 0;
    await shortPipeline.dispatch({ call: makeCall(), bodies: makeBodies(), scope });
    assert.deepEqual(events, []);
  });
});

describe("ToolPipeline — beforeBody", () => {
  test("runs after the outer interceptors admitted and immediately before the body", async () => {
    const order: string[] = [];
    const guard: ToolInterceptor = {
      name: "guard",
      beforeBody: () => order.push("beforeBody"),
      async around(_dispatch, next) {
        order.push("guard");
        await next();
        order.push("guard:after");
      },
    };
    const body: ToolBody = async () => {
      order.push("body");
      return "ok";
    };
    const pipeline = createToolPipeline({ interceptors: [guard] });
    await pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }) });
    assert.deepEqual(order, ["guard", "beforeBody", "body", "guard:after"]);
  });

  test("throwing aborts the dispatch before the body with executed still false", async () => {
    const { results, sink } = captureResults();
    let bodyRan = false;
    let executedAtThrow: boolean | undefined;
    const guard: ToolInterceptor = {
      name: "guard",
      beforeBody: (dispatch) => {
        executedAtThrow = dispatch.executed;
        throw new Error("fence lost before body");
      },
      async around(_dispatch, next) {
        await next();
      },
    };
    const pipeline = createToolPipeline({ interceptors: [guard], onResult: sink });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      /fence lost before body/,
    );
    assert.equal(executedAtThrow, false, "executed is not set until every hook returns");
    assert.equal(bodyRan, false);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.outcome, "error");
  });

  test("does not run when an outer interceptor short-circuits", async () => {
    const order: string[] = [];
    const inner: ToolInterceptor = {
      name: "inner",
      beforeBody: () => order.push("beforeBody"),
      async around(_dispatch, next) {
        order.push("inner");
        await next();
      },
    };
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        order.push("short");
        dispatch.content = "hit";
      },
    };
    const pipeline = createToolPipeline({ interceptors: [short, inner] });
    const content = await pipeline.dispatch({ call: makeCall(), bodies: makeBodies() });
    assert.equal(content, "hit");
    assert.deepEqual(order, ["short"]);
  });

  test("every entered interceptor's hook runs in registration order", async () => {
    const order: string[] = [];
    const first: ToolInterceptor = {
      name: "first",
      beforeBody: () => order.push("first:beforeBody"),
      async around(_dispatch, next) {
        await next();
      },
    };
    const second: ToolInterceptor = {
      name: "second",
      beforeBody: () => order.push("second:beforeBody"),
      async around(_dispatch, next) {
        await next();
      },
    };
    const body: ToolBody = async () => {
      order.push("body");
      return "ok";
    };
    const pipeline = createToolPipeline({ interceptors: [first, second] });
    await pipeline.dispatch({ call: makeCall(), bodies: makeBodies({ plugin: body }) });
    assert.deepEqual(order, ["first:beforeBody", "second:beforeBody", "body"]);
  });
});

describe("ToolPipeline — onBodySkipped", () => {
  function countingScope(): { scope: ToolCallScope; calls: number[] } {
    const calls: number[] = [];
    return { scope: { onBodySkipped: () => calls.push(1) }, calls };
  }

  test("does not fire when the body executes (success or body throw)", async () => {
    const success = countingScope();
    const successPipeline = createToolPipeline({ interceptors: [] });
    await successPipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies({ plugin: async () => "ok" }),
      scope: success.scope,
    });
    assert.deepEqual(success.calls, [], "no skip on an executed call");

    const failed = countingScope();
    const failedPipeline = createToolPipeline({ interceptors: [] });
    await assert.rejects(
      failedPipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({ plugin: async () => Promise.reject(new Error("body boom")) }),
        scope: failed.scope,
      }),
      /body boom/,
    );
    assert.deepEqual(failed.calls, [], "a body throw is not a skip");
  });

  test("fires exactly once on a short-circuit", async () => {
    const { scope, calls } = countingScope();
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "cached";
      },
    };
    const pipeline = createToolPipeline({ interceptors: [short] });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies(),
      scope,
    });
    assert.equal(content, "cached");
    assert.equal(calls.length, 1);
  });

  test("fires on a beforeBody denial (the dispatch-level backstop may repeat it)", async () => {
    const { scope, calls } = countingScope();
    let bodyRan = false;
    const guard: ToolInterceptor = {
      name: "guard",
      beforeBody: () => {
        throw new Error("fence lost before body");
      },
      async around(_dispatch, next) {
        await next();
      },
    };
    const pipeline = createToolPipeline({ interceptors: [guard] });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
        scope,
      }),
      /fence lost before body/,
    );
    assert.equal(bodyRan, false);
    // The terminal fires it before the error unwinds (finding m3) and the
    // dispatch-level `finally` repeats it as an idempotent backstop; the
    // channel resolves an already-settled deferred, so the repeat is a no-op.
    assert.ok(calls.length >= 1, "the hook fired at least once");
  });

  test("fires when a bound throws before the body runs (invalid timeout)", async () => {
    const { scope, calls } = countingScope();
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createExecutionInterceptor()],
    });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ timeoutMs: 0 }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
        scope,
      }),
      /timeoutMs must be a positive safe integer/,
    );
    assert.equal(bodyRan, false);
    assert.ok(calls.length >= 1, "the hook fired at least once");
  });

  test("releases the budget slot BEFORE budget's finally, so a body-skip does not transiently quarantine (m3)", async () => {
    // The probe is OUTER of `budget`, so its catch runs after `budget`'s
    // `finally` but before the dispatch-level `onBodySkipped` backstop — exactly
    // the window where the channel's raw deferred used to settle too late and
    // `pluginQuarantines` was transiently non-zero.
    const budget = createBudgetManager({ toolCallQuarantineMs: 500 });
    let concurrentAdmitted = false;
    let concurrentRejected: unknown;
    const probe: ToolInterceptor = {
      name: "probe",
      async around(_dispatch, next) {
        try {
          await next();
        } catch (error) {
          try {
            await budget.withToolCallBudget("owner-1", "vikunja", async () => "second");
            concurrentAdmitted = true;
          } catch (rejection) {
            concurrentRejected = rejection;
          }
          throw error;
        }
      },
    };
    const denyBody: ToolInterceptor = {
      name: "deny-body",
      async around(_dispatch, next) {
        await next();
      },
      beforeBody() {
        throw new Error("body denied");
      },
    };
    const { bodies, scope } = makePluginBodies({
      invoke: async () => "never",
      channelLabel: "test",
    });
    const pipeline = createToolPipeline({
      interceptors: [
        probe,
        createBudgetInterceptor({ budget }),
        createExecutionInterceptor(),
        denyBody,
      ],
    });

    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ owner: "owner-1", timeoutMs: 50 }),
        bodies,
        scope,
      }),
      /body denied/,
    );
    assert.equal(
      concurrentAdmitted,
      true,
      "the concurrent same-plugin call was admitted immediately (no transient quarantine)",
    );
    assert.equal(concurrentRejected, undefined);
  });

  test("a throwing onBodySkipped does not break a successful short-circuit dispatch", async () => {
    const short: ToolInterceptor = {
      name: "short",
      async around(dispatch) {
        dispatch.content = "cached";
      },
    };
    const pipeline = createToolPipeline({ interceptors: [short] });
    const content = await pipeline.dispatch({
      call: makeCall(),
      bodies: makeBodies(),
      scope: {
        onBodySkipped: () => {
          throw new Error("hook boom");
        },
      },
    });
    assert.equal(content, "cached");
  });

  test("a throwing onBodySkipped does not mask a denial error and onResult still fires", async () => {
    const { results, sink } = captureResults();
    const guard: ToolInterceptor = {
      name: "guard",
      beforeBody: () => {
        throw new Error("fence lost before body");
      },
      async around(_dispatch, next) {
        await next();
      },
    };
    const pipeline = createToolPipeline({ interceptors: [guard], onResult: sink });
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall(),
        bodies: makeBodies(),
        scope: {
          onBodySkipped: () => {
            throw new Error("hook boom");
          },
        },
      }),
      /fence lost before body/,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, "error");
  });
});
