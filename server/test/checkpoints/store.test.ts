import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ChatResult } from "@langchain/core/outputs";
import Database from "better-sqlite3-multiple-ciphers";
import { createAgentGraph } from "../../src/agents/graph.ts";
import { compileGraphWithCheckpointer } from "../../src/agents/compile.ts";
import {
  CheckpointStoreError,
  CURRENT_CHECKPOINT_VERSION,
  checkpointThreadId,
  createCheckpointStore,
  redactForCheckpoint,
} from "../../src/checkpoints/store.ts";
import type { CheckpointStore } from "../../src/checkpoints/store.ts";

const TEST_KEY = "test-key-0123456789abcdef";

/**
 * Minimal scripted model: returns its preset AIMessage queue in order (then a
 * harmless fallback). Uses BaseChatModel's default `bindTools` (config-level),
 * so `createAgentGraph` accepts it without a real tool-capable model.
 */
class ScriptedModel extends BaseChatModel<BaseChatModelCallOptions> {
  private queue: BaseMessage[];

  constructor(responses: BaseMessage[]) {
    super({});
    this.queue = [...responses];
  }

  _llmType(): string {
    return "scripted-checkpoint";
  }

  bindTools(tools: StructuredToolInterface[]) {
    const next = new ScriptedModel(this.queue);
    return next.withConfig({ tools } as BaseChatModelCallOptions);
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message =
      this.queue.shift() ?? new AIMessage("(scripted responses exhausted)");
    return { generations: [{ message, text: "" }] };
  }
}

async function makeStore(t: TestContext, name = "checkpoints.db"): Promise<{
  store: CheckpointStore;
  dir: string;
  dbPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoints-store-"));
  const dbPath = join(dir, name);
  const store = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, dir, dbPath };
}

/** Reopen an existing checkpoint DB with the same key (fresh handle). */
function openRaw(path: string, key = TEST_KEY): Database.Database {
  const db = new Database(path);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}

describe("checkpoint store — creation & migrations", () => {
  test("creates the DB with 0600 perms and migrates an empty file", async (t) => {
    const { store, dir, dbPath } = await makeStore(t);
    assert.ok(store.checkpointer, "checkpointer must be exposed");

    const mode = (await stat(dbPath)).mode & 0o777;
    assert.equal(mode, 0o600, "checkpoint DB must be 0600");

    // Migrations applied: our owner table exists at the current version.
    const probe = openRaw(dbPath);
    assert.equal(
      probe.pragma("user_version", { simple: true }),
      CURRENT_CHECKPOINT_VERSION,
    );
    const ownerTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_owner'")
      .get();
    assert.ok(ownerTable, "thread_owner table must exist after migration");
    probe.close();
    void dir;
  });

  test("reopen is idempotent and preserves data", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoints-reopen-"));
    const dbPath = join(dir, "checkpoints.db");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const store1 = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    store1.touchThread("owner-a", "thr-reopen");
    await store1.close();

    // Second store over the SAME file + key: data survives, migration no-ops.
    const store2 = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    t.after(() => store2.close());
    const record = store2.getThread("thr-reopen");
    assert.equal(record?.threadId, "thr-reopen");
    assert.equal(record?.owner, "owner-a");
    assert.equal(record?.lastError, null);
    assert.equal(store2.listThreads("owner-a").length, 1);
  });

  test("touchThread upserts and records lastError", async (t) => {
    const { store } = await makeStore(t);
    store.touchThread("owner-a", "thr-1");
    store.touchThread("owner-a", "thr-1", "boom");
    const record = store.getThread("thr-1");
    assert.equal(record?.owner, "owner-a");
    assert.equal(record?.lastError, "boom");
    assert.equal(store.listThreads("owner-a").length, 1, "upsert must not duplicate");
  });
});

