import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  createSessionStore,
  estimateSessionBytes,
} from "../../src/sessions/store.ts";
import type { SessionStore } from "../../src/sessions/store.ts";

/**
 * Stateless-gateway session store (plan §4, D2/D3): unit tests.
 * Everything is deterministic: a fake clock + injectable setInterval/clearInterval
 * drive TTL/sweep tests without real timers.
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

/** Store wired to a fake clock with sane defaults. */
function makeStore(
  opts: Parameters<typeof createSessionStore>[0] = {},
): { store: SessionStore; clock: FakeClock } {
  const clock = makeClock();
  const store = createSessionStore({
    idleTtlMs: 24 * 60 * 60 * 1000,
    maxSessionsPerOwner: 32,
    maxSessions: 1000,
    maxSessionBytes: 32_768 * 4,
    maxOutcomesPerSession: 64,
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    ...opts,
  });
  return { store, clock };
}

describe("createSessionStore", () => {
  test("establish seeds a session; delta appends and returns resumed with ordered messages", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    const seeded = await store.establish("alice", "s1", [new HumanMessage("hello")]);
    assert.equal(seeded.status, "established");
    if (seeded.status === "established") assert.equal(seeded.generation, 1);
    assert.equal(store.size, 1);

    const delta = await store.appendDelta("alice", "s1", "mid-1", new HumanMessage("second"));
    assert.equal(delta.status, "resumed");
    if (delta.status === "resumed") assert.equal(delta.generation, 1);

    const messages = store.getMessages("alice", "s1");
    assert.deepEqual(messages?.map((m) => m.content), ["hello", "second"]);
    assert.equal(store.get("alice", "s1")?.outcomes.get("mid-1")?.status, "in_progress");
  });

  test("exactly-once: a completed messageId replays already_completed with the stored reply; no duplicate append", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", []);
    const first = await store.appendDelta("alice", "s1", "m1", new HumanMessage("question"));
    assert.equal(first.status, "resumed");
    await store.markCompleted("alice", "s1", "m1", new AIMessage("answer"));

    const dup = await store.appendDelta("alice", "s1", "m1", new HumanMessage("question"));
    assert.equal(dup.status, "already_completed");
    if (dup.status === "already_completed") {
      assert.equal(dup.reply?.content, "answer");
    }
    assert.equal(store.getMessages("alice", "s1")?.length, 1, "no duplicate append");
  });

  test("retry-on-failed (plan §4 step 6): a failed messageId re-sends as a clean re-run", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    await store.appendDelta("alice", "s1", "m2", new HumanMessage("will fail"));
    await store.markFailed("alice", "s1", "m2");
    assert.deepEqual(store.getMessages("alice", "s1")?.map((m) => m.content), ["base"]);

    const retry = await store.appendDelta("alice", "s1", "m2", new HumanMessage("will fail"));
    assert.equal(retry.status, "resumed");
    assert.equal(store.get("alice", "s1")?.outcomes.get("m2")?.status, "in_progress");
    assert.deepEqual(
      store.getMessages("alice", "s1")?.map((m) => m.content),
      ["base", "will fail"],
      "the user message is re-appended exactly once",
    );
  });

  test("retry-on-failed then completion dedupes to already_completed", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    await store.appendDelta("alice", "s1", "m2", new HumanMessage("q"));
    await store.markFailed("alice", "s1", "m2");

    const retry = await store.appendDelta("alice", "s1", "m2", new HumanMessage("q"));
    assert.equal(retry.status, "resumed");
    await store.markCompleted("alice", "s1", "m2", new AIMessage("answer"));

    const dup = await store.appendDelta("alice", "s1", "m2", new HumanMessage("q"));
    assert.equal(dup.status, "already_completed");
    if (dup.status === "already_completed") {
      assert.equal(dup.reply?.content, "answer");
    }
    assert.equal(store.getMessages("alice", "s1")?.length, 2, "message appended exactly once");
  });

  test("rollback works across retries: fail, retry, fail never accumulates duplicates", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);

    await store.appendDelta("alice", "s1", "m2", new HumanMessage("boom"));
    await store.markFailed("alice", "s1", "m2");
    assert.deepEqual(store.getMessages("alice", "s1")?.map((m) => m.content), ["base"]);

    const retry = await store.appendDelta("alice", "s1", "m2", new HumanMessage("boom"));
    assert.equal(retry.status, "resumed");
    assert.deepEqual(store.getMessages("alice", "s1")?.map((m) => m.content), ["base", "boom"]);

    await store.markFailed("alice", "s1", "m2");
    assert.deepEqual(
      store.getMessages("alice", "s1")?.map((m) => m.content),
      ["base"],
      "second rollback removes the re-appended message, no duplicates",
    );
  });

  test("failure rollback removes the appended message and records failed", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    await store.appendDelta("alice", "s1", "m1", new HumanMessage("boom"));
    assert.equal(store.getMessages("alice", "s1")?.length, 2);

    const res = await store.markFailed("alice", "s1", "m1");
    assert.deepEqual(res, { evicted: false });
    assert.deepEqual(store.getMessages("alice", "s1")?.map((m) => m.content), ["base"]);
    assert.equal(store.get("alice", "s1")?.outcomes.get("m1")?.status, "failed");
  });

  test("markCompleted stores the reply; a later same-messageId delta returns already_completed with it", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("q")]);
    await store.appendDelta("alice", "s1", "m1", new HumanMessage("q"));
    await store.markCompleted("alice", "s1", "m1", new AIMessage("the reply"));

    const rec = store.get("alice", "s1");
    assert.deepEqual(rec?.outcomes.get("m1"), { status: "completed", reply: new AIMessage("the reply") });

    const dup = await store.appendDelta("alice", "s1", "m1", new HumanMessage("q"));
    assert.equal(dup.status, "already_completed");
    if (dup.status === "already_completed") {
      assert.equal(dup.reply?.content, "the reply");
    }
  });

  test("session_missing: never-established returns restart; TTL-evicted returns evicted", async (t) => {
    const { store, clock } = makeStore({ idleTtlMs: 1000, sweepIntervalMs: 1000 });
    t.after(() => store.dispose());

    const miss = await store.appendDelta("alice", "ghost", "m1", new HumanMessage("hi"));
    assert.equal(miss.status, "session_missing");
    if (miss.status === "session_missing") assert.equal(miss.reason, "restart");

    await store.establish("alice", "s1", [new HumanMessage("hello")]);
    clock.advance(1001);
    clock.fireIntervals();
    assert.equal(store.get("alice", "s1"), null, "sweep evicted the idle session");

    const evicted = await store.appendDelta("alice", "s1", "m1", new HumanMessage("hi"));
    assert.equal(evicted.status, "session_missing");
    if (evicted.status === "session_missing") assert.equal(evicted.reason, "evicted");
  });

  test("touch refreshes lastTouchedAt, keeping a session alive across the TTL", async (t) => {
    const { store, clock } = makeStore({ idleTtlMs: 1000, sweepIntervalMs: 1000 });
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("hi")]);
    clock.advance(900);
    store.touch("alice", "s1");
    clock.advance(200); // 1100 since establish, but 200 since the touch
    clock.fireIntervals();
    assert.ok(store.get("alice", "s1"), "touched session survives the TTL sweep");
  });

  test("per-owner cap evicts the owner's oldest session when a new one is established", async (t) => {
    const { store, clock } = makeStore({ maxSessionsPerOwner: 3 });
    t.after(() => store.dispose());

    for (let i = 0; i < 3; i++) {
      await store.establish("alice", `s${i}`, [new HumanMessage(`m${i}`)]);
      clock.advance(10);
    }
    assert.equal(store.size, 3);

    await store.establish("alice", "s3", [new HumanMessage("new")]);
    assert.equal(store.size, 3);
    assert.equal(store.get("alice", "s0"), null, "oldest owner session evicted");
    assert.ok(store.get("alice", "s1") && store.get("alice", "s2") && store.get("alice", "s3"));
  });

  test("global cap evicts the requesting owner's OWN LRU session first (owner-aware)", async (t) => {
    const { store, clock } = makeStore({ maxSessions: 6, maxSessionsPerOwner: 100 });
    t.after(() => store.dispose());

    // bob is globally oldest; alice's sessions are all globally more recent.
    for (const b of ["b0", "b1", "b2"]) {
      await store.establish("bob", b, [new HumanMessage(b)]);
      clock.advance(10);
    }
    for (const a of ["a0", "a1", "a2"]) {
      await store.establish("alice", a, [new HumanMessage(a)]);
      clock.advance(10);
    }
    assert.equal(store.size, 6);

    await store.establish("alice", "a3", [new HumanMessage("a3")]);
    assert.equal(store.size, 6);
    assert.equal(store.get("alice", "a0"), null, "alice's own LRU evicted, not bob's");
    assert.ok(store.get("alice", "a1") && store.get("alice", "a2") && store.get("alice", "a3"));
    for (const b of ["b0", "b1", "b2"]) {
      assert.ok(store.get("bob", b), `bob's ${b} survives`);
    }
  });

  test("global cap with no requesting-owner sessions evicts the globally LRU session", async (t) => {
    const { store, clock } = makeStore({ maxSessions: 4, maxSessionsPerOwner: 100 });
    t.after(() => store.dispose());

    for (let i = 0; i < 4; i++) {
      await store.establish("bob", `b${i}`, [new HumanMessage(`b${i}`)]);
      clock.advance(10);
    }
    assert.equal(store.size, 4);

    await store.establish("alice", "a0", [new HumanMessage("a0")]);
    assert.equal(store.size, 4);
    assert.equal(store.get("bob", "b0"), null, "globally LRU (bob's b0) evicted since alice had none");
    assert.ok(store.get("alice", "a0"));
    for (const b of ["b1", "b2", "b3"]) {
      assert.ok(store.get("bob", b));
    }
  });

  test("byte cap: an over-cap session is evicted (injected tiny cap)", async (t) => {
    const { store } = makeStore({ maxSessionBytes: 50 });
    t.after(() => store.dispose());

    // Establish over the cap → not retained, surfaces as evicted.
    const seed = await store.establish("alice", "s1", [new HumanMessage("x".repeat(100))]);
    assert.equal(seed.status, "session_missing");
    if (seed.status === "session_missing") assert.equal(seed.reason, "evicted");
    assert.equal(store.get("alice", "s1"), null);

    // Delta pushes an under-cap session over the cap → evicted.
    await store.establish("alice", "s2", [new HumanMessage("short")]);
    assert.ok(store.get("alice", "s2"));
    const delta = await store.appendDelta("alice", "s2", "m1", new HumanMessage("y".repeat(100)));
    assert.equal(delta.status, "session_missing");
    assert.equal(store.get("alice", "s2"), null);
  });

  test("estimateSessionBytes counts image content bytes (base64 url length)", () => {
    const image = new HumanMessage({
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100) } },
      ],
    });
    const bytes = estimateSessionBytes([image]);
    assert.equal(bytes, "describe".length + "data:image/png;base64,".length + 100);
    assert.ok(bytes > 100, "image payload is counted");
  });

  test("sessionBytes exposes the byte estimate on the store", (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());
    assert.equal(store.sessionBytes([new HumanMessage("hello")]), "hello".length);
  });

  test("concurrent deltas for different messageIds on one session both succeed in FIFO order", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    const [r1, r2] = await Promise.all([
      store.appendDelta("alice", "s1", "m1", new HumanMessage("one")),
      store.appendDelta("alice", "s1", "m2", new HumanMessage("two")),
    ]);
    assert.equal(r1.status, "resumed");
    assert.equal(r2.status, "resumed");
    assert.deepEqual(
      store.getMessages("alice", "s1")?.map((m) => m.content),
      ["base", "one", "two"],
      "mutex serializes appends in acquisition order",
    );
  });

  test("concurrent same-messageId deltas: exactly one append wins", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", []);
    const [r1, r2] = await Promise.all([
      store.appendDelta("alice", "s1", "same", new HumanMessage("q")),
      store.appendDelta("alice", "s1", "same", new HumanMessage("q")),
    ]);
    const statuses = [r1.status, r2.status];
    assert.ok(statuses.includes("resumed"), `expected one winner, got ${statuses.join(",")}`);
    assert.ok(
      statuses.includes("in_progress") || statuses.includes("already_completed"),
      `loser should see in_progress or already_completed, got ${statuses.join(",")}`,
    );
    assert.equal(store.getMessages("alice", "s1")?.length, 1, "no duplicate append");
  });

  test("outcomes are capped to maxOutcomesPerSession, pruning strictly-oldest messageIds", async (t) => {
    const { store } = makeStore({ maxOutcomesPerSession: 3 });
    t.after(() => store.dispose());

    await store.establish("alice", "s1", []);
    for (let i = 0; i < 5; i++) {
      await store.appendDelta("alice", "s1", `m${i}`, new HumanMessage(`m${i}`));
    }
    const rec = store.get("alice", "s1");
    assert.equal(rec?.outcomes.size, 3);
    assert.equal(rec?.outcomes.has("m0"), false, "oldest pruned");
    assert.equal(rec?.outcomes.has("m1"), false);
    assert.equal(rec?.outcomes.has("m4"), true, "newest retained");
  });

  test("re-establish (compaction re-base) replaces messages but preserves outcomes", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("a")]);
    await store.appendDelta("alice", "s1", "m1", new HumanMessage("b"));
    await store.markCompleted("alice", "s1", "m1", new AIMessage("reply"));

    const re = await store.establish("alice", "s1", [new HumanMessage("trimmed")]);
    assert.equal(re.status, "established");
    if (re.status === "established") assert.equal(re.generation, 2, "re-seed bumps the incarnation");
    assert.deepEqual(store.getMessages("alice", "s1")?.map((m) => m.content), ["trimmed"]);

    const dup = await store.appendDelta("alice", "s1", "m1", new HumanMessage("b"));
    assert.equal(dup.status, "already_completed", "exactly-once anchor survives re-base");
  });

  test("generation (F4): a stale finalization after a re-seed is a no-op", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    const seeded = await store.establish("alice", "s1", [new HumanMessage("a")]);
    assert.ok(seeded.status === "established");
    const gen = seeded.generation;

    // Eviction + re-establish while the turn is "in flight" → new generation.
    const re = await store.establish("alice", "s1", [new HumanMessage("trimmed")]);
    assert.ok(re.status === "established");
    assert.notEqual(re.generation, gen);

    // The STALE turn's finalization must not stamp the new incarnation.
    const completed = await store.markCompleted(
      "alice", "s1", "m1", new AIMessage("stale reply"), gen,
    );
    assert.deepEqual(completed, { evicted: false });
    assert.equal(store.get("alice", "s1")?.outcomes.has("m1"), false);

    const failed = await store.markFailed("alice", "s1", "m2", gen);
    assert.deepEqual(failed, { evicted: false });
    assert.equal(store.get("alice", "s1")?.outcomes.has("m2"), false);
  });

  test("N9: a re-seed downgrades an orphaned in_progress outcome to failed so a same-messageId retry is a clean re-run", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    await store.appendDelta("alice", "s1", "turn-1", new HumanMessage("in flight"));
    assert.equal(store.get("alice", "s1")?.outcomes.get("turn-1")?.status, "in_progress");

    // Compaction re-base under the same session_id while turn-1 is in flight:
    // the new incarnation orphans turn-1's finalization (F4), so its outcome
    // must be downgraded to failed — not left in_progress forever.
    const re = await store.reestablish("alice", "s1", "turn-2", [new HumanMessage("rebased")]);
    assert.equal(re.status, "reestablished");
    const rec = store.get("alice", "s1");
    assert.equal(rec?.outcomes.get("turn-1")?.status, "failed", "orphaned turn downgraded");
    assert.equal(rec?.outcomes.get("turn-2")?.status, "in_progress", "the re-base's own turn is anchored");

    // Retrying the orphaned messageId is now a clean re-run, not in_progress.
    const retry = await store.appendDelta("alice", "s1", "turn-1", new HumanMessage("in flight"));
    assert.equal(retry.status, "resumed");
    assert.equal(store.get("alice", "s1")?.outcomes.get("turn-1")?.status, "in_progress");
    assert.equal(
      store.getMessages("alice", "s1")?.filter((m) => m.content === "in flight").length,
      1,
      "the retried message re-appends exactly once",
    );
  });

  test("N9: a re-seed via establish also downgrades orphaned in_progress outcomes", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("base")]);
    await store.appendDelta("alice", "s1", "turn-1", new HumanMessage("in flight"));

    const re = await store.establish("alice", "s1", [new HumanMessage("trimmed")]);
    assert.equal(re.status, "established");
    assert.equal(store.get("alice", "s1")?.outcomes.get("turn-1")?.status, "failed");
  });

  test("generation (F4): a reply append with a stale expectedGeneration is generation_changed and appends nothing", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    const seeded = await store.establish("alice", "s1", [new HumanMessage("a")]);
    assert.ok(seeded.status === "established");
    const gen = seeded.generation;
    await store.appendDelta("alice", "s1", "m1", new HumanMessage("q"));

    // Re-seed while the turn is "in flight".
    await store.establish("alice", "s1", [new HumanMessage("trimmed")]);

    const reply = await store.appendDelta("alice", "s1", "m1:assistant", new AIMessage("stale"), {
      expectedGeneration: gen,
      evictOnOverflow: false,
    });
    assert.equal(reply.status, "generation_changed");
    assert.deepEqual(
      store.getMessages("alice", "s1")?.map((m) => m.content),
      ["trimmed"],
      "no stale reply appended into the new incarnation",
    );
  });

  test("byte cap (F5): an oversized assistant-reply append is dropped, not evicting the session", async (t) => {
    const { store, clock } = makeStore({ maxSessionBytes: 60 });
    t.after(() => store.dispose());

    // Seed just under the cap: "short" (5) + a 40-char user message = 45.
    await store.establish("alice", "s1", [new HumanMessage("short")]);
    await store.appendDelta("alice", "s1", "m1", new HumanMessage("u".repeat(40)));
    assert.ok(store.get("alice", "s1"));

    const before = store.get("alice", "s1")!.lastTouchedAt;
    clock.advance(10);
    // An oversized assistant reply (60 chars) would push past the 60-char cap.
    const reply = await store.appendDelta(
      "alice", "s1", "m1:assistant", new AIMessage("r".repeat(60)),
      { evictOnOverflow: false },
    );
    assert.equal(reply.status, "resumed");
    assert.ok(store.get("alice", "s1"), "session retained, not evicted");
    assert.equal(store.get("alice", "s1")!.lastTouchedAt, before + 10, "lastTouchedAt still bumped");
    assert.equal(
      store.getMessages("alice", "s1")?.some((m) => m.content === "r".repeat(60)),
      false,
      "over-cap reply dropped",
    );

    // F5 contract: the outcome is still completed even though the reply is
    // absent from the read-back.
    const completed = await store.markCompleted("alice", "s1", "m1", new AIMessage("r".repeat(60)));
    assert.deepEqual(completed, { evicted: false });
    assert.equal(store.get("alice", "s1")?.outcomes.get("m1")?.status, "completed");
  });

  test("deleteSession removes a session; deleteSessionsForOwner removes all of an owner's", async (t) => {
    const { store } = makeStore();
    t.after(() => store.dispose());

    await store.establish("alice", "s1", [new HumanMessage("a1")]);
    await store.establish("alice", "s2", [new HumanMessage("a2")]);
    await store.establish("bob", "b1", [new HumanMessage("b1")]);

    assert.equal(store.deleteSession("alice", "s1"), true);
    assert.equal(store.deleteSession("alice", "s1"), false, "already gone");
    assert.equal(store.get("alice", "s1"), null);
    assert.equal(store.count("alice"), 1);

    assert.equal(store.deleteSessionsForOwner("alice"), 1);
    assert.equal(store.count("alice"), 0);
    assert.equal(store.size, 1);
    assert.ok(store.get("bob", "b1"));
  });

  test("constructor rejects invalid options", () => {
    const clock = makeClock();
    const { setInterval, clearInterval } = clock;
    assert.throws(() => createSessionStore({ idleTtlMs: 0, setInterval, clearInterval }), /idleTtlMs/);
    assert.throws(() => createSessionStore({ maxSessionsPerOwner: 0, setInterval, clearInterval }), /maxSessionsPerOwner/);
    assert.throws(() => createSessionStore({ maxSessions: 0, setInterval, clearInterval }), /maxSessions/);
    assert.throws(() => createSessionStore({ maxSessionBytes: -1, setInterval, clearInterval }), /maxSessionBytes/);
    assert.throws(() => createSessionStore({ maxOutcomesPerSession: 0, setInterval, clearInterval }), /maxOutcomesPerSession/);
    assert.throws(() => createSessionStore({ sweepIntervalMs: 0, setInterval, clearInterval }), /sweepIntervalMs/);
  });

  test("dispose stops the sweep timer and is idempotent", () => {
    const { store, clock } = makeStore({ idleTtlMs: 100 });
    assert.equal(clock.pending(), 1);
    store.dispose();
    assert.equal(clock.pending(), 0);
    store.dispose(); // no-op, no throw
    assert.equal(clock.pending(), 0);
  });

  test("owner/sessionId containing the NUL separator is rejected", async () => {
    const { store } = makeStore();
    store.dispose();
    await assert.rejects(
      () => store.establish("bad\u0000owner", "s1", []),
      /NUL/,
    );
  });
});