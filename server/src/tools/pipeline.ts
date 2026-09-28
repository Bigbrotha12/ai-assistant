import { logger } from "../logger.ts";
import { boundToolResult } from "../tool_bounds.ts";

/**
 * ToolExecutionPipeline — the single around-middleware engine every tool call
 * traverses, regardless of source (plugin/MCP) or channel (`sync-stateless`,
 * `sync-managed`, `job`, `warmup`). See `docs/plugin-seam-architecture-plan.md`
 * §4.1 (interface) and §4.2 (per-interceptor bodies).
 *
 * The four channels differ ONLY by which interceptors are registered and which
 * bodies are supplied — never by divergent execution code. Interceptors are
 * shared singletons: per-invocation data rides `ToolCall`/`ToolCallScope`, not
 * constructor state.
 *
 * ## Dispatch contract (frozen)
 *
 * 1. **Order.** The interceptor array is ordered outer→inner; the body is
 *    innermost. The intended job order is
 *    `fence → serialize → replay → cache → budget → execution → body`, which
 *    reproduces the job path's exact precedence (serialize after fence so
 *    `task_conflict` wins over `tool_args_too_large`) and the sync path's
 *    serialize-before-cache order.
 * 2. **Short-circuit.** An interceptor that returns without calling `next()`
 *    owns the decision: no inner interceptor runs and the body does not run.
 * 3. **Signal propagation.** `next(signal?)` composes the supplied signal with
 *    the current `dispatch.bodySignal` via `AbortSignal.any`, so a timeout
 *    controller owned by an inner interceptor actually aborts an in-flight
 *    outbound request. The body always receives a defined signal.
 * 4. **`executed`** is set by the core immediately before the body is invoked,
 *    so short-circuits leave it `false`. `replay`/`fence` depend on it.
 * 5. **`beforeBody`** is an optional `ToolInterceptor` field, invoked by the
 *    core at the innermost point — after every entered interceptor has admitted
 *    the call, immediately before the body. Hooks run in registration order and
 *    only for interceptors actually entered: a short-circuit means the body is
 *    never reached, so no `beforeBody` runs. It is the job fence's second
 *    `assertActive` (production `runner.ts:879`), which closes the window where
 *    a task is cancelled during serialize/replay/cache/budget setup but the
 *    body would still run. Throwing aborts the dispatch with no side effect
 *    (`executed` stays `false`), and `executed` is only set after every hook
 *    has returned.
 * 6. **Final default bound.** After the onion settles, the core applies
 *    `boundToolResult(dispatch.content)` at the DEFAULT cap, so executed calls,
 *    cache hits and replay hits are all bounded and redacted exactly as
 *    production (`runner.ts:949,968,980`). `outputBytes` is computed from that
 *    bounded content.
 * 7. **`onToolStart`/`onToolEnd`** are owned by the `execution` interceptor and
 *    fire around the BOUNDED race, not the raw body promise — so a handler that
 *    ignores abort still reports its end when the timeout fires
 *    (`runner.ts:878-920`). Replay/cache hits short-circuit outer of
 *    `execution`, so they never fire them.
 * 8. **`onResult`** fires exactly once per `dispatch()`, in a `try`/`finally`,
 *    with its own body wrapped so a throwing sink cannot break the loop. Its
 *    `errorCode` is `dispatch.errorCode` ONLY when nothing was thrown (a true
 *    short-circuit denial); a thrown error's own code wins otherwise, so a
 *    stale `dispatch.errorCode` set before a delegate cannot mask it. `ok`/
 *    `outcome` reflect a denial set by a short-circuiting interceptor.
 * 9. **`onBodySkipped`** is invoked when the engine knows the body will not
 *    run: the terminal fires it if a `beforeBody` hook throws, `execution`
 *    fires it if its bound threw before the body ran, and the dispatch-level
 *    `finally` is an idempotent backstop. Firing EARLY (before the error
 *    unwinds through `budget`) is what prevents a transient spurious
 *    quarantine: budget's own `finally` would otherwise still see an unsettled
 *    raw body (finding m3). It lets the channel settle its raw-body deferred so
 *    budget releases instead of quarantining and the job's `settle()` is not
 *    held open for the quarantine deadline. A channel whose `onBodySkipped`
 *    resolves an already-resolved deferred is unaffected by the extra call.
 * 10. `dispatch()` returns `dispatch.content`; a thrown body error propagates
 *    unchanged so `ToolNode`'s `handleToolErrors: false` semantics hold.
 */

