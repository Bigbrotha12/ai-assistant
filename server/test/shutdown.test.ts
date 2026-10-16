import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cleanupAsync,
  createShutdownBudget,
  SHUTDOWN_TEARDOWN_BUDGET_MS,
} from "../src/shutdown.ts";

/**
 * Tests for the bounded, awaitable shutdown teardown seam
 * (`src/shutdown.ts`), the Pattern 4 obligation ("dispose must reach
 * quiescence, not just request it") applied to gateway shutdown.
 *
 * The seam is extracted out of `index.ts` module scope precisely so the
 * bounded-await behaviour is testable without booting the gateway: `index.ts`
 * starts servers and opens databases at import time.
 *
 * These tests verify:
 *  - a disposer returning a promise is genuinely awaited;
 *  - a sync throw or async rejection is logged and contained — it must neither
 *    reject `cleanupAsync` nor abort remaining shutdown steps;
 *  - the await is bounded: a wedged disposer cannot hang shutdown;
 *  - the deadline is ONE shared budget per shutdown: sequential disposers draw
 *    down the same absolute deadline instead of each getting a fresh window;
 *  - a disposer arriving with only a small slice of budget left still times
 *    out and is contained;
 *  - a disposer that settles AFTER the deadline is still logged (its promise is
 *    never dropped on the floor where a rejection could go unhandled).
 */

/** All captured console.error lines across the current test's capture block. */
const captureAll: string[] = [];

