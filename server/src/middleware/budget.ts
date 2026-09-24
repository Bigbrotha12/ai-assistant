import { emitPluginToolAudit } from "../audit/telemetry.ts";

/**
 * Per-user concurrency budget (Phase 4, Wave A middleware).
 *
 * A single in-memory pool per owner caps how many in-flight operations a user
 * may have at once — SYNC SSE streams and ASYNC background jobs share the SAME
 * per-owner pool (`activeCount`). This gate is deliberately independent of the
 * idempotency ledger: `getOrCreateTask`'s (owner, messageId) dedupe (guarded
 * elsewhere) is what prevents double-admitting one message; the budget only
 * caps concurrency and reports whether the request had to queue.
 *
 * API:
 *   - `reserveSync(owner)` — the sync SSE path. No queue: a full pool is an
 *     immediate `{ ok: false }` -> 429 + `Retry-After` (keep it simple).
 *   - `reserveAsync(owner)` — the async background path. A full pool PARKS the
 *     request in the owner's bounded FIFO queue; an admitted-queued
 *     reservation reports `queued: true`. The queue is bounded by
 *     `queueMaxPerUser` — a full queue is an immediate `{ ok: false }` ->
 *     503 + `Retry-After`. A parked admission waits UP TO `waitMs` for a free
 *     slot, then fails `{ ok: false }` instead of hanging the HTTP request on
 *     a saturated pool.
 *   - `release()` — idempotent and correct on double-call (safe for the
 *     transport's cancel-after-end path).
 *   - `activeCount(owner)` — live in-flight counter (queued waiters are NOT
 *     active).
 *
 * `waitMs`/`setTimeout`/`clearTimeout` are injectable (the same seam style as
 * `JobRunnerDeps` in `jobs/runner.ts`): the parked-queue timeout is driven
 * through them so tests can control time deterministically.
 *
 * Single-instance only: state is in-memory and does not survive restarts or
 * scale across processes (same constraint as the token bucket and the
 * credential pin store). `maxConcurrentPerUser` (default 2) and
 * `queueMaxPerUser` (default 3) are wired from BUDGET_MAX_CONCURRENT /
 * BUDGET_QUEUE_MAX at boot (`index.ts`).
 */
export type SyncReservation =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number };

export type AsyncReservation =
  | { ok: true; release: () => void; queued: boolean }
  | { ok: false; retryAfterSeconds: number };

export type ModelCallKind = "sync" | "async" | "vision" | "compaction" | "warmup";

export type ModelCallReservation =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; code: "budget_exhausted"; retryAfterSeconds: number; resetAt: number };

export const DEFAULT_MAX_TOOL_CALLS_PER_OWNER = 4;
export const DEFAULT_MAX_TOOL_CALLS_PER_PLUGIN = 4;
export const DEFAULT_MAX_TOOL_CALLS_GLOBAL = 16;
export const DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN = 8;
export const DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW = 20;
export const DEFAULT_TOOL_CALL_RATE_WINDOW_MS = 60_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_TOOL_CALL_QUARANTINE_MS = 5 * 60_000;

export class BudgetExhaustedError extends Error {
  readonly code = "budget_exhausted";

