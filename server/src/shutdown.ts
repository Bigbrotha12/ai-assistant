/**
 * Bounded, awaitable shutdown teardown seam.
 *
 * Why this is awaitable — do NOT "simplify" it back to a synchronous
 * `() => void` callback. `DEFENSIVE_PATTERNS.md` §4 ("Dispose must reach
 * quiescence, not just request it"): teardown must *await* the work stopping;
 * issuing a close is not the same as being closed. The previous seam typed its
 * disposer `() => void`, so a disposer returning a promise was accepted by the
 * type but its promise was silently dropped — an async rejection escaped the
 * try/catch and shutdown proceeded while teardown was still untracked. The
 * await is the point.
 *
 * Bounded on purpose: shutdown must terminate even if a disposer wedges. On
 * deadline we do NOT abandon the disposer — it keeps settling in the background
 * with its eventual outcome logged (so a late rejection can never surface as an
 * unhandled rejection) while shutdown proceeds with the remaining steps.
 *
 * One shared budget, not one deadline per disposer: the deadline is an
 * absolute instant computed ONCE per shutdown (see {@link ShutdownBudget}) and
 * every disposer receives the *remaining* time. Sequential disposers therefore
 * share a single wall-clock bound instead of each getting a fresh window whose
 * worst cases add up — a fully-wedged teardown must not be able to outlive the
 * container's `terminationGracePeriodSeconds` (see deploy/k8s) and get
 * SIGKILL'd before the sentinel flush and ledger close.
 */

/**
 * Total teardown budget for ONE shutdown run, shared by every disposer in it.
 *
 * The arithmetic this pins (kept in sync with `index.ts` and
 * `deploy/k8s/health-probes.yaml`):
 *  - Six disposers share this budget. `serverClosed`'s 5s request-drain grace
 *    runs concurrently with the first five disposers and is fully absorbed.
 *  - The 2s sentinel shadow flush runs after the budget's deadline has had its
 *    chance at the disposers, so worst-case total shutdown is
 *    BUDGET + flush = 15s + 2s = 17s. (`ledger.close()` is the last disposer
 *    and is bounded by whatever budget remains, so it cannot extend past
 *    BUDGET + flush either.)
 *  - `deploy/k8s/health-probes.yaml` pins `terminationGracePeriodSeconds: 45`
 *    — 28s of headroom over the 17s worst case — so a fully-wedged teardown is
 *    never SIGKILL'd mid-flush.
 *
 * 15s is ~3x the old single-disposer window (5s), which is generous for the
 * current production disposers (all synchronous) with room for future async
 * teardown (e.g. a goal runner) while keeping the total well under the pod
 * grace period.
 */
export const SHUTDOWN_TEARDOWN_BUDGET_MS = 15_000;

/**
 * An absolute, wall-clock teardown deadline shared by every disposer in one
 * shutdown run. Create it ONCE at the start of shutdown and pass the same
 * budget to every `cleanupAsync` call; each disposer then receives only the
 * time still remaining, so total teardown is bounded by one deadline rather
 * than the sum of per-disposer windows.
 */
export interface ShutdownBudget {
  /** Absolute deadline as epoch milliseconds (Date.now() space). */
  readonly deadlineAt: number;
  /** Milliseconds left before the deadline. Never negative. */
  remainingMs(): number;
}

/**
 * Start a teardown budget. `totalMs` defaults to
 * {@link SHUTDOWN_TEARDOWN_BUDGET_MS}; pass a smaller total only in tests or
 * for a teardown flow with a known smaller bound.
 */
export function createShutdownBudget(
  totalMs: number = SHUTDOWN_TEARDOWN_BUDGET_MS,
): ShutdownBudget {
  const deadlineAt = Date.now() + totalMs;
  return {
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
  };
}

const isPromiseLike = (value: void | Promise<void>): value is Promise<void> =>
  typeof value === "object" &&
  value !== null &&
  typeof value.then === "function";

/**
 * Run one shutdown disposer and wait for it to actually finish (Pattern 4).
 *
 * Never throws/rejects: a synchronous throw, an async rejection, or a wedged
 * disposer are all logged and contained so the remaining shutdown steps always
 * run. On timeout the disposer is left settling in the background; its eventual
 * completion or failure is logged when it happens.
 *
 * `budget` is the SHARED shutdown deadline, not a per-disposer timeout: the
 * disposer gets `budget.remainingMs()` — what is left of the one overall
 * deadline — so a sequence of `cleanupAsync` calls under the same budget can
 * never exceed it in aggregate. A disposer that arrives after the deadline has
 * passed still runs (synchronous disposers are cheap and complete instantly)
 * and, if it returns a promise, is immediately timed out and contained.
 */
export async function cleanupAsync(
  name: string,
  dispose: () => void | Promise<void>,
  budget: ShutdownBudget,
): Promise<void> {
  let pending: Promise<void>;
  try {
    const result = dispose();
    if (!isPromiseLike(result)) return;
    pending = Promise.resolve(result);
  } catch (err) {
    console.error(`gateway: ${name} cleanup failed`, err);
    return;
  }

  // Normalize to a never-rejecting promise so every outcome is logged and a
  // rejection can never surface as an unhandled rejection, whichever side of
  // the deadline it lands on (DEFENSIVE_PATTERNS §5).
  const settled = pending.then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  );

  // Whatever is left of the shared deadline — not a fresh window. Zero (or
  // less, clamped) is a legitimate grant: it is exactly the "budget exhausted"
  // case and still routes through the timeout path below so the disposer is
  // contained and its late settle is logged.
  const timeoutMs = budget.remainingMs();

  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline timer is deliberately NOT unref'd: unlike the best-effort
  // races elsewhere in shutdown (server drain, sentinel flush), this await IS
  // the shutdown flow. If a disposer wedges on a handle-less promise and the
  // timer were unref'd, Node could exit before the deadline fires — skipping
  // not just the timeout log but every shutdown step after this one (sentinel
  // flush, ledger close). Holding the loop keeps shutdown alive at most
  // `timeoutMs` past natural completion, which is exactly the bound we want.
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const outcome = await Promise.race([settled, deadline]);
  if (timer !== undefined) clearTimeout(timer);

  if (!("ok" in outcome)) {
    // Deadline first: proceed with shutdown while the disposer keeps settling
    // in the background — abandoning it entirely would drop its teardown work
    // AND lose the log of its eventual outcome.
    console.error(
      `gateway: ${name} cleanup timed out after ${timeoutMs}ms; continuing shutdown while it settles`,
    );
    void settled.then((result) => {
      if (result.ok) {
        console.error(`gateway: ${name} cleanup settled after shutdown moved on`);
      } else {
        console.error(
          `gateway: ${name} cleanup failed after shutdown moved on`,
          result.err,
        );
      }
    });
    return;
  }
  if (!outcome.ok) {
    console.error(`gateway: ${name} cleanup failed`, outcome.err);
  }
}
