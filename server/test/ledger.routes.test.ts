import "./test_env.ts";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Hono } from "hono";
import {
  Ledger,
  migrateLedger,
  PUBLIC_STEP_ID_MAX_BYTES,
  PUBLIC_STEP_RESULT_MAX_BYTES,
  PUBLIC_STEP_LIMIT,
  PUBLIC_TASK_PAGE_DEFAULT_LIMIT,
  PUBLIC_TASK_PAGE_MAX_LIMIT,
  PUBLIC_TASK_SPEC_MAX_BYTES,
} from "../src/ledger/index.ts";
import { env } from "../src/config/env.ts";
import { getOrCreateTask } from "../src/credentials/idempotency.ts";
import { createLedgerRoutes } from "../src/ledger/routes.ts";
import type { JobRunner, TaskCancelReport } from "../src/jobs/runner.ts";
import type { VerifyApiKeyFn } from "../src/auth/request_auth.ts";
import { clearDeleting, markDeleting } from "../src/auth/account_deletion.ts";

/**
 * Build the ledger app the way src/index.ts does (`app.route("/ledger", ...)`)
 * but with the auth verifier swapped for a deterministic stub, so tests
 * exercise the full HTTP surface without better-auth's DB — mirroring the
 * plugin routes' `verifyKey` seam.
 */
function makeApp(
  verifyKey?: VerifyApiKeyFn,
  jobRunner?: JobRunner,
): {
  app: Hono;
  db: Database.Database;
  ledger: Ledger;
} {
  const db = new Database(":memory:");
  migrateLedger(db);
  const ledger = new Ledger(db);
  const app = new Hono();
  app.route(
    "/ledger",
    createLedgerRoutes(ledger, {
      verifyKey: verifyKey ?? (async () => ({ ok: true as const, owner: "user-1" })),
      jobRunner,
    }),
  );
  return { app, db, ledger };
}

const auth = {
  authorization: "Bearer test-key",
  "content-type": "application/json",
};

function recordPreparedSql(db: Database.Database): string[] {
  const statements: string[] = [];
  const originalPrepare = db.prepare.bind(db) as (sql: string) => unknown;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql) => {
    statements.push(sql);
    return originalPrepare(sql);
  };
  return statements;
}

async function createTask(
  app: Hono,
  intentKey: string,
): Promise<{ id: string }> {
  const res = await app.request("/ledger/tasks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ intentKey, spec: {} }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

describe("ledger routes — status by idempotency key", () => {
  test("the owning user fetches their task by intent key", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "msg-abc");

    const res = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      owner: string;
      intent_key: string;
      status: string;
    };
    assert.equal(body.id, created.id);
    assert.equal(body.owner, "user-1");
    assert.equal(body.intent_key, "msg-abc");
    assert.equal(body.status, "queued");
  });

  test("cross-owner lookup -> 404 (IDOR: another tenant's key is a miss)", async () => {
    const { app, ledger } = makeApp();
    await createTask(app, "msg-secret");

    const intruder = new Hono();
    intruder.route(
      "/ledger",
      createLedgerRoutes(ledger, { verifyKey: async () => ({ ok: true as const, owner: "intruder" }) }),
    );
    const res = await intruder.request("/ledger/tasks/by-key/msg-secret", {
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("unknown intent key -> 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/ledger/tasks/by-key/never-sent", {
      headers: auth,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
  });

  test("401 without a valid key", async () => {
    const { app } = makeApp(async () => ({ ok: false as const, reason: "bad_key" as const }));
    const res = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("valid key but the owner's email is unverified -> 403 email_not_verified", async () => {
    const { app } = makeApp(async () => ({
      ok: false as const,
      reason: "email_not_verified" as const,
    }));
    const res = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "email_not_verified" });
  });

  test("the existing /ledger/tasks/:id surface still works alongside by-key", async () => {
    const { app } = makeApp();
    const created = await createTask(app, "msg-abc");

    const byKey = await app.request("/ledger/tasks/by-key/msg-abc", {
      headers: auth,
    });
    assert.equal(byKey.status, 200);

    const byId = await app.request(`/ledger/tasks/${created.id}`, {
      headers: auth,
    });
    assert.equal(byId.status, 200);
    const body = (await byId.json()) as { id: string };
    assert.equal(body.id, created.id);
  });

  test("M2: POST /ledger/tasks with a duplicate intentKey returns the existing task (200, same id) — no 500", async () => {
    const { app } = makeApp();
    const first = await createTask(app, "dup-key");

    const res = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ intentKey: "dup-key", spec: { x: 1 } }),
    });
    assert.equal(res.status, 200, "a repeat must not 500 on the unique index");
    const body = (await res.json()) as { id: string };
    assert.equal(body.id, first.id, "the SAME task id must be returned");
  });

  test("M2: the duplicate is owner-scoped — another owner's duplicate is a fresh task", async () => {
    const { app, ledger } = makeApp();
    await createTask(app, "scope-key");

    const other = new Hono();
    other.route(
      "/ledger",
      createLedgerRoutes(ledger, { verifyKey: async () => ({ ok: true as const, owner: "user-2" }) }),
    );
    const res = await other.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ intentKey: "scope-key", spec: {} }),
    });
    assert.equal(res.status, 201, "a different owner gets their own task");
  });
});