describe("checkpoint store — durable resume through the real agent graph", () => {
  test("a second invoke on the same thread sees the first invoke's messages", async (t) => {
    const { store } = await makeStore(t);
    const model = new ScriptedModel([
      new AIMessage("first reply"),
      new AIMessage("second reply"),
    ]);
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model, tools: [] }),
      store.checkpointer,
    );
    const threadId = "resume-thread";
    store.touchThread("owner-a", threadId);

    const first = await graph.invoke(
      { messages: [new HumanMessage("hello")] },
      { configurable: { thread_id: threadId } },
    );
    assert.equal(first.messages.length, 2, "fresh thread: human + ai");
    assert.equal(String(first.messages[0]!.content), "hello");

    const second = await graph.invoke(
      { messages: [new HumanMessage("again")] },
      { configurable: { thread_id: threadId } },
    );
    assert.equal(second.messages.length, 4, "resumed thread accumulates history");
    assert.equal(String(second.messages[0]!.content), "hello");
    assert.equal(String(second.messages[1]!.content), "first reply");
    assert.equal(String(second.messages[2]!.content), "again");
    assert.equal(String(second.messages[3]!.content), "second reply");
  });

  test("history survives a store close/reopen (restart) and a fresh thread starts empty", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoints-restart-"));
    const dbPath = join(dir, "checkpoints.db");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const threadId = "restart-thread";
    const store1 = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    const graph1 = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("persisted reply")]), tools: [] }),
      store1.checkpointer,
    );
    await graph1.invoke(
      { messages: [new HumanMessage("before restart")] },
      { configurable: { thread_id: threadId } },
    );
    store1.touchThread("owner-a", threadId);
    await store1.close();

    // Simulated gateway restart: a NEW store + graph over the same file/key.
    const store2 = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    t.after(() => store2.close());
    const graph2 = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("after restart")]), tools: [] }),
      store2.checkpointer,
    );

    const resumed = await graph2.invoke(
      { messages: [new HumanMessage("after restart")] },
      { configurable: { thread_id: threadId } },
    );
    assert.equal(resumed.messages.length, 4);
    assert.equal(String(resumed.messages[0]!.content), "before restart");
    assert.equal(String(resumed.messages[1]!.content), "persisted reply");

    const fresh = await graph2.invoke(
      { messages: [new HumanMessage("new conversation")] },
      { configurable: { thread_id: "brand-new-thread" } },
    );
    assert.equal(fresh.messages.length, 2, "a never-seen thread starts fresh");
  });
});

describe("checkpoint store — owner scoping (IDOR)", () => {
  test("a thread is invisible to other owners across list/get/delete", async (t) => {
    const { store } = await makeStore(t);
    store.touchThread("owner-a", "thr-a");
    store.touchThread("owner-b", "thr-b");

    assert.deepEqual(
      store.listThreads("owner-a").map((s) => s.threadId),
      ["thr-a"],
    );
    assert.deepEqual(
      store.listThreads("owner-b").map((s) => s.threadId),
      ["thr-b"],
    );

    // Cross-owner delete is an IDOR-safe miss: false, and the row stays.
    assert.equal(store.deleteThread("owner-b", "thr-a"), false);
    assert.equal(store.getThread("thr-a")?.owner, "owner-a");

    // Owner delete works; a second delete is a miss.
    assert.equal(store.deleteThread("owner-a", "thr-a"), true);
    assert.equal(store.deleteThread("owner-a", "thr-a"), false);
    assert.equal(store.getThread("thr-a"), undefined);
  });

  test("deleteThreadsForOwner removes only that owner's threads", async (t) => {
    const { store } = await makeStore(t);
    store.touchThread("owner-a", "t1");
    store.touchThread("owner-a", "t2");
    store.touchThread("owner-b", "t3");

    assert.equal(store.deleteThreadsForOwner("owner-a"), 2);
    assert.equal(store.listThreads("owner-a").length, 0);
    assert.deepEqual(
      store.listThreads("owner-b").map((s) => s.threadId),
      ["t3"],
      "other owners' threads must survive a GC",
    );
  });
});

describe("checkpoint store — deleteThread cascades checkpoints", () => {
  test("after delete, resuming the same thread starts fresh", async (t) => {
    const { store } = await makeStore(t);
    const threadId = "cascade-thread";
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("r1"), new AIMessage("r2")]), tools: [] }),
      store.checkpointer,
    );
    store.touchThread("owner-a", threadId);
    await graph.invoke(
      { messages: [new HumanMessage("one")] },
      { configurable: { thread_id: threadId } },
    );
    await graph.invoke(
      { messages: [new HumanMessage("two")] },
      { configurable: { thread_id: threadId } },
    );

    assert.equal(store.deleteThread("owner-a", threadId), true);
    assert.equal(store.getThread(threadId), undefined, "owner row gone");

    // From the checkpointer's perspective the thread is gone: fresh resume.
    const fresh = await graph.invoke(
      { messages: [new HumanMessage("fresh")] },
      { configurable: { thread_id: threadId } },
    );
    assert.equal(fresh.messages.length, 2, "resume after delete must not see old messages");
    assert.equal(String(fresh.messages[0]!.content), "fresh");
  });
});