/** Immutable per-call identity, inputs, and effective policy limits. */
export type ToolCall = {
  readonly source: "plugin" | "mcp";
  /** Plugin id, or `mcp:<serverName>` for MCP-sourced tools. */
  readonly pluginId: string;
  /** Cache key component. */
  readonly pluginVersion?: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly readOnly: boolean;
  readonly owner?: string;
  readonly requestId?: string;
  readonly credentials?: Record<string, unknown>;
  /** Precomputed by the channel; the cache key's fingerprint component. */
  readonly credentialFingerprint?: string;

  /**
   * Channel signal, captured BEFORE any timeout controller exists. The
   * `execution` interceptor composes its own on top via `next(signal)`.
   */
  readonly signal?: AbortSignal;

  readonly channel: "sync-stateless" | "sync-managed" | "job" | "warmup";

  /**
   * Model tool-call id. REQUIRED by `replay`/`fence`: ledger dedupe is keyed on
   * it. Absent for anonymous invocations.
   */
  readonly toolCallId?: string;

  /**
   * Per-call action id for cancellation telemetry. Computed by `bindTools`,
   * which owns the per-binding anonymous sequence counter.
   */
  readonly actionId: string;

  /**
   * Effective policy limits for THIS call, resolved by the channel.
   *   - job:     `handlerTimeoutMs`, `maxResultChars`
   *   - sync:    `toolTimeoutMs`, `DEFAULT_TOOL_RESULT_MAX_CHARS`
   *   - warmup:  the warmup manager's own `timeoutMs` (default 10 s)
   */
  readonly timeoutMs: number;
  readonly maxResultChars: number;

  /** Job channel only. */
  readonly taskId?: string;
  readonly fenceToken?: string;
  readonly allowMutatingRetry?: boolean;
};

/**
 * Per-invocation execution context. The CHANNEL constructs it, because only the
 * channel owns the job's `TrackedExecution` and the raw-body promise.
 */
export type ToolCallScope = {
  /**
   * Resolves when the RAW (unbounded) body settles — NOT when the bounded race
   * settles. Created AND resolved by the channel's own `ToolBody` wrapper. The
   * `budget` interceptor is registered OUTER of `execution`, so it reads this
   * promise before the body runs, while `execution` is still free to abandon
   * the body on timeout. This ordering is the whole point: if `rawSettled` came
   * from the bounded race it would always settle and quarantine could never
   * fire. When the body never starts at all, the channel resolves it from
   * `onBodySkipped` instead (release, not quarantine).
   */
  readonly rawSettled?: Promise<void>;
  /**
   * Called by the core in a `finally` when the dispatch finished WITHOUT the
   * body ever being invoked (a `beforeBody` denial, a short-circuit, or a bound
   * that threw before running). Fires exactly once, and never when the body
   * started. The channel uses it to settle its `rawSettled` deferred so budget
   * releases rather than quarantines, and so the job's `settle()` is not held
   * open for the quarantine deadline. A throw from this hook is contained.
   */
  readonly onBodySkipped?: () => void;
  /** Job channel: register work with the job's TrackedExecution. */
  readonly track?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Job channel: hold the job open until the predicate settles or the deadline passes. */
  readonly trackUntil?: (predicate: () => Promise<void>, ms: number) => void;
  /** Job channel: cancellation telemetry. Fired around the BODY only. */
  readonly onToolStart?: (actionId: string) => void;
  readonly onToolEnd?: (actionId: string) => void;
};

/**
 * Mutable dispatch state, owned by the pipeline and threaded through every
 * interceptor. Mirrors "cooperative listeners mutate a shared request object
 * and then delegate".
 */
export type ToolDispatch = {
  readonly call: ToolCall;
  readonly scope: ToolCallScope;
  /** Model-facing content. Set by the body or by a short-circuiting interceptor. */
  content: string;
  /** Set by the pipeline core immediately before the body is invoked. */
  executed: boolean;
  fromCache: boolean;
  replayed: boolean;
  /** Set by the `serialize` interceptor. */
  inputBytes: number;
  /**
   * The abort signal handed to the body. The core seeds it from `call.signal`
   * (or a never-aborting signal when absent); `next(signal)` narrows it further
   * via `AbortSignal.any`. Always defined, so the body never guards for absence.
   */
  bodySignal: AbortSignal;
  /** Set by any layer that denies; carried into `onResult`. */
  errorCode?: string;
};