describe("ledger routes — deletion tombstones", () => {
  test("a tombstoned owner cannot create tasks", async () => {
    const owner = "ledger-deleted-owner";
    const { app, ledger } = makeApp(async () => ({ ok: true as const, owner }));
    markDeleting(owner);
    try {
      const created = await app.request("/ledger/tasks", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ intentKey: "late", spec: {} }),
      });
      assert.equal(created.status, 403);
      assert.deepEqual(await created.json(), { error: "account_deleted" });
      assert.equal(ledger.getTaskByIntentKey(owner, "late"), null);
    } finally {
      clearDeleting(owner);
    }
  });
});

describe("ledger routes — snapshot payload never leaks (v5)", () => {
  test("a task with a stored payload is returned WITHOUT the payload on every read route", async () => {
    const { app, ledger } = makeApp();
    // The route API never sets a payload; the runner does. Seed one directly to
    // prove job-status delivery strips it.
    const task = ledger.createTask({
      owner: "user-1",
      intentKey: "msg-payload",
      spec: "spec",
      payload: JSON.stringify([{ role: "user", content: "private snapshot" }]),
    });
    assert.ok(task.payload, "the stored task carries the payload");

    const byId = await app.request(`/ledger/tasks/${task.id}`, { headers: auth });
    assert.equal(byId.status, 200);
    const idBody = (await byId.json()) as Record<string, unknown>;
    assert.equal("payload" in idBody, false, "GET /tasks/:id must not echo the payload");
    assert.equal(idBody["spec"], "spec", "the non-sensitive spec still rides the response");

    const byKey = await app.request("/ledger/tasks/by-key/msg-payload", { headers: auth });
    const keyBody = (await byKey.json()) as Record<string, unknown>;
    assert.equal("payload" in keyBody, false, "by-key (the client poll surface) must not echo the payload");

    const list = await app.request("/ledger/tasks", { headers: auth });
    const listBody = (await list.json()) as Array<Record<string, unknown>>;
    assert.equal(
      listBody.some((row) => "payload" in row),
      false,
      "GET /tasks must not echo payloads",
    );
  });
});