  constructor(
    readonly retryAfterSeconds: number,
    readonly resetAt: number,
    message = "LLM call budget exhausted",
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export type ToolCallBudgetOptions = {
  requestId?: string;
  tool?: string;
  timeoutMs?: number;
  rawSettled?: Promise<void>;
};

export type BudgetManager = {
  reserveSync(owner: string): SyncReservation;
  reserveAsync(owner: string): Promise<AsyncReservation>;
  activeCount(owner: string): number;
  reserveModelCall(owner: string, kind?: ModelCallKind): ModelCallReservation;
  beforeModelCall(owner: string, kind?: ModelCallKind): void;
  modelCallCount(owner: string): number;
  withToolCallBudget<T>(owner: string, run: () => Promise<T>): Promise<T>;
  withToolCallBudget<T>(owner: string, pluginId: string, run: () => Promise<T>): Promise<T>;
  withToolCallBudget<T>(
    owner: string,
    pluginId: string,
    run: () => Promise<T>,
    options?: ToolCallBudgetOptions,
  ): Promise<T>;
  toolCallCount(owner: string, pluginId?: string): number;
  pluginToolCallCount(pluginId: string): number;
  globalToolCallCount(): number;
};

export type BudgetSetTimeout = (handler: () => void, timeout?: number) => unknown;
export type BudgetClearTimeout = (handle: unknown) => void;

export type BudgetManagerOptions = {
  maxModelCallsPerWindow?: number;
  modelCallWindowMs?: number;
  now?: () => number;
  /** In-flight cap per owner (sync streams + async jobs share the pool). Default 2. */
  maxConcurrentPerUser?: number;
  /** How many async reservations may wait (per owner) before rejection. Default 3. */
  queueMaxPerUser?: number;
  /** Max time a parked async reservation waits for a slot (ms). Default 10_000. */
  waitMs?: number;
  maxToolCallsPerOwner?: number;
  maxToolCallsPerPlugin?: number;
  maxGlobalToolCalls?: number;
  maxToolCallsPerOwnerPluginPerTurn?: number;
  maxToolCallsPerOwnerPluginPerWindow?: number;
  toolCallRateWindowMs?: number;
  toolCallTimeoutMs?: number;
  toolCallQuarantineMs?: number;
  /** Test seam; defaults to the global `setTimeout`. */
  setTimeout?: BudgetSetTimeout;
  /** Test seam; defaults to the global `clearTimeout`. */
  clearTimeout?: BudgetClearTimeout;
};

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_QUEUE_MAX = 3;
const DEFAULT_WAIT_MS = 10_000;
export const DEFAULT_MODEL_CALL_LIMIT = 60;
export const DEFAULT_MODEL_CALL_WINDOW_MS = 60_000;

type PluginCallWindow = {
  count: number;
  resetAt: number;
  turnCounts: Map<string, number>;
};

type OwnerState = {
  active: number;
  toolActive: number;
  /** FIFO of parked async reservations awaiting a free slot. */
  parked: Array<{ slot: Slot; timer: unknown; resolve: (r: AsyncReservation) => void }>;
};

/** A granted or in-flight slot; `active` flips on promotion from the queue. */
type Slot = { active: boolean };

export function createBudgetManager(opts: BudgetManagerOptions = {}): BudgetManager {
  const maxConcurrentPerUser = opts.maxConcurrentPerUser ?? DEFAULT_MAX_CONCURRENT;
  const queueMaxPerUser = opts.queueMaxPerUser ?? DEFAULT_QUEUE_MAX;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const maxToolCallsPerOwner =
    opts.maxToolCallsPerOwner ?? DEFAULT_MAX_TOOL_CALLS_PER_OWNER;
  const maxToolCallsPerPlugin =
    opts.maxToolCallsPerPlugin ?? DEFAULT_MAX_TOOL_CALLS_PER_PLUGIN;
  const maxGlobalToolCalls =
    opts.maxGlobalToolCalls ?? DEFAULT_MAX_TOOL_CALLS_GLOBAL;
  const maxToolCallsPerOwnerPluginPerTurn =
    opts.maxToolCallsPerOwnerPluginPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN;
  const maxToolCallsPerOwnerPluginPerWindow =
    opts.maxToolCallsPerOwnerPluginPerWindow ?? DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW;
  const toolCallRateWindowMs =
    opts.toolCallRateWindowMs ?? DEFAULT_TOOL_CALL_RATE_WINDOW_MS;
  const toolCallTimeoutMs =
    opts.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const toolCallQuarantineMs =
    opts.toolCallQuarantineMs ?? DEFAULT_TOOL_CALL_QUARANTINE_MS;
  for (const [name, value] of Object.entries({
    maxToolCallsPerOwner,
    maxToolCallsPerPlugin,
    maxGlobalToolCalls,
    maxToolCallsPerOwnerPluginPerTurn,
    maxToolCallsPerOwnerPluginPerWindow,
    toolCallRateWindowMs,
    toolCallTimeoutMs,
    toolCallQuarantineMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`createBudgetManager: ${name} must be a positive safe integer`);
    }
  }
  const setTimeoutFn: BudgetSetTimeout =
    opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn: BudgetClearTimeout =
    opts.clearTimeout ??
    ((handle: unknown): void => {
      globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
    });
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));