describe("checkpoint store — credential redaction", () => {
  test("redactForCheckpoint masks bearer tokens, Authorization headers and sk- keys", () => {
    assert.equal(
      redactForCheckpoint("Authorization: Bearer sk-abc123 tail"),
      "Authorization: Bearer *** tail",
    );
    assert.equal(redactForCheckpoint("Authorization: Bearer <token>"), "Authorization: Bearer ***");
    assert.equal(redactForCheckpoint("token = Bearer sk-live-9f8f8f8f"), "token = Bearer ***");
    assert.equal(redactForCheckpoint("use your key sk-abc123xyz now"), "use your key sk-*** now");
    assert.equal(redactForCheckpoint("plain text"), "plain text");
    assert.equal(
      redactForCheckpoint(""),
      "",
      "empty content stays empty",
    );
  });

  test("credential-shaped content never reaches checkpoint rows; *** does", async (t) => {
    const { store, dbPath } = await makeStore(t);
    const secret = "Bearer sk-abc123";
    const redacted = redactForCheckpoint(
      `fetch with Authorization: Bearer sk-abc123 and token ${secret}`,
    );
    assert.ok(!redacted.includes(secret), "redacted string must not contain the secret");

    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("done")]), tools: [] }),
      store.checkpointer,
    );
    const threadId = "redact-thread";
    store.touchThread("owner-a", threadId);
    await graph.invoke(
      { messages: [new HumanMessage(redacted)] },
      { configurable: { thread_id: threadId } },
    );

    // Query the persisted rows directly (the store's own DB, same key).
    const probe = openRaw(dbPath);
    const blobs = [
      ...(probe.prepare("SELECT checkpoint AS b FROM checkpoints").all() as Array<{ b: Buffer }>).map((r) => String(r.b)),
      ...(probe.prepare("SELECT value AS b FROM writes").all() as Array<{ b: Buffer }>).map((r) => String(r.b)),
    ].join("\n");
    probe.close();

    assert.ok(blobs.includes("***"), "redaction marker must be persisted");
    assert.equal(blobs.includes("sk-abc123"), false, "secret must not be persisted");
  });
});

describe("checkpoint store — encryption at rest", () => {
  test("a known plaintext string never appears in the on-disk file", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoints-enc-"));
    const dbPath = join(dir, "checkpoints.db");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const marker = "SOME_VERY_KNOWN_PLAINTEXT_MARKER";
    const store = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    const graph = compileGraphWithCheckpointer(
      createAgentGraph({ model: new ScriptedModel([new AIMessage("reply")]), tools: [] }),
      store.checkpointer,
    );
    await graph.invoke(
      { messages: [new HumanMessage(`the marker is ${marker}`)] },
      { configurable: { thread_id: "enc-thread" } },
    );
    store.touchThread("owner-a", "enc-thread");
    await store.close();

    // Scan the db file and any -wal/-shm siblings for the plaintext marker.
    const suffixPatterns = ["", "-wal", "-shm"];
    const files = await Promise.all(
      suffixPatterns.map(async (suffix) => {
        try {
          const bytes = await readFile(dbPath + suffix);
          return { suffix, bytes };
        } catch {
          return null;
        }
      }),
    );
    const present = files.filter((f): f is NonNullable<typeof f> => f !== null);
    assert.ok(present.length > 0, "db file must exist after close");
    for (const { suffix, bytes } of present) {
      assert.equal(
        bytes.includes(Buffer.from(marker)),
        false,
        `plaintext marker leaked into ${suffix || "db"} file`,
      );
    }
  });

  test("opening with the wrong key fails; a missing key is refused", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "checkpoints-key-"));
    const dbPath = join(dir, "checkpoints.db");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const store = await createCheckpointStore({ dbPath, dbKey: TEST_KEY });
    store.touchThread("owner-a", "thr-k");
    await store.close();

    await assert.rejects(
      createCheckpointStore({ dbPath, dbKey: "wrong-key-00000000000000" }),
      (err: unknown) =>
        err instanceof CheckpointStoreError && err.code === "OPEN_FAILED",
      "a wrong key must fail the open",
    );
    await assert.rejects(
      createCheckpointStore({ dbPath }),
      (err: unknown) =>
        err instanceof CheckpointStoreError && err.code === "KEY_REQUIRED",
      "a missing key must be refused outright",
    );
  });
});

describe("checkpoint store — thread id mapping", () => {
  test("checkpointThreadId is deterministic and owner-bound", () => {
    const a = checkpointThreadId("user-1", "client-thread-abc");
    assert.equal(a, checkpointThreadId("user-1", "client-thread-abc"));
    assert.notEqual(a, checkpointThreadId("user-2", "client-thread-abc"));
    assert.notEqual(a, checkpointThreadId("user-1", "client-thread-xyz"));
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});