describe("public ledger read window", () => {
  test("returns a bounded latest window and metadata-only projection", async () => {
    const { app, ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "public-read-window", spec: "s" });
    const claimed = ledger.claimTask(task.id, "user-1");
    const internalResult = "r".repeat(PUBLIC_STEP_RESULT_MAX_BYTES + 100);
    for (let index = 0; index < PUBLIC_STEP_LIMIT + 1; index++) {
      ledger.appendStep(
        task.id,
        "user-1",
        {
          stage: "tool",
          action: `tool:${index}`,
          result: internalResult,
          toolCallId: `call-${index}`,
        },
        claimed.fence_token,
      );
    }
    ledger.appendStep(
      task.id,
      "user-1",
      { stage: "reply", action: "assistant_message", result: "final reply" },
      claimed.fence_token,
    );

    const internal = ledger.listSteps(task.id, "user-1");
    assert.equal(internal.length, PUBLIC_STEP_LIMIT + 2);
    assert.equal(internal[0]?.result, internalResult);

    const response = await app.request(`/ledger/tasks/${task.id}`, { headers: auth });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      projection: {
        completedActions: Array<Record<string, unknown>>;
        stepCount: number;
        resultBytes: number;
      };
      steps: Array<Record<string, unknown>>;
      chain: Array<Record<string, unknown>>;
    };
    assert.equal(body.steps.length, PUBLIC_STEP_LIMIT);
    assert.equal(body.chain.length, PUBLIC_STEP_LIMIT);
    assert.equal(body.projection.completedActions.length, PUBLIC_STEP_LIMIT);
    assert.equal(body.projection.stepCount, PUBLIC_STEP_LIMIT + 2);
    assert.equal(
      body.projection.resultBytes,
      (PUBLIC_STEP_LIMIT + 1) * Buffer.byteLength(internalResult, "utf8") +
        Buffer.byteLength("final reply", "utf8"),
    );
    assert.equal(body.projection.completedActions.every((action) => !("result" in action)), true);
    assert.equal(body.steps.at(-1)?.["stage"], "reply");
    assert.equal(body.steps.at(-1)?.["result"], "final reply");
    assert.ok(
      body.steps.every(
        (step) => Buffer.byteLength(String(step["result"] ?? ""), "utf8") <= PUBLIC_STEP_RESULT_MAX_BYTES,
      ),
    );

    const limited = await app.request(`/ledger/tasks/${task.id}?limit=2`, { headers: auth });
    assert.equal(limited.status, 200);
    const limitedBody = (await limited.json()) as {
      projection: { completedActions: unknown[] };
      steps: unknown[];
      chain: unknown[];
    };
    assert.equal(limitedBody.projection.completedActions.length, 2);
    assert.equal(limitedBody.steps.length, 2);
    assert.equal(limitedBody.chain.length, 2);

    const byKey = await app.request("/ledger/tasks/by-key/public-read-window?limit=2", {
      headers: auth,
    });
    assert.equal(byKey.status, 200);
    const byKeyBody = (await byKey.json()) as Record<string, unknown>;
    assert.equal("steps" in byKeyBody, false);
    assert.equal(
      (byKeyBody["projection"] as { completedActions: unknown[] }).completedActions.length,
      2,
    );
  });
});

describe("public task write validation", () => {
  test("rejects ill-typed and client-hostile task fields before persistence", async () => {
    const { app, ledger } = makeApp();
    const cases: Array<{ body: Record<string, unknown>; error: string; status: number }> = [
      { body: { intentKey: 42, spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: ".", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "..", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "bad\u0000key", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "bad\nkey", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "bad\u007fkey", spec: {} }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: "object-required" }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: [] }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: null }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: {}, worker: 42 }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: {}, worker: "bad\u0000worker" }, error: "invalid_request", status: 400 },
      { body: { intentKey: "valid", spec: {}, worker: "   " }, error: "invalid_request", status: 400 },
    ];

    for (const item of cases) {
      const response = await app.request("/ledger/tasks", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(item.body),
      });
      assert.equal(response.status, item.status);
      assert.deepEqual(await response.json(), { error: item.error });
    }
    assert.equal(ledger.listTasks("user-1").length, 0);
  });

  test("rejects oversized public fields, accepts the exact spec byte cap, and leaves internal creation unbounded by the public shape", async () => {
    const { app, ledger } = makeApp();
    const emptySpec = { value: "" };
    const specOverhead = Buffer.byteLength(JSON.stringify(emptySpec), "utf8");
    const atLimitSpec = {
      value: "x".repeat(PUBLIC_TASK_SPEC_MAX_BYTES - specOverhead),
    };
    assert.equal(
      Buffer.byteLength(JSON.stringify(atLimitSpec), "utf8"),
      PUBLIC_TASK_SPEC_MAX_BYTES,
    );

    const oversized = [
      {
        intentKey: "x".repeat(PUBLIC_STEP_ID_MAX_BYTES + 1),
        spec: {},
      },
      {
        intentKey: "oversized-worker",
        spec: {},
        worker: "w".repeat(PUBLIC_STEP_ID_MAX_BYTES + 1),
      },
      {
        intentKey: "oversized-spec",
        spec: {
          value: "x".repeat(PUBLIC_TASK_SPEC_MAX_BYTES - specOverhead + 1),
        },
      },
    ];
    for (const body of oversized) {
      const response = await app.request("/ledger/tasks", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "request_too_large" });
    }
    assert.equal(ledger.listTasks("user-1").length, 0);

    const accepted = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        intentKey: "at-limit",
        spec: atLimitSpec,
        worker: "worker-label",
      }),
    });
    assert.equal(accepted.status, 201);
    const readBack = await app.request("/ledger/tasks/by-key/at-limit", {
      headers: auth,
    });
    assert.equal(readBack.status, 200);
    assert.equal(
      ((await readBack.json()) as { intent_key: string }).intent_key,
      "at-limit",
    );

    const atLimitIds = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        intentKey: "i".repeat(PUBLIC_STEP_ID_MAX_BYTES),
        spec: {},
        worker: "w".repeat(PUBLIC_STEP_ID_MAX_BYTES),
      }),
    });
    assert.equal(atLimitIds.status, 201);

    const internalSpec = JSON.stringify({
      value: "x".repeat(PUBLIC_TASK_SPEC_MAX_BYTES + 1),
    });
    const internal = await getOrCreateTask(ledger, {
      owner: "internal-owner",
      intentKey: "internal-task",
      spec: internalSpec,
      worker: "internal-worker",
    });
    assert.equal(internal.owner, "internal-owner");
    assert.equal(internal.worker, "internal-worker");
  });

  test("applies the body cap to the remaining task write routes", async () => {
    const { app, ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "body-cap", spec: "s" });
    const body = JSON.stringify({
      intentKey: "body-cap-new",
      spec: {},
      padding: "x".repeat(env.MAX_REQUEST_BODY_BYTES),
    });
    for (const path of [
      "/ledger/tasks",
      `/ledger/tasks/${task.id}/cancel`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: auth,
        body,
      });
      assert.equal(response.status, 413, path);
      assert.deepEqual(await response.json(), { error: "request_too_large" });
    }
    assert.equal(ledger.getTaskByIntentKey("user-1", "body-cap-new"), null);
  });

  test("rejects control characters and client-hostile identifiers on read paths", async () => {
    const { app } = makeApp();
    for (const value of ["bad\u0000key", "bad\nkey", "bad\u007fkey"]) {
      const response = await app.request(
        `/ledger/tasks/by-key/${encodeURIComponent(value)}`,
        { headers: auth },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    const oversizePath = `/ledger/tasks/${encodeURIComponent(
      "x".repeat(PUBLIC_STEP_ID_MAX_BYTES + 1),
    )}`;
    const oversizeResponse = await app.request(oversizePath, { headers: auth });
    assert.equal(oversizeResponse.status, 413);
    assert.deepEqual(await oversizeResponse.json(), { error: "request_too_large" });

    const valid = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        intentKey: "message /?#%",
        spec: {},
        worker: "worker-label",
      }),
    });
    assert.equal(valid.status, 201);
    const validRead = await app.request(
      `/ledger/tasks/by-key/${encodeURIComponent("message /?#%")}`,
      { headers: auth },
    );
    assert.equal(validRead.status, 200);
    assert.equal(
      ((await validRead.json()) as { intent_key: string }).intent_key,
      "message /?#%",
    );
  });
});