/** Capture `console.error` output for the duration of `body` (also appends to captureAll). */
async function captureErrors(
  body: () => Promise<void>,
): Promise<{ logs: string[] }> {
  const logs: string[] = captureAll;
  const original = console.error;
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = capture;
  try {
    await body();
  } finally {
    console.error = original;
  }
  return { logs };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("cleanupAsync (bounded awaitable dispose seam)", () => {
  test("runs a synchronous disposer and resolves", async () => {
    let ran = false;
    await cleanupAsync("sync-ok", () => {
      ran = true;
    }, createShutdownBudget());
    assert.equal(ran, true);
  });

  test("awaits a disposer that returns a promise to completion", async () => {
    let done = false;
    await cleanupAsync("async-ok", async () => {
      await sleep(20);
      done = true;
    }, createShutdownBudget());
    // The seam must reach quiescence: when cleanupAsync resolves, the async
    // disposer body has actually finished, not merely been requested.
    assert.equal(done, true);
  });

  test("a synchronous throw is logged and does not reject", async () => {
    const { logs } = await captureErrors(() =>
      cleanupAsync("sync-throw", () => {
        throw new Error("boom");
      }, createShutdownBudget()),
    );
    assert.ok(
      logs.some((l) => l.includes("sync-throw") && l.includes("cleanup failed")),
      `expected a failure log, got: ${JSON.stringify(logs)}`,
    );
  });

  test("an async rejection is logged and does not reject cleanupAsync", async () => {
    const { logs } = await captureErrors(() =>
      cleanupAsync("async-reject", async () => {
        await sleep(5);
        throw new Error("late boom");
      }, createShutdownBudget()),
    );
    assert.ok(
      logs.some((l) => l.includes("async-reject") && l.includes("cleanup failed")),
      `expected a failure log, got: ${JSON.stringify(logs)}`,
    );
  });

  test("a rejecting disposer does not abort the remaining shutdown steps", async () => {
    // The composition pattern used by index.ts: sequential awaits under ONE
    // shared budget, each never rejecting. One bad disposer must not prevent
    // the rest from running.
    const order: string[] = [];
    await captureErrors(async () => {
      const budget = createShutdownBudget();
      await cleanupAsync("bad", () => Promise.reject(new Error("nope")), budget);
      await cleanupAsync("after-1", () => {
        order.push("after-1");
      }, budget);
      await cleanupAsync("after-2", async () => {
        await sleep(5);
        order.push("after-2");
      }, budget);
    });
    assert.deepEqual(order, ["after-1", "after-2"]);
  });

  test("a wedged disposer is bounded by the deadline, not awaited forever", async () => {
    const started = Date.now();
    const { logs } = await captureErrors(() =>
      cleanupAsync(
        "wedged",
        () => new Promise<void>(() => {}), // never settles
        createShutdownBudget(50),
      ),
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 2_000,
      `cleanupAsync must return promptly on timeout, took ${elapsed}ms`,
    );
    assert.ok(
      logs.some((l) => l.includes("wedged") && l.includes("timed out")),
      `expected a timeout log, got: ${JSON.stringify(logs)}`,
    );
  });

  test("sequential disposers SHARE one budget, not one fresh deadline each", async () => {
    // One shutdown budget, three wedged disposers in sequence — the composition
    // pattern in index.ts's shutdown(). If each disposer drew a fresh full
    // window this would take >= 3 x 400ms; sharing one absolute deadline it
    // takes ~400ms total, because each disposer only gets what is LEFT.
    const budget = createShutdownBudget(400);
    const started = Date.now();
    const { logs } = await captureErrors(async () => {
      await cleanupAsync("wedge-1", () => new Promise<void>(() => {}), budget);
      await cleanupAsync("wedge-2", () => new Promise<void>(() => {}), budget);
      await cleanupAsync("wedge-3", () => new Promise<void>(() => {}), budget);
    });
    const elapsed = Date.now() - started;

    // All three are still logged and contained.
    for (const name of ["wedge-1", "wedge-2", "wedge-3"]) {
      assert.ok(
        logs.some((l) => l.includes(name) && l.includes("timed out")),
        `expected a timeout log for ${name}, got: ${JSON.stringify(logs)}`,
      );
    }
    // Bounded by ONE budget (400ms), not three (1200ms). Generous margins both
    // ways so timer jitter cannot flip the verdict.
    assert.ok(
      elapsed < 900,
      `three wedged disposers must share one 400ms budget, took ${elapsed}ms`,
    );
    // Each disposer was granted only the remainder: the grants never exceed
    // the budget and draw it down (first grant is the full window, later ones
    // are near zero because the first wedge consumed it). Scope the parse to
    // this test's disposer names — `captureAll` accumulates across tests.
    const grants = logs
      .map((l) => /wedge-[123] cleanup timed out after (\d+)ms/.exec(l)?.[1])
      .filter((m): m is string => m !== undefined)
      .map(Number);
    assert.equal(grants.length, 3, `expected 3 grants, got ${grants}`);
    for (const grant of grants) {
      assert.ok(grant <= 400, `grant ${grant} exceeds the shared budget`);
    }
    const firstGrant = grants.at(0);
    const thirdGrant = grants.at(2);
    assert.ok(firstGrant !== undefined, `expected a first grant, got ${grants}`);
    assert.ok(thirdGrant !== undefined, `expected a third grant, got ${grants}`);
    assert.ok(
      firstGrant > thirdGrant,
      `grants must draw down the shared budget, got ${grants}`,
    );
    assert.equal(budget.remainingMs(), 0);
  });

  test("a disposer with only a small remaining budget still times out and is contained", async () => {
    // Burn most of the budget first, as earlier disposers would in a real
    // teardown: the next disposer gets the small remainder — it must still be
    // bounded by THAT, not a fresh window, and the disposer after it must
    // still run.
    const budget = createShutdownBudget(200);
    await sleep(150); // leaves ~50ms
    let afterRan = false;
    const started = Date.now();
    const { logs } = await captureErrors(async () => {
      await cleanupAsync("small-grant", () => new Promise<void>(() => {}), budget);
      await cleanupAsync("after-small", () => {
        afterRan = true;
      }, budget);
    });
    const elapsed = Date.now() - started;

    assert.ok(
      logs.some((l) => l.includes("small-grant") && l.includes("timed out")),
      `expected a timeout log, got: ${JSON.stringify(logs)}`,
    );
    const grant = Number(
      /small-grant cleanup timed out after (\d+)ms/
        .exec(logs.join("\n"))?.[1],
    );
    assert.ok(
      Number.isFinite(grant) && grant < 150,
      `disposer must get only the remaining budget (<150ms), got ${grant}ms`,
    );
    assert.ok(
      elapsed < 1_000,
      `small remaining budget must still bound the disposer, took ${elapsed}ms`,
    );
    assert.equal(afterRan, true, "the remaining steps must still run");
  });

  test("a disposer settling after the deadline is still observed and logged", async () => {
    // Capture a late rejection explicitly: the seam must attach a handler so
    // this never becomes an unhandledRejection (which would crash Node).
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    try {
      // Everything runs inside one capture block: the late settle logs through
      // the same console.error the seam captured its handler against.
      await captureErrors(async () => {
        // Case 1: late rejection.
        const d1 = deferred();
        await cleanupAsync("late-fail", () => d1.promise, createShutdownBudget(20));
        d1.reject(new Error("rejected after timeout"));
        await sleep(30);

        // Case 2: late success.
        const d2 = deferred();
        await cleanupAsync("late-ok", () => d2.promise, createShutdownBudget(20));
        d2.resolve();
        await sleep(30);
      });

      assert.ok(
        captureAll.some(
          (l) => l.includes("late-fail") && l.includes("timed out"),
        ),
        `expected a timeout log, got: ${JSON.stringify(captureAll)}`,
      );
      assert.ok(
        captureAll.some(
          (l) =>
            l.includes("late-fail") &&
            l.includes("failed after shutdown moved on"),
        ),
        `expected a late-failure log, got: ${JSON.stringify(captureAll)}`,
      );
      assert.ok(
        captureAll.some(
          (l) =>
            l.includes("late-ok") && l.includes("settled after shutdown moved on"),
        ),
        `expected a late-success log, got: ${JSON.stringify(captureAll)}`,
      );
      assert.deepEqual(unhandled, [], "a late rejection must not go unhandled");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("shared teardown budget constant is exported and sane", () => {
    // The single shared budget replaces the old 5s-per-disposer windows whose
    // additive worst case (6 x 5s + the 2s sentinel flush = 32s) exceeded the
    // container grace period. Keep this number in sync with the arithmetic in
    // `src/shutdown.ts` and the `terminationGracePeriodSeconds` pin in
    // `deploy/k8s/health-probes.yaml` (budget 15s + flush 2s = 17s worst-case
    // teardown; pinned grace 45s gives 28s of headroom). A silent change here
    // changes total worst-case shutdown latency.
    assert.equal(SHUTDOWN_TEARDOWN_BUDGET_MS, 15_000);
    // Sanity: the whole teardown budget plus the sentinel flush must stay well
    // below the pinned 45s grace period.
    assert.ok(SHUTDOWN_TEARDOWN_BUDGET_MS + 2_000 < 45_000);
  });
});