/**
 * Around-middleware over one dispatch.
 *  - Call `next()` to delegate inward; `next(signal)` additionally narrows the
 *    abort signal that will reach the body (composed with outer signals).
 *  - Return WITHOUT calling `next()` to short-circuit: the body does not run.
 *  - Calling `next()` more than once is a programming error, rejected at runtime.
 *  - Throwing aborts the dispatch and propagates to the caller.
 *
 * There is deliberately no `after` hook. Each interceptor's own `around` body is
 * an ordinary async function with `try`/`finally`, which gives it full pre/post
 * control (fence re-check, budget release, cache write, replay record) without a
 * second lifecycle to keep in sync.
 */
export type ToolInterceptor = {
  readonly name: string;
  readonly around: (
    dispatch: ToolDispatch,
    next: (signal?: AbortSignal) => Promise<void>,
  ) => Promise<void>;
  /**
   * Invoked by the core immediately before the body is executed, and only on a
   * dispatch that actually reaches the body. Throwing aborts the dispatch with
   * no side effect (`executed` stays false). Interceptors that need a final
   * pre-body guard — currently `fence` — supply it here instead of mutating the
   * dispatch scope.
   *
   * ASSUMPTION: every interceptor `await`s `next()`. The core reaches the
   * terminal (and therefore runs these hooks) only after the whole `around`
   * chain has resolved, so a non-awaited `void next()` could let the terminal
   * run after `dispatch()` already settled. Every shipped interceptor awaits;
   * a future one that does not must be fixed, not accommodated.
   */
  readonly beforeBody?: (dispatch: ToolDispatch) => void;
};

/**
 * The innermost body. Receives the composed abort signal so a timeout actually
 * cancels the outbound request.
 */
export type ToolBody = (dispatch: ToolDispatch, signal: AbortSignal) => Promise<string>;

/** Supplied per dispatch: the MCP body is bound per request/job. */
export type ToolBodies = {
  readonly plugin: ToolBody;
  readonly mcp: ToolBody;
};

/** Settled exactly once per dispatch, on success and on throw. Must not throw. */
export type ToolCallResult = {
  readonly ok: boolean;
  readonly content: string;
  readonly outcome: "ok" | "error" | "timeout" | "cancelled";
  readonly errorCode?: string;
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly fromCache: boolean;
  readonly replayed: boolean;
};

export type ToolPipelineOptions = {
  /** Shared, ordered outer→inner. Per-invocation data rides `call`/`scope`. */
  readonly interceptors: readonly ToolInterceptor[];
  /**
   * Settlement sink. Receives plugin-source calls in the `sync-*` and `job`
   * channels. MCP audit stays inside `runMcpOperation`; warmup audit is opt-in.
   */
  readonly onResult?: (dispatch: ToolDispatch, result: ToolCallResult) => void;
};

export type ToolPipeline = {
  /** Names in dispatch order. Diagnostics and tests. */
  readonly interceptorNames: readonly string[];
  dispatch(input: {
    call: ToolCall;
    bodies: ToolBodies;
    scope?: ToolCallScope;
  }): Promise<string>;
  /** Per §3.2: unregisters nothing today, but keeps the seam honest. */
  dispose(): void;
};

/**
 * A signal that never aborts, used when a call carries no channel signal. The
 * controller is intentionally unreferenced: nothing can ever abort it.
 */
const NEVER_ABORT_SIGNAL = new AbortController().signal;

function isToolTimeout(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code?: unknown }).code === "tool_timeout"
  );
}

function classifyOutcome(
  thrown: unknown,
  dispatch: ToolDispatch,
): ToolCallResult["outcome"] {
  // `call.signal` first, matching production's precedence, then the timeout
  // code, then the COMPOSED `bodySignal`: an inner `next(signal)` abort narrows
  // `bodySignal` but not `call.signal` and is still a cancellation, while the
  // timeout controller's own abort of `bodySignal` must not mask a timeout.
  if (dispatch.call.signal?.aborted === true) return "cancelled";
  if (thrown instanceof Error && thrown.name === "AbortError") return "cancelled";
  if (isToolTimeout(thrown)) return "timeout";
  if (dispatch.bodySignal.aborted === true) return "cancelled";
  return "error";
}

function errorCodeFor(thrown: unknown): string | undefined {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    typeof (thrown as { code?: unknown }).code === "string"
  ) {
    return (thrown as { code: string }).code;
  }
  return undefined;
}

