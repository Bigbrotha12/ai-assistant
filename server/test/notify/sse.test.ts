import "../test_env.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createSseHub } from "../../src/notify/sse_hub.ts";
import type { SseHub } from "../../src/notify/sse_hub.ts";
import { createSseNotificationHook } from "../../src/notify/sse_hook.ts";
import { createSseNotifyRoutes } from "../../src/notify/sse_routes.ts";
import type { VerifyApiKeyFn } from "../../src/auth/request_auth.ts";

const decoder = new TextDecoder();

function readerFor(conn: { response: Response }): ReadableStreamDefaultReader<Uint8Array> {
  assert.ok(conn.response.body, "SSE response must carry a body");
  return conn.response.body!.getReader();
}

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  assert.equal(done, false, "expected a frame before the stream ended");
  return decoder.decode(value);
}

/** True when `promise` settles before `ms` — proves no event was delivered. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    }),
  ]);
}

describe("sse hub", () => {
  test("broadcast delivers exactly one data frame to the owner's stream", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const conn = hub.open("owner-a");
    assert.equal(hub.connectionCount("owner-a"), 1);

    hub.broadcast("owner-a", { title: "Job t1", body: "done" });
    assert.equal(
      await readFrame(readerFor(conn)),
      `data: ${JSON.stringify({ title: "Job t1", body: "done" })}\n\n`,
    );
  });

  test("broadcast is owner-scoped: only the addressed owner's stream receives it", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const readerA = readerFor(hub.open("owner-a"));
    const readerB = readerFor(hub.open("owner-b"));

    assert.doesNotThrow(() => hub.broadcast("nobody", { title: "x", body: "y" }));
    hub.broadcast("owner-a", { title: "mine", body: "b" });

    assert.match(await readFrame(readerA), /"title":"mine"/);
    assert.equal(
      await settlesWithin(readerB.read(), 30),
      false,
      "owner-b must not receive owner-a's event",
    );
    await readerB.cancel();
  });

  test("client disconnect (reader.cancel) drops the registration idempotently", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const conn = hub.open("owner-a");
    const reader = readerFor(conn);
    assert.equal(hub.connectionCount("owner-a"), 1);

    await reader.cancel();
    assert.equal(hub.connectionCount("owner-a"), 0);
    // A late server-side close is a no-op, never resurrects or throws.
    assert.doesNotThrow(() => conn.close());
    assert.equal(hub.connectionCount("owner-a"), 0);
  });

  test("closeOwner closes and forgets only that owner's streams", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const connA = hub.open("owner-a");
    hub.open("owner-a");
    hub.open("owner-b");
    assert.equal(hub.connectionCount("owner-a"), 2);
    assert.equal(hub.connectionCount(), 3);

    const readerA = readerFor(connA);
    hub.closeOwner("owner-a");
    assert.equal(hub.connectionCount("owner-a"), 0);
    assert.equal(hub.connectionCount("owner-b"), 1);
    assert.equal((await readerA.read()).done, true, "closed stream must end");

    // A completion delivered after close stays silent and never throws.
    assert.doesNotThrow(() => hub.broadcast("owner-a", { title: "t", body: "b" }));
    assert.doesNotThrow(() => hub.closeOwner("owner-a"));
  });

  test("dispose closes every stream and is idempotent", async () => {
    const hub = createSseHub();
    const conn = hub.open("owner-a");
    hub.open("owner-b");
    const reader = readerFor(conn);

    hub.dispose();
    assert.equal(hub.connectionCount(), 0);
    assert.equal((await reader.read()).done, true);
    assert.doesNotThrow(() => hub.dispose());
    assert.doesNotThrow(() => hub.closeOwner("owner-a"));
  });
});

describe("sse notification hook", () => {
  test("broadcasts a 'Job <taskId>' titled event to the hub", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const reader = readerFor(hub.open("owner-a"));
    const hook = createSseNotificationHook(hub);

    hook.notifyJobComplete("owner-a", "task-42", "job finished successfully");

    assert.equal(
      await readFrame(reader),
      `data: ${JSON.stringify({ title: "Job task-42", body: "job finished successfully" })}\n\n`,
    );
  });

  test("forwards the exact title/body to a structural broadcaster", () => {
    const events: Array<{ owner: string; event: { title: string; body: string } }> = [];
    const hook = createSseNotificationHook({
      broadcast: (owner, event) => events.push({ owner, event }),
    });

    assert.doesNotThrow(() => hook.notifyJobComplete("owner-a", "t-1", "summary"));
    assert.deepEqual(events, [
      { owner: "owner-a", event: { title: "Job t-1", body: "summary" } },
    ]);
  });

  test("notifyGoalStopped titles 'paused' as 'Goal needs you' and everything else as 'Goal failed'", () => {
    const events: Array<{ owner: string; event: { title: string; body: string } }> = [];
    const hook = createSseNotificationHook({
      broadcast: (owner, event) => events.push({ owner, event }),
    });

    hook.notifyGoalStopped!("owner-a", "g-1", "paused", "needs input");
    hook.notifyGoalStopped!("owner-a", "g-1", "failed", "step exploded");

    assert.deepEqual(events, [
      {
        owner: "owner-a",
        event: { title: "Goal needs you", body: "Goal g-1 paused (needs input)" },
      },
      {
        owner: "owner-a",
        event: { title: "Goal failed", body: "Goal g-1 failed (step exploded)" },
      },
    ]);
  });
});

describe("sse notify routes", () => {
  const owners: Record<string, string> = { "key-a": "user-a" };
  const verify: VerifyApiKeyFn = async (c) => {
    const token = /^Bearer\s+(.+)$/i.exec(
      (c.req.header("authorization") ?? "").trim(),
    )?.[1];
    const owner = token ? owners[token] : undefined;
    return owner ? { ok: true, owner } : { ok: false, reason: "bad_key" };
  };

  function makeApp(hub: SseHub, verifyKey: VerifyApiKeyFn = verify): Hono {
    const app = new Hono();
    app.route("/v1/notify", createSseNotifyRoutes({ hub, verifyKey }));
    return app;
  }

  test("rejects an unauthenticated request with 401 without opening a stream", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const res = await makeApp(hub).request("/v1/notify/events");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
    assert.equal(hub.connectionCount(), 0);
  });

  test("maps email_not_verified and account_deleted failures to 403", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());

    const unverified = await makeApp(hub, async () => ({
      ok: false,
      reason: "email_not_verified",
    })).request("/v1/notify/events");
    assert.equal(unverified.status, 403);
    assert.deepEqual(await unverified.json(), { error: "email_not_verified" });

    const deleted = await makeApp(hub, async () => ({
      ok: false,
      reason: "account_deleted",
    })).request("/v1/notify/events");
    assert.equal(deleted.status, 403);
    assert.deepEqual(await deleted.json(), { error: "account_deleted" });
    assert.equal(hub.connectionCount(), 0);
  });

  test("opens a text/event-stream, delivers the owner's events, and deregisters on disconnect", async (t) => {
    const hub = createSseHub();
    t.after(() => hub.dispose());
    const app = makeApp(hub);

    const res = await app.request("/v1/notify/events", {
      headers: { authorization: "Bearer key-a" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(hub.connectionCount("user-a"), 1);

    const reader = res.body!.getReader();
    hub.broadcast("user-a", { title: "Job t9", body: "done" });
    assert.equal(
      await readFrame(reader),
      `data: ${JSON.stringify({ title: "Job t9", body: "done" })}\n\n`,
    );

    await reader.cancel();
    assert.equal(hub.connectionCount("user-a"), 0);
  });
});