describe("public task list pagination", () => {
  test("uses the default page, stable offset pages, bounded limits, and a public-only SQL projection", async () => {
    const { app, db, ledger } = makeApp();
    const created = Array.from({ length: PUBLIC_TASK_PAGE_DEFAULT_LIMIT + 3 }, (_, index) =>
      ledger.createTask({
        owner: "user-1",
        intentKey: `page-${index}`,
        spec: "s",
        payload: "x".repeat(20_000),
        jobSpec: "y".repeat(20_000),
      }),
    );
    const expected = created
      .slice()
      .sort((left, right) => left.created_ts - right.created_ts || left.id.localeCompare(right.id))
      .map((task) => task.id);
    const statements = recordPreparedSql(db);

    const firstResponse = await app.request("/ledger/tasks", { headers: auth });
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as Array<{ id: string }>;
    assert.equal(first.length, PUBLIC_TASK_PAGE_DEFAULT_LIMIT);
    assert.equal(firstResponse.headers.get("x-ledger-page-limit"), String(PUBLIC_TASK_PAGE_DEFAULT_LIMIT));
    assert.equal(firstResponse.headers.get("x-ledger-page-offset"), "0");
    assert.equal(firstResponse.headers.get("x-ledger-next-offset"), String(PUBLIC_TASK_PAGE_DEFAULT_LIMIT));
    assert.ok(first.every((task) => !("payload" in task) && !("job_spec" in task)));
    assert.deepEqual(first.map((task) => task.id), expected.slice(0, PUBLIC_TASK_PAGE_DEFAULT_LIMIT));

    const listSql = statements.find(
      (sql) => sql.includes("FROM ledger_task") && sql.includes("ORDER BY created_ts, id"),
    );
    assert.ok(listSql);
    assert.doesNotMatch(listSql, /\bpayload\b/);
    assert.doesNotMatch(listSql, /\bjob_spec\b/);

    const secondResponse = await app.request(
      `/ledger/tasks?limit=2&offset=${PUBLIC_TASK_PAGE_DEFAULT_LIMIT}`,
      { headers: auth },
    );
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as Array<{ id: string }>;
    assert.equal(second.length, 2);
    assert.equal(secondResponse.headers.get("x-ledger-page-limit"), "2");
    assert.equal(secondResponse.headers.get("x-ledger-page-offset"), String(PUBLIC_TASK_PAGE_DEFAULT_LIMIT));
    assert.equal(secondResponse.headers.get("x-ledger-next-offset"), String(PUBLIC_TASK_PAGE_DEFAULT_LIMIT + 2));
    assert.deepEqual(
      [...first, ...second].map((task) => task.id),
      expected.slice(0, PUBLIC_TASK_PAGE_DEFAULT_LIMIT + 2),
    );
    assert.equal(new Set([...first, ...second].map((task) => task.id)).size, first.length + second.length);

    const thirdResponse = await app.request(
      `/ledger/tasks?limit=2&offset=${PUBLIC_TASK_PAGE_DEFAULT_LIMIT + 2}`,
      { headers: auth },
    );
    assert.equal(thirdResponse.status, 200);
    const third = (await thirdResponse.json()) as Array<{ id: string }>;
    assert.equal(third.length, 1);
    assert.equal(thirdResponse.headers.get("x-ledger-next-offset"), null);
    assert.deepEqual(
      [...first, ...second, ...third].map((task) => task.id),
      expected,
    );
    assert.equal(new Set([...first, ...second, ...third].map((task) => task.id)).size, expected.length);

    const maxResponse = await app.request(`/ledger/tasks?limit=${PUBLIC_TASK_PAGE_MAX_LIMIT}`, {
      headers: auth,
    });
    assert.equal(maxResponse.status, 200);
    for (const query of [
      "limit=0",
      `limit=${PUBLIC_TASK_PAGE_MAX_LIMIT + 1}`,
      "limit=-1",
      "offset=-1",
      "offset=not-a-number",
    ]) {
      const invalid = await app.request(`/ledger/tasks?${query}`, { headers: auth });
      assert.equal(invalid.status, 400, query);
      assert.deepEqual(await invalid.json(), { error: "invalid_request" });
    }

    const intruder = new Hono();
    intruder.route(
      "/ledger",
      createLedgerRoutes(ledger, {
        verifyKey: async () => ({ ok: true as const, owner: "intruder" }),
      }),
    );
    const isolated = await intruder.request("/ledger/tasks", { headers: auth });
    assert.equal(isolated.status, 200);
    assert.deepEqual(await isolated.json(), []);
  });
});