export function createToolPipeline(opts: ToolPipelineOptions): ToolPipeline {
  const interceptors = opts.interceptors;
  const interceptorNames = interceptors.map((interceptor) => interceptor.name);
  const onResult = opts.onResult;

  return {
    interceptorNames,

    async dispatch(input): Promise<string> {
      const call = input.call;
      const scope: ToolCallScope = input.scope ?? {};
      const state: ToolDispatch = {
        call,
        scope,
        content: "",
        executed: false,
        fromCache: false,
        replayed: false,
        inputBytes: 0,
        bodySignal: call.signal ?? NEVER_ABORT_SIGNAL,
      };
      const startedAt = Date.now();

      // Contract 9: settle the channel's raw-body deferred when the body never
      // runs. Contained like `onResult`: a throwing hook must not break the
      // dispatch. `settleRaw` is idempotent downstream, so this may be called
      // more than once (the terminal's early release plus the dispatch-level
      // backstop in `finally`).
      const notifyBodySkipped = (): void => {
        try {
          state.scope.onBodySkipped?.();
        } catch (error) {
          logger.warn("[tools/pipeline] onBodySkipped hook threw; dispatch continues:", error);
        }
      };

      const runAt = async (index: number): Promise<void> => {
        if (index >= interceptors.length) {
          // Contract 4/4a: the terminal is only reached when every registered
          // interceptor was entered (each called `next()`), so a short-circuit
          // never gets here and no `beforeBody` runs. Hooks run in registration
          // order; only after they all return is `executed` set and the body
          // invoked, so a throw here aborts with `executed` still `false`.
          try {
            for (const interceptor of interceptors) {
              interceptor.beforeBody?.(state);
            }
          } catch (error) {
            // The body will not run: release the channel's raw deferred NOW,
            // before the error unwinds out through `budget`, so a body-skipped
            // dispatch does not transiently quarantine the plugin while its
            // `finally` still sees an unsettled raw body (finding m3).
            notifyBodySkipped();
            throw error;
          }
          state.executed = true;
          state.content = await input.bodies[call.source](state, state.bodySignal);
          return;
        }
        const interceptor = interceptors[index]!;
        let nextCalled = false;
        const next = (signal?: AbortSignal): Promise<void> => {
          if (nextCalled) {
            throw new Error(
              `ToolInterceptor '${interceptor.name}' called next() more than once during one dispatch`,
            );
          }
          nextCalled = true;
          if (signal !== undefined) {
            state.bodySignal = AbortSignal.any([state.bodySignal, signal]);
          }
          return runAt(index + 1);
        };
        await interceptor.around(state, next);
      };

      let thrown: unknown;
      try {
        await runAt(0);
      } catch (error) {
        thrown = error;
      } finally {
        // Contract 9: a dispatch that never reached the body gets exactly one
        // chance to settle the channel's raw-body deferred. Contained like
        // `onResult`: a throwing hook must not break the dispatch. This is the
        // idempotent backstop; the terminal and `execution` fire it earlier (as
        // soon as the engine knows the body will not run) so `budget` releases
        // rather than transiently quarantining (finding m3).
        if (!state.executed) notifyBodySkipped();
        // Contract 6: apply the DEFAULT-cap bound post-onion so executed calls,
        // cache hits and replay hits all match production (`runner.ts:949,968,980`).
        // The guard keeps a misbehaving body that resolves a non-string from
        // making `boundToolResult`/`Buffer.byteLength` throw inside `finally`.
        const content =
          typeof state.content === "string"
            ? state.content
            : String(state.content ?? "");
        state.content = boundToolResult(content);
        // Contract 8: a denial can be signalled by setting `dispatch.errorCode`
        // and returning (no throw); otherwise the code rides the thrown error.
        // A stale `dispatch.errorCode` must NOT mask a thrown error's own code,
        // so it is honoured only on the true short-circuit path.
        const errorCode =
          thrown === undefined ? state.errorCode : errorCodeFor(thrown);
        const denied = errorCode !== undefined;
        const result: ToolCallResult = {
          ok: thrown === undefined && !denied,
          content: state.content,
          outcome:
            thrown === undefined
              ? denied
                ? errorCode === "tool_timeout"
                  ? "timeout"
                  : "error"
                : "ok"
              : classifyOutcome(thrown, state),
          ...(errorCode === undefined ? {} : { errorCode }),
          durationMs: Math.max(0, Date.now() - startedAt),
          inputBytes: state.inputBytes,
          outputBytes: Buffer.byteLength(state.content, "utf8"),
          fromCache: state.fromCache,
          replayed: state.replayed,
        };
        if (onResult) {
          try {
            onResult(state, result);
          } catch (error) {
            logger.warn("[tools/pipeline] onResult sink threw; dispatch continues:", error);
          }
        }
      }
      if (thrown !== undefined) throw thrown;
      return state.content;
    },

    dispose(): void {
      // Registrations are constructor-supplied and unwound by the composition
      // root today; nothing is registered at runtime yet (§3.2).
    },
  };
}
