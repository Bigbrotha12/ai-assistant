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

export class BudgetExhaustedError extends Error {
  readonly code = "budget_exhausted";

  constructor(readonly retryAfterSeconds: number, readonly resetAt: number) {
    super("LLM call budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export type BudgetManager = {
  reserveSync(owner: string): SyncReservation;
  reserveAsync(owner: string): Promise<AsyncReservation>;
  activeCount(owner: string): number;
  reserveModelCall(owner: string, kind?: ModelCallKind): ModelCallReservation;
  beforeModelCall(owner: string, kind?: ModelCallKind): void;
  modelCallCount(owner: string): number;
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

type OwnerState = {
  active: number;
  /** FIFO of parked async reservations awaiting a free slot. */
  parked: Array<{ slot: Slot; timer: unknown; resolve: (r: AsyncReservation) => void }>;
};

/** A granted or in-flight slot; `active` flips on promotion from the queue. */
type Slot = { active: boolean };

export function createBudgetManager(opts: BudgetManagerOptions = {}): BudgetManager {
  const maxConcurrentPerUser = opts.maxConcurrentPerUser ?? DEFAULT_MAX_CONCURRENT;
  const queueMaxPerUser = opts.queueMaxPerUser ?? DEFAULT_QUEUE_MAX;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
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

  const ensureState = (owner: string): OwnerState => {
    let st = records.get(owner);
    if (!st) {
      st = { active: 0, parked: [] };
      records.set(owner, st);
    }
    return st;
  };

  const maybeCleanup = (owner: string, st: OwnerState): void => {
    if (st.active === 0 && st.parked.length === 0) records.delete(owner);
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