describe("ledger task projection and cancellation route", () => {
  test("task reads carry a versioned bounded projection without raw step results", async () => {
    const { app, ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "projected", spec: "s" });
    const claimed = ledger.claimTask(task.id, "user-1");
    ledger.appendStep(
      task.id,
      "user-1",
      { stage: "tool", action: "tool:list", result: "private-result" },
      claimed.fence_token,
    );
    const response = await app.request(`/ledger/tasks/${task.id}`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      projection: Record<string, unknown>;
      steps: Array<Record<string, unknown>>;
    };
    assert.equal(body.projection["schemaVersion"], 1);
    assert.equal(body.projection["code"], "running_model");
    assert.equal(body.projection["canCancel"], false);
    assert.equal(body.projection["effectState"], "completed_steps_only");
    assert.equal("result" in body.projection, false);
    assert.equal(body.steps[0]?.["result"], "private-result");

    const byKey = await app.request(
      "/ledger/tasks/by-key/projected",
      { headers: auth },
    );
    assert.equal(byKey.status, 200);
    const byKeyBody = await byKey.json() as Record<string, unknown>;
    assert.equal("steps" in byKeyBody, false);
    assert.equal(
      (byKeyBody["projection"] as Record<string, unknown>)["effectState"],
      "completed_steps_only",
    );
  });

  test("a failed task is terminal and is not advertised as retryable", async () => {
    const { app, ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "failed", spec: "s" });
    const claimed = ledger.claimTask(task.id, "user-1");
    ledger.completeTask(task.id, "user-1", "failed", claimed.fence_token);

    const response = await app.request(`/ledger/tasks/${task.id}`, {
      headers: auth,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      status: string;
      projection: { terminalStatus?: string; canRetry?: boolean };
    };
    assert.equal(body.status, "failed");
    assert.equal(body.projection.terminalStatus, "failed");
    assert.equal(body.projection.canRetry, false);
  });

  test("cancel reports awaiting_review as terminal and not cancellable", async () => {
    const { ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "review", spec: "s" });
    const claimed = ledger.claimTask(task.id, "user-1");
    ledger.appendStep(
      task.id,
      "user-1",
      { stage: "sentinel", action: "sentinel:flag", result: "{}" },
      claimed.fence_token,
    );
    ledger.completeTask(task.id, "user-1", "awaiting_review", claimed.fence_token);
    const report: TaskCancelReport = {
      schemaVersion: 1,
      taskId: task.id,
      stage: "already-terminal",
      reachedStage: "already-terminal",
      taskStatus: "awaiting_review",
      cancellable: false,
      terminalStatus: "awaiting_review",
      effectState: "completed_steps_only",
      completedActions: [{
        id: "step-1",
        stage: "sentinel",
        action: "sentinel:flag",
        completed: true,
      }],
      projection: {
        schemaVersion: 1,
        code: "review",
        lastActionId: "step-1",
        canCancel: false,
        canRetry: false,
        cancellationPending: false,
        effectState: "completed_steps_only",
        terminalStatus: "awaiting_review",
      },
    };
    const runner = {
      cancelTask: (id: string, owner: string) =>
        owner === "user-1" && id === task.id ? report : null,
      getTaskExecution: () => undefined,
    } as unknown as JobRunner;
    const { app } = makeApp(undefined, runner);

    const response = await app.request(`/ledger/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), report);
    assert.equal(ledger.getTask(task.id, "user-1")?.status, "awaiting_review");
  });

  test("cancel is owner-scoped, tombstone-aware, and unavailable without a controller", async () => {
    const { ledger } = makeApp();
    const task = ledger.createTask({ owner: "user-1", intentKey: "owned", spec: "s" });
    const runner = {
      cancelTask: (_id: string, owner: string) =>
        owner === "user-1" ? null : null,
      getTaskExecution: () => undefined,
    } as unknown as JobRunner;

    const intruder = makeApp(
      async () => ({ ok: true as const, owner: "intruder" }),
      runner,
    );
    const denied = await intruder.app.request(`/ledger/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "not_found" });

    const unavailable = await makeApp().app.request(`/ledger/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "background_unavailable" });

    markDeleting("user-1");
    try {
      const tombstoned = await makeApp(undefined, runner).app.request(
        `/ledger/tasks/${task.id}/cancel`,
        { method: "POST", headers: auth },
      );
      assert.equal(tombstoned.status, 403);
      assert.deepEqual(await tombstoned.json(), { error: "account_deleted" });
    } finally {
      clearDeleting("user-1");
    }
    assert.equal(ledger.getTask(task.id, "user-1")?.status, "queued");
  });
});

describe("public ledger route surface", () => {
  test("the remaining public routes resolve to their handlers", async () => {
    // A removed or typo'd path would 404 here; each remaining route must reach
    // its handler and produce a positive response.
    const report = { stage: "already-terminal" } as unknown as TaskCancelReport;
    const runner = {
      cancelTask: () => report,
      getTaskExecution: () => undefined,
    } as unknown as JobRunner;
    const { app } = makeApp(undefined, runner);

    const created = await createTask(app, "route-surface");

    const byId = await app.request(`/ledger/tasks/${created.id}`, { headers: auth });
    assert.equal(byId.status, 200, "GET /ledger/tasks/:id resolves");

    const byKey = await app.request("/ledger/tasks/by-key/route-surface", { headers: auth });
    assert.equal(byKey.status, 200, "GET /ledger/tasks/by-key/:intentKey resolves");

    const list = await app.request("/ledger/tasks", { headers: auth });
    assert.equal(list.status, 200, "GET /ledger/tasks resolves");

    const second = await app.request("/ledger/tasks", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ intentKey: "route-surface-2", spec: {} }),
    });
    assert.equal(second.status, 201, "POST /ledger/tasks resolves");

    const cancel = await app.request(`/ledger/tasks/${created.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 200, "POST /ledger/tasks/:id/cancel resolves");

    // The worker-facing control routes were removed from the public surface.
    // They must stay gone: a resurrected handler would make these 200/4xx
    // instead of 404.
    for (const removed of ["claim", "steps", "heartbeat", "resume", "complete"]) {
      const res = await app.request(`/ledger/tasks/${created.id}/${removed}`, {
        method: "POST",
        headers: auth,
      });
      assert.equal(res.status, 404, `POST /ledger/tasks/:id/${removed} is removed`);
    }
  });
});
