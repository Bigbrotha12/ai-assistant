import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgentGraph } from "../../src/agents/graph.ts";
import { compileGraphWithCheckpointer } from "../../src/agents/compile.ts";
import { ThreadLockRegistry } from "../../src/jobs/thread_lock.ts";
import { checkpointThreadId, createCheckpointStore } from "../../src/checkpoints/store.ts";
import type { CheckpointStore } from "../../src/checkpoints/store.ts";
import { createCheckpointRoutes } from "../../src/checkpoints/routes.ts";
import type { VerifyApiKeyFn } from "../../src/checkpoints/routes.ts";

const threadLocks = new ThreadLockRegistry();

/** Same scripted model the store tests use (see store.test.ts). */
class ScriptedModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];

  constructor(responses: BaseMessage[]) {
    super({});
    this.queue = [...responses];
  }

  _llmType(): string {
    return "scripted-checkpoint-routes";
  }

  override bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedModel(this.queue);
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message =
      this.queue.shift() ?? new AIMessage("(scripted responses exhausted)");
    return { generations: [{ message, text: "" }] };
  }
}

const TEST_KEY = "test-key-0123456789abcdef";

/**
 * Auth stub mirroring `requireApiKey`: the referenceId is derived from the
 * bearer token — `key-a` → `user-a`, `key-b` → `user-b`, anything else → null
 * (401). Lets the ownership tests act as distinct callers over HTTP.
 */
function makeVerifyKey(): VerifyApiKeyFn {
  return async (c) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match ? match[1]!.trim() : "";
    const owners: Record<string, string> = { "key-a": "user-a", "key-b": "user-b" };
    return owners[token] ?? null;
  };
}

async function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
): Promise<{ app: Hono; store: CheckpointStore }> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-routes-"));
  const store = await createCheckpointStore({
    dbPath: join(dir, "checkpoints.db"),
    dbKey: TEST_KEY,
  });
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const app = new Hono();
  app.route(
    "/v1",
    createCheckpointRoutes({ store, verifyKey: verifyKey ?? makeVerifyKey(), threadLocks }),
  );
  return { app, store };
}

/** Seeds a thread with a public id, the way the managed chat path does. */
function touchPublic(store: CheckpointStore, owner: string, publicId: string, lastError: string | null = null): string {
  const threadId = checkpointThreadId(owner, publicId);
  store.touchThread(owner, threadId, lastError, publicId);
  return threadId;
}

const authA = { authorization: "Bearer key-a" };
const authB = { authorization: "Bearer key-b" };

describe("checkpoint routes — owner-scoped history recovery (Phase 5)", () => {
  test("GET /v1/threads/:id returns the public id and ApiMessage-shaped history", async (t) => {
    const { app, store } = await makeApp(t);
    const threadId = touchPublic(store, "user-a", "pub-hist");
    // Seed a real checkpoint by invoking the real graph over the store's
    // checkpointer (the same path the chat transport uses).
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("hello back")]), tools: [] }),
      store.checkpointer,
    );
    await graph.invoke(
      { messages: [new HumanMessage("hello")] },
      { configurable: { thread_id: threadId } },
    );
    const res = await app.request("/v1/threads/pub-hist", { headers: authA });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      threadId: string;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(json.threadId, "pub-hist");
    assert.deepEqual(
      json.messages.map((m) => ({ role: m.role, content: m.content })),
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hello back" },
      ],
      "history is ApiMessage-shaped with the public thread id",
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("cross-owner history is a 404, never a leak", async (t) => {
    const { store, app } = await makeApp(t);
    touchPublic(store, "user-b", "secret-thread");
    const res = await app.request("/v1/threads/secret-thread", { headers: authA });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("a checkpoint-missing managed thread reports reseed_required", async (t) => {
    const { app, store } = await makeApp(t);
    touchPublic(store, "user-a", "ghost-history");
    const res = await app.request("/v1/threads/ghost-history", { headers: authA });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("x-conversation-state"), "reseed_required");
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "reseed_required");
  });
});

describe("checkpoint routes — auth", () => {
  test("every endpoint → 401 unauthorized without a valid key", async (t) => {
    const { app } = await makeApp(t, async () => null);
    const cases: Array<[string, string]> = [
      ["GET", "/v1/threads"],
      ["DELETE", "/v1/threads"],
      ["DELETE", "/v1/threads/some-thread"],
    ];
    for (const [method, path] of cases) {
      const res = await app.request(path, { method, headers: authA });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "unauthorized" }, `${method} ${path}`);
    }
  });

  test("an unknown/other key → 401", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/threads", {
      headers: { authorization: "Bearer some-other-key" },
    });
    assert.equal(res.status, 401);
  });
});