  const maxModelCalls = opts.maxModelCallsPerWindow ?? DEFAULT_MODEL_CALL_LIMIT;
  const windowMs = opts.modelCallWindowMs ?? DEFAULT_MODEL_CALL_WINDOW_MS;
  for (const [name, value] of Object.entries({ maxModelCalls, windowMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`createBudgetManager: ${name} must be a positive safe integer`);
    }
  }
  const now = opts.now ?? Date.now;
  const calls = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  const currentCalls = (owner: string) => {
    const time = now();
    if (time >= nextSweep) {
      for (const [key, value] of calls) {
        if (time >= value.resetAt) calls.delete(key);
      }
      nextSweep = time + windowMs;
    }
    const entry = calls.get(owner);
    if (entry && time >= entry.resetAt) {
      calls.delete(owner);
      return undefined;
    }
    return entry;
  };
  const reserveModelCall = (
    owner: string,
    _kind: ModelCallKind = "sync",
  ): ModelCallReservation => {
    if (!owner.trim()) throw new Error("Model call budget requires an owner");
    let entry = currentCalls(owner);
    if (!entry) {
      entry = { count: 0, resetAt: now() + windowMs };
      calls.set(owner, entry);
    }
    if (entry.count >= maxModelCalls) {
      return {
        ok: false,
        code: "budget_exhausted",
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)),
        resetAt: entry.resetAt,
      };
    }
    entry.count += 1;
    return { ok: true, remaining: maxModelCalls - entry.count, resetAt: entry.resetAt };
  };

  const records = new Map<string, OwnerState>();
  const pluginToolActive = new Map<string, number>();
  const pluginQuarantines = new Map<string, number>();
  const pluginCallWindows = new Map<string, PluginCallWindow>();
  let globalToolActive = 0;
  let nextToolSweep = 0;

  const currentPluginWindow = (owner: string, pluginId: string): PluginCallWindow => {
    const time = now();
    if (time >= nextToolSweep) {
      for (const [key, entry] of pluginCallWindows) {
        if (time >= entry.resetAt) pluginCallWindows.delete(key);
      }
      nextToolSweep = time + toolCallRateWindowMs;
    }
    const key = `${owner}\u0000${pluginId}`;
    let entry = pluginCallWindows.get(key);
    if (!entry || time >= entry.resetAt) {
      entry = { count: 0, resetAt: time + toolCallRateWindowMs, turnCounts: new Map() };
      pluginCallWindows.set(key, entry);
    }
    return entry;
  };

  const ensureState = (owner: string): OwnerState => {
    let st = records.get(owner);
    if (!st) {
      st = { active: 0, toolActive: 0, parked: [] };
      records.set(owner, st);
    }
    return st;
  };

  const maybeCleanup = (owner: string, st: OwnerState): void => {
    if (st.active === 0 && st.toolActive === 0 && st.parked.length === 0) records.delete(owner);
  };

  const removeParked = (st: OwnerState, entry: OwnerState["parked"][number]): void => {
    const idx = st.parked.indexOf(entry);
    if (idx >= 0) st.parked.splice(idx, 1);
  };

  const promoteNext = (owner: string, st: OwnerState): void => {
    while (st.active < maxConcurrentPerUser && st.parked.length > 0) {
      const entry = st.parked.shift()!;
      if (entry.timer !== null) clearTimeoutFn(entry.timer);
      entry.slot.active = true;
      st.active += 1;
      entry.resolve({
        ok: true,
        queued: true,
        release: makeRelease(owner, st, entry.slot),
      });
    }
  };

  const makeRelease = (owner: string, st: OwnerState, slot: Slot): (() => void) => {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      if (slot.active) {
        slot.active = false;
        st.active -= 1;
        promoteNext(owner, st);
      }
      maybeCleanup(owner, st);
    };
  };

  const timeoutParked = (
    owner: string,
    st: OwnerState,
    entry: OwnerState["parked"][number],
  ): void => {
    removeParked(st, entry);
    entry.resolve({ ok: false, retryAfterSeconds });
    maybeCleanup(owner, st);
  };

  const park = (
    owner: string,
    st: OwnerState,
  ): Promise<AsyncReservation> => {
    const entry: OwnerState["parked"][number] = {
      slot: { active: false },
      timer: null,
      resolve: () => {},
    };
    entry.timer = setTimeoutFn(() => timeoutParked(owner, st, entry), waitMs);
    return new Promise<AsyncReservation>((resolve) => {
      entry.resolve = resolve;
      st.parked.push(entry);
    });
  };

  return {
    reserveModelCall,
    beforeModelCall(owner, kind) {
      const reservation = reserveModelCall(owner, kind);
      if (!reservation.ok) {
        throw new BudgetExhaustedError(reservation.retryAfterSeconds, reservation.resetAt);
      }
    },
    modelCallCount(owner) {
      return currentCalls(owner)?.count ?? 0;
    },
    async withToolCallBudget<T>(
      owner: string,
      pluginIdOrRun: string | (() => Promise<T>),
      maybeRun?: (() => Promise<T>) | ToolCallBudgetOptions,
      maybeOptions?: ToolCallBudgetOptions,
    ): Promise<T> {
      if (!owner.trim()) throw new Error("Tool call budget requires an owner");
      const pluginId = typeof pluginIdOrRun === "string" ? pluginIdOrRun.trim() : undefined;
      if (pluginId !== undefined && pluginId === "") {
        throw new Error("Tool call budget requires a non-empty plugin id");
      }
      const run = typeof pluginIdOrRun === "function" ? pluginIdOrRun : maybeRun;
      if (typeof run !== "function") throw new TypeError("Tool call budget requires a run function");
      const options = typeof maybeRun === "function" ? maybeOptions : maybeRun;
      if (options !== undefined && typeof options !== "object") {
        throw new TypeError("Tool call budget options must be an object");
      }
      const operationTimeoutMs = options?.timeoutMs ?? toolCallTimeoutMs;
      if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
        throw new RangeError("Tool call timeout must be a positive safe integer");
      }
      const st = ensureState(owner);
      const pluginActive = pluginId === undefined ? 0 : pluginToolActive.get(pluginId) ?? 0;
      if (pluginId !== undefined && (pluginQuarantines.get(pluginId) ?? 0) > 0) {
        maybeCleanup(owner, st);
        throw new BudgetExhaustedError(
          1,
          now() + 1_000,
          `Tool handler for plugin '${pluginId}' is quarantined after an unsettled timeout`,
        );
      }
      if (
        st.toolActive >= maxToolCallsPerOwner ||
        (pluginId !== undefined && pluginActive >= maxToolCallsPerPlugin) ||
        globalToolActive >= maxGlobalToolCalls
      ) {
        maybeCleanup(owner, st);
        throw new BudgetExhaustedError(
          1,
          now() + 1_000,
          pluginId === undefined || pluginActive < maxToolCallsPerPlugin
            ? "Tool call concurrency budget exhausted"
            : `Tool call concurrency budget exhausted for plugin '${pluginId}'`,
        );
      }
      const requestId = options?.requestId?.trim() || undefined;
      const turnKey = requestId === undefined
        ? undefined
        : JSON.stringify([requestId, options?.tool ?? ""]);
      const pluginWindow = pluginId === undefined
        ? undefined
        : currentPluginWindow(owner, pluginId);
      const turnCalls = pluginWindow === undefined || turnKey === undefined
        ? 0
        : pluginWindow.turnCounts.get(turnKey) ?? 0;
      if (pluginWindow !== undefined &&
          (turnCalls >= maxToolCallsPerOwnerPluginPerTurn ||
           pluginWindow.count >= maxToolCallsPerOwnerPluginPerWindow)) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((pluginWindow.resetAt - now()) / 1000),
        );
        throw new BudgetExhaustedError(
          retryAfterSeconds,
          pluginWindow.resetAt,
          turnCalls >= maxToolCallsPerOwnerPluginPerTurn
            ? `Tool call rate budget exhausted for plugin '${pluginId}' in this turn`
            : `Tool call rate budget exhausted for plugin '${pluginId}' in this window`,
        );
      }
      st.toolActive += 1;
      globalToolActive += 1;
      if (pluginId !== undefined) pluginToolActive.set(pluginId, pluginActive + 1);
      if (pluginWindow !== undefined) {
        pluginWindow.count += 1;
        if (turnKey !== undefined) {
          pluginWindow.turnCounts.set(turnKey, turnCalls + 1);
        }
      }
      let released = false;
      let quarantineBegun = false;
      let quarantineTimer: unknown;
      let forceTimer: unknown;
      let forceTelemetryEmitted = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (quarantineTimer !== undefined) {
          clearTimeoutFn(quarantineTimer);
          quarantineTimer = undefined;
        }
        if (forceTimer !== undefined) {
          clearTimeoutFn(forceTimer);
          forceTimer = undefined;
        }
        if (quarantineBegun && pluginId !== undefined) {
          const remaining = (pluginQuarantines.get(pluginId) ?? 1) - 1;
          if (remaining <= 0) pluginQuarantines.delete(pluginId);
          else pluginQuarantines.set(pluginId, remaining);
        }
        st.toolActive -= 1;
        globalToolActive -= 1;
        if (pluginId !== undefined) {
          const remaining = (pluginToolActive.get(pluginId) ?? 1) - 1;
          if (remaining <= 0) pluginToolActive.delete(pluginId);
          else pluginToolActive.set(pluginId, remaining);
        }
        maybeCleanup(owner, st);
      };
      const emitForceRelease = (): void => {
        if (forceTelemetryEmitted) return;
        forceTelemetryEmitted = true;
        emitPluginToolAudit({
          owner,
          ...(pluginId === undefined ? {} : { pluginId }),
          ...(options?.tool === undefined ? {} : { tool: options.tool }),
          requestId,
          outcome: "error",
          errorCode: "tool_quarantine_forced",
        });
      };
      const forceRelease = (): void => {
        release();
        emitForceRelease();
      };
      const beginQuarantine = (): void => {
        if (released || quarantineBegun) return;
        quarantineBegun = true;
        if (quarantineTimer !== undefined) {
          clearTimeoutFn(quarantineTimer);
          quarantineTimer = undefined;
        }
        if (pluginId !== undefined) {
          pluginQuarantines.set(pluginId, (pluginQuarantines.get(pluginId) ?? 0) + 1);
        }
        forceTimer = setTimeoutFn(forceRelease, toolCallQuarantineMs);
        if (typeof (forceTimer as { unref?: () => void }).unref === "function") {
          (forceTimer as { unref: () => void }).unref();
        }
      };
      quarantineTimer = setTimeoutFn(beginQuarantine, operationTimeoutMs);
      if (typeof (quarantineTimer as { unref?: () => void }).unref === "function") {
        (quarantineTimer as { unref: () => void }).unref();
      }
      const rawSettled = options?.rawSettled;
      let rawDidSettle = false;
      if (rawSettled !== undefined) {
        void rawSettled.then(() => { rawDidSettle = true; });
      }
      let failure: unknown;
      try {
        return await run();
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const timedOut = typeof failure === "object" && failure !== null &&
          "code" in failure && failure.code === "tool_timeout";
        if (rawDidSettle || (rawSettled === undefined && !timedOut)) {
          release();
        } else {
          beginQuarantine();
          if (rawSettled !== undefined) {
            void rawSettled.then(release);
          }
        }
      }
    },
    toolCallCount(owner, pluginId) {
      if (pluginId !== undefined) return pluginToolActive.get(pluginId) ?? 0;
      return records.get(owner)?.toolActive ?? 0;
    },
    pluginToolCallCount(pluginId) {
      return pluginToolActive.get(pluginId) ?? 0;
    },
    globalToolCallCount() {
      return globalToolActive;
    },
    reserveSync(owner: string): SyncReservation {
      const st = ensureState(owner);
      if (st.active < maxConcurrentPerUser) {
        st.active += 1;
        return { ok: true, release: makeRelease(owner, st, { active: true }) };
      }
      return { ok: false, retryAfterSeconds };
    },

    reserveAsync(owner: string): Promise<AsyncReservation> {
      const st = ensureState(owner);
      if (st.active < maxConcurrentPerUser) {
        st.active += 1;
        return Promise.resolve({
          ok: true,
          queued: false,
          release: makeRelease(owner, st, { active: true }),
        });
      }
      if (st.parked.length >= queueMaxPerUser) {
        return Promise.resolve({ ok: false, retryAfterSeconds });
      }
      return park(owner, st);
    },

    activeCount(owner: string): number {
      return records.get(owner)?.active ?? 0;
    },
  };
}