describe("checkpoint routes — list", () => {
  test("GET /v1/threads returns only the caller's threads", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a1"));
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a2"));
    store.touchThread("user-b", touchPublic(store, "user-b", "thr-b1"));

    const asA = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: Array<{ threadId: string; messageCount: number }>;
    };
    assert.deepEqual(
      asA.threads.map((x) => x.threadId).sort(),
      ["thr-a1", "thr-a2"],
    );

    const asB = (await (await app.request("/v1/threads", { headers: authB })).json()) as {
      threads: Array<{ threadId: string }>;
    };
    assert.deepEqual(asB.threads.map((x) => x.threadId), ["thr-b1"]);
  });
});

describe("checkpoint routes — delete one", () => {
  test("DELETE /v1/threads/:id deletes the caller's thread → 200 ok", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a1"));

    const res = await app.request("/v1/threads/thr-a1", { method: "DELETE", headers: authA });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
    assert.equal(store.getThread(checkpointThreadId("user-a", "thr-a1")), undefined);
  });

  test("cross-owner delete is a 404, never a successful delete", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-b", touchPublic(store, "user-b", "thr-b1"));

    const res = await app.request("/v1/threads/thr-b1", { method: "DELETE", headers: authA });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
    assert.equal(store.getThread(checkpointThreadId("user-b", "thr-b1"))?.owner, "user-b", "thread must survive");
  });

  test("unknown thread → 404 not_found", async (t) => {
    const { app } = await makeApp(t);
    const res = await app.request("/v1/threads/ghost-thread", {
      method: "DELETE",
      headers: authA,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });
  test("legacy internal-only threads are invisible to list and history (safe fallback)", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", "legacy-internal-hash");
    const list = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: unknown[];
    };
    assert.deepEqual(list.threads, []);
    const res = await app.request("/v1/threads/legacy-internal-hash", { headers: authA });
    assert.equal(res.status, 404);
  });

  test("a legacy NULL public_id thread is adopted by its owner's managed thread id, never another owner's", async (t) => {
    const { app, store } = await makeApp(t);
    const legacyThreadId = "legacy-hash-value";
    store.touchThread("user-a", legacyThreadId);
    assert.equal(store.getThread(legacyThreadId)?.publicId ?? null, null);

    // Owner A's managed run for public id "pub-1" hashes to the SAME internal
    // thread id only if the legacy row was created for that id — here it was
    // not, so A's managed run writes a NEW row and the legacy row stays NULL.
    store.touchThread("user-a", checkpointThreadId("user-a", "pub-1"), null, "pub-1");
    const list = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: Array<{ threadId: string }>;
    };
    assert.deepEqual(list.threads.map((x) => x.threadId), ["pub-1"]);

    // Owner B can never claim A's legacy row: a mapping conflict on touch and
    // a 404 (not_found) on the history/delete surface.
    let conflict = false;
    try {
      store.touchThread("user-b", legacyThreadId, null, "b-thread");
    } catch (err) {
      conflict = (err as Error).message === "thread_mapping_conflict";
    }
    assert.equal(conflict, true, "cross-owner adoption is rejected");
    const resB = await app.request(`/v1/threads/${legacyThreadId}`, { headers: authB });
    assert.equal(resB.status, 404);
  });

  test("a deleted thread cannot be resurrected by touchThread", async (t) => {
    const { store } = await makeApp(t);
    const threadId = touchPublic(store, "user-a", "gone-thread");
    assert.equal(store.deleteThread("user-a", threadId), true);
    let deleted = false;
    try {
      store.touchThread("user-a", threadId, null, "gone-thread");
    } catch (err) {
      deleted = (err as Error).message === "thread_deleted";
    }
    assert.equal(deleted, true, "touchThread on a deleted thread throws thread_deleted");
    assert.equal(store.getThread(threadId), undefined);
  });
});

describe("checkpoint routes — per-user GC", () => {
  test("DELETE /v1/threads removes ALL of the caller's threads → { deleted: N }", async (t) => {
    const { app, store } = await makeApp(t);
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a1"));
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a2"));
    store.touchThread("user-a", touchPublic(store, "user-a", "thr-a3"));
    store.touchThread("user-b", touchPublic(store, "user-b", "thr-b1"));

    const res = await app.request("/v1/threads", { method: "DELETE", headers: authA });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 3 });

    const asA = (await (await app.request("/v1/threads", { headers: authA })).json()) as {
      threads: unknown[];
    };
    assert.equal(asA.threads.length, 0);
    assert.equal(store.getThread(checkpointThreadId("user-b", "thr-b1")) !== undefined, true, "other owners survive GC");
  });
});