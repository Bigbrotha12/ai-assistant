import "./test_env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Hono } from "hono";
import { HumanMessage } from "@langchain/core/messages";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import {
  API_KEY_PLUGIN_OPTIONS,
  createAccountDeletionHooks,
  type AccountDeletionRuntime,
} from "../src/auth.ts";
import {
  clearDeleting,
  handleAccountDeletionAPIError,
  isDeleting,
  markDeleting,
  runWithAccountDeletionRequest,
} from "../src/account_deletion.ts";
import { CredentialPinStore } from "../src/credentials/pins.ts";
import { createToolResultCache } from "../src/middleware/cache.ts";
import { createSessionStore } from "../src/sessions/store.ts";
import { createLedgerRoutes } from "../src/ledger.routes.ts";
import { Ledger, migrateLedger } from "../src/ledger.ts";
import type { OwnerPurgeResult } from "../src/ledger.ts";
import { NotifyStore } from "../src/notify/store.ts";
import { createNotifyRoutes } from "../src/notify/routes.ts";
import { testPasswordHasher } from "./better_auth_test_password.ts";

const BASE = "http://localhost:17600";
const NOTIFY_KEY = "account-delete-test-notify-key-32";
const PASSWORD = "password-123";

// In-memory ledger with a controlled clock (mirrors test/ledger.test.ts):
// deterministic created_ts ordering plus the ability to age a heartbeat past
// the stuck timeout.
function makeLedgerHarness() {
  const db = new Database(":memory:");
  migrateLedger(db);
  let now = 1_000_000;
  const ledger = new Ledger(db, {
    stuckTimeoutMs: 10_000,
    leaseExpiryMs: 60_000,
    now: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  return { db, ledger, advance };
}

type SeededOwner = {
  queued: string;
  running: string;
  stuck: string;
  awaitingReview: string;
  succeeded: string;
};

/**
 * One owner's full status mix: three NON-terminal tasks (queued/running/stuck)
 * that must be transitioned to `cancelled` before the delete, and two terminal
 * tasks (awaiting_review/succeeded) that are deleted without a transition.
 * Every creation advances the clock so purge order (created_ts, id) is stable.
 */
function seedOwnerTasks(
  ledger: Ledger,
  advance: (ms: number) => void,
  owner: string,
): SeededOwner {
  const create = (intentKey: string) => {
    advance(1_000);
    return ledger.createTask({ owner, intentKey, spec: "s" });
  };
  const queued = create("q");

  const running = create("r");
  const runningClaim = ledger.claimTask(running.id, owner);
  ledger.appendStep(running.id, owner, {
    stage: "s",
    action: "A",
    result: "r",
  }, runningClaim.fence_token);

  const stuck = create("st");
  ledger.claimTask(stuck.id, owner);
  advance(11_000); // heartbeat stale past the 10s stuck timeout
  assert.equal(ledger.markStuckIfHeartbeatStale(stuck.id)?.status, "stuck");

  const awaitingReview = create("ar");
  const reviewClaim = ledger.claimTask(awaitingReview.id, owner);
  ledger.completeTask(awaitingReview.id, owner, "awaiting_review", reviewClaim.fence_token);

  const succeeded = create("ok");
  const succeededClaim = ledger.claimTask(succeeded.id, owner);
  ledger.completeTask(succeeded.id, owner, "succeeded", succeededClaim.fence_token);

  return {
    queued: queued.id,
    running: running.id,
    stuck: stuck.id,
    awaitingReview: awaitingReview.id,
    succeeded: succeeded.id,
  };
}

/**
 * Throwaway better-auth instance mirroring src/auth.ts over a temp SQLite DB,
 * with the production apiKey options and `createAccountDeletionHooks` wired to
 * an in-memory Ledger + a temp-path NotifyStore — so a real
 * `POST /api/auth/delete-user` exercises the actual cascade.
 */
async function buildFixture(
  getNotifyStore?: (notifyPath: string) => { delete(owner: string): Promise<boolean> },
  runtime?: AccountDeletionRuntime,
) {
  const dir = mkdtempSync(join(tmpdir(), "account-delete-test-"));
  const authDbPath = join(dir, "auth.db");
  const notifyPath = join(dir, "notify.json");

  const { db: ledgerDb, ledger, advance } = makeLedgerHarness();
  const purgeResults: OwnerPurgeResult[] = [];
  const notifyStore = new NotifyStore({ key: NOTIFY_KEY, storePath: notifyPath });

  const db = new Database(authDbPath);
  const hooks = createAccountDeletionHooks({
    db,
    getRuntime: () => runtime,
    purgeLedgerOwner: (owner) => {
      const result = ledger.purgeOwnerData(owner);
      purgeResults.push(result);
      return result;
    },
    getNotifyStore: getNotifyStore
      ? () => getNotifyStore(notifyPath)
      : () => notifyStore,
  });

  const config = {
    appName: "AI Assistant",
    secret: "test-secret-at-least-thirty-two-characters",
    baseURL: BASE,
    basePath: "/api/auth",
    database: db,
    emailAndPassword: {
      enabled: true,
      password: testPasswordHasher,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      // better-auth's built-in special rule caps /sign-up at 3 req/10s, and
      // its memory store is a module-global singleton shared across every
      // fixture in this file — 5 sign-ups would trip it. customRules override
      // the special rule (applied last in resolveRateLimitConfig).
      customRules: {
        "/sign-up/email": { window: 60, max: 100 },
      },
    },
    onAPIError: { onError: handleAccountDeletionAPIError },
    user: { deleteUser: { enabled: true, ...hooks } },
    plugins: [apiKey(API_KEY_PLUGIN_OPTIONS), bearer()],
  };
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  const auth = betterAuth(config);
  const app = new Hono();
  app.use("/api/auth/delete-user", (c, next) => {
    if (c.req.method !== "POST") return next();
    return runWithAccountDeletionRequest(() => next());
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return {
    app,
    db,
    ledger,
    ledgerDb,
    purgeResults,
    notifyPath,
    notifyStore,
    advance,
  };
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; data: unknown; cookies: string }> {
  const headers: Record<string, string> = {
    origin: BASE,
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  return { status: res.status, data, cookies };
}

async function signUp(
  app: Hono,
  db: DatabaseType,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await post(app, "/api/auth/sign-up/email", {
    email,
    password: PASSWORD,
    name: email,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.cookies, "autoSignIn must hand back a session cookie");
  const row = db
    .prepare("SELECT id FROM user WHERE email = ?")
    .get(email) as { id: string } | undefined;
  assert.ok(row, `user row for ${email} must exist`);
  return { cookie: res.cookies, userId: row.id };
}

function countRows(
  db: DatabaseType,
  table: string,
  column: string,
  value: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`)
    .get(value) as { c: number };
  return row.c;
}

function countAll(db: DatabaseType, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

const LEDGER_TRIGGERS = [
  "ledger_chain_append_only_delete",
  "ledger_chain_append_only_update",
  "ledger_step_append_only_delete",
  "ledger_step_append_only_update",
];

describe("M12: account deletion cascade (POST /api/auth/delete-user)", () => {
  test("happy path: user/sessions/apikey/notify/ledger purged for the owner, bystander untouched, triggers restored", async () => {
    const f = await buildFixture();

    const victim = await signUp(f.app, f.db, "victim@example.com");
    const bystander = await signUp(f.app, f.db, "bystander@example.com");

    const keyVictim = await post(
      f.app,
      "/api/auth/api-key/create",
      {},
      victim.cookie,
    );
    assert.equal(keyVictim.status, 200, JSON.stringify(keyVictim.data));
    const keyBystander = await post(
      f.app,
      "/api/auth/api-key/create",
      {},
      bystander.cookie,
    );
    assert.equal(keyBystander.status, 200, JSON.stringify(keyBystander.data));

    const seed = new NotifyStore({ key: NOTIFY_KEY, storePath: f.notifyPath });
    await seed.set(victim.userId, {
      topic: "topic-victim",
      accessToken: "token-victim",
    });
    await seed.set(bystander.userId, {
      topic: "topic-bystander",
      accessToken: "token-bystander",
    });

    const seeded = seedOwnerTasks(f.ledger, f.advance, victim.userId);
    f.advance(1_000);
    const bystanderTask = f.ledger.createTask({
      owner: bystander.userId,
      intentKey: "b",
      spec: "s",
    });
    f.ledger.claimTask(bystanderTask.id, bystander.userId);
    f.ledger.appendStep(bystanderTask.id, bystander.userId, {
      stage: "s",
      action: "B",
      result: "keep",
    });

    const beforeSteps = countAll(f.ledgerDb, "ledger_step");
    assert.equal(beforeSteps, 2, "victim's running task + bystander's task");

    const del = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      victim.cookie,
    );
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.deepEqual(del.data, { success: true, message: "User deleted" });

    // The ledger purge ran exactly once and reported the cancel-before-delete.
    assert.deepEqual(f.purgeResults, [
      {
        cancelled: [
          { id: seeded.queued, from: "queued" },
          { id: seeded.running, from: "running" },
          { id: seeded.stuck, from: "stuck" },
        ],
        deletedTasks: 5,
      },
    ]);

    // better-auth rows: user + sessions gone, apikey swept by the hook.
    assert.equal(countRows(f.db, "user", "id", victim.userId), 0);
    assert.equal(countRows(f.db, "session", "userId", victim.userId), 0);
    assert.equal(countRows(f.db, "apikey", "referenceId", victim.userId), 0);
    assert.equal(countRows(f.db, "user", "id", bystander.userId), 1);
    assert.equal(
      countRows(f.db, "apikey", "referenceId", bystander.userId),
      1,
    );

    // Notify credentials: victim's gone, bystander's intact (fresh read).
    const fresh = new NotifyStore({
      key: NOTIFY_KEY,
      storePath: f.notifyPath,
    });
    assert.equal(await fresh.get(victim.userId), undefined);
    assert.equal((await fresh.get(bystander.userId))?.topic, "topic-bystander");

    // Ledger rows: victim fully purged (task + step + chain), bystander kept.
    assert.equal(
      countRows(f.ledgerDb, "ledger_task", "owner", victim.userId),
      0,
    );
    assert.equal(
      countRows(f.ledgerDb, "ledger_task", "owner", bystander.userId),
      1,
    );
    assert.equal(countAll(f.ledgerDb, "ledger_step"), 1);
    assert.equal(countAll(f.ledgerDb, "ledger_chain"), 1);
    assert.equal(f.ledger.listSteps(bystanderTask.id, bystander.userId).length, 1);

    // All 4 append-only triggers were recreated inside the purge transaction.
    const triggers = (
      f.ledgerDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ledger_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    assert.deepEqual(triggers, LEDGER_TRIGGERS);

    // Guards are back in force (the bystander's rows reject direct writes).
    assert.throws(
      () =>
        f.ledgerDb
          .prepare("DELETE FROM ledger_step WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );
    assert.throws(
      () =>
        f.ledgerDb
          .prepare("DELETE FROM ledger_chain WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );
    assert.throws(
      () =>
        f.ledgerDb
          .prepare("UPDATE ledger_step SET action='x' WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );
  });

  test("deletion and notify routes share one store snapshot; deleting one owner cannot resurrect it", async () => {
    const f = await buildFixture();
    const victim = await signUp(f.app, f.db, "notify-shared-victim@example.com");
    const bystander = await signUp(f.app, f.db, "notify-shared-bystander@example.com");
    const owners: Record<string, string> = {
      "victim-key": victim.userId,
      "bystander-key": bystander.userId,
    };
    const notifyApp = new Hono();
    notifyApp.route(
      "/api/notify",
      createNotifyRoutes({
        store: f.notifyStore,
        verifyKey: async (c) => {
          const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
          const owner = token ? owners[token] : undefined;
          return owner
            ? { ok: true as const, owner }
            : { ok: false as const, reason: "bad_key" as const };
        },
      }),
    );

    const victimProvision = await notifyApp.request("/api/notify/provision", {
      method: "POST",
      headers: { authorization: "Bearer victim-key" },
    });
    assert.equal(victimProvision.status, 200);
    const bystanderProvision = await notifyApp.request("/api/notify/provision", {
      method: "POST",
      headers: { authorization: "Bearer bystander-key" },
    });
    assert.equal(bystanderProvision.status, 200);
    const { topic, accessToken } = (await bystanderProvision.json()) as {
      topic: string;
      accessToken: string;
    };
    const bystanderCredentials = { topic, accessToken };

    const deleted = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      victim.cookie,
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const afterDelete = new NotifyStore({
      key: NOTIFY_KEY,
      storePath: f.notifyPath,
    });
    assert.equal(await afterDelete.get(victim.userId), undefined);
    assert.deepEqual(await afterDelete.get(bystander.userId), bystanderCredentials);

    const rotated = await notifyApp.request("/api/notify/rotate", {
      method: "POST",
      headers: { authorization: "Bearer bystander-key" },
    });
    assert.equal(rotated.status, 200);

    const fresh = new NotifyStore({ key: NOTIFY_KEY, storePath: f.notifyPath });
    assert.equal(await fresh.get(victim.userId), undefined);
    const rotatedBystander = await fresh.get(bystander.userId);
    assert.equal(rotatedBystander?.topic, bystanderCredentials.topic);
    assert.equal(typeof rotatedBystander?.accessToken, "string");
  });

  test("RAM cleanup runs in order, purges only the deleted owner, and leaves its tombstone", async (t) => {
    const sessionStore = createSessionStore();
    const toolCache = createToolResultCache();
    const pins = new CredentialPinStore();
    t.after(() => {
      sessionStore.dispose();
      toolCache.dispose();
    });
    const order: string[] = [];
    const runtime: AccountDeletionRuntime = {
      abortOwner: (owner) => order.push(`abort:${owner}`),
      deleteSessionsForOwner: (owner) => {
        order.push(`sessions:${owner}`);
        return sessionStore.deleteSessionsForOwner(owner);
      },
      invalidateForUser: (owner) => {
        order.push(`cache:${owner}`);
        toolCache.invalidateForUser(owner);
      },
      releaseOwner: (owner) => {
        order.push(`pins:${owner}`);
        return pins.releaseOwner(owner);
      },
    };
    const f = await buildFixture((notifyPath) => {
      const store = new NotifyStore({ key: NOTIFY_KEY, storePath: notifyPath });
      return {
        delete: async (owner: string) => {
          order.push(`notify:${owner}`);
          return store.delete(owner);
        },
      };
    }, runtime);

    const victim = await signUp(f.app, f.db, "ram-victim@example.com");
    const bystander = await signUp(f.app, f.db, "ram-bystander@example.com");
    await post(f.app, "/api/auth/api-key/create", {}, victim.cookie);
    await post(f.app, "/api/auth/api-key/create", {}, bystander.cookie);

    await sessionStore.establish(victim.userId, "v1", [new HumanMessage("victim")]);
    await sessionStore.establish(victim.userId, "v2", [new HumanMessage("victim 2")]);
    await sessionStore.establish(bystander.userId, "b1", [new HumanMessage("bystander")]);
    const victimKey = {
      owner: victim.userId,
      pluginId: "plugin",
      pluginVersion: "1",
      credentialFingerprint: "fp",
      tool: "tool",
      argsHash: "args",
    };
    const bystanderKey = { ...victimKey, owner: bystander.userId, argsHash: "other" };
    toolCache.set(victimKey, "victim-result");
    toolCache.set(bystanderKey, "bystander-result");
    pins.pin(victim.userId, "plugin", { apiKey: "victim" });
    pins.pin(bystander.userId, "plugin", { apiKey: "bystander" });

    const deleted = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      victim.cookie,
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.deepEqual(order, [
      `abort:${victim.userId}`,
      `sessions:${victim.userId}`,
      `cache:${victim.userId}`,
      `pins:${victim.userId}`,
      `notify:${victim.userId}`,
    ]);
    assert.equal(isDeleting(victim.userId), true);
    assert.equal(isDeleting(bystander.userId), false);
    assert.equal(sessionStore.count(victim.userId), 0);
    assert.equal(sessionStore.count(bystander.userId), 1);
    assert.equal(toolCache.get(victimKey), undefined);
    assert.equal(toolCache.get(bystanderKey), "bystander-result");
    assert.throws(() => pins.get(victim.userId, "plugin"));
    assert.equal(pins.get(bystander.userId, "plugin").credentials.apiKey, "bystander");
  });

  test("a failed RAM step clears the tombstone before durable cleanup and a retry succeeds", async () => {
    let sessionPurgeAttempts = 0;
    const runtime: AccountDeletionRuntime = {
      deleteSessionsForOwner: () => {
        sessionPurgeAttempts += 1;
        if (sessionPurgeAttempts === 1) throw new Error("session store unavailable");
        return 0;
      },
    };
    const f = await buildFixture(undefined, runtime);
    const user = await signUp(f.app, f.db, "ram-failure@example.com");
    await post(f.app, "/api/auth/api-key/create", {}, user.cookie);

    const first = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.ok(first.status >= 400 && first.status < 600, JSON.stringify(first.data));
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.deepEqual(f.purgeResults, [], "durable cleanup must not run after a RAM failure");
    assert.equal(isDeleting(user.userId), false);

    const retry = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(countRows(f.db, "user", "id", user.userId), 0);
    assert.equal(isDeleting(user.userId), true);
    assert.equal(sessionPurgeAttempts, 2);
  });

  test("a delete-user adapter failure after beforeDelete clears the tombstone and a retry succeeds", async () => {
    const f = await buildFixture();
    const user = await signUp(f.app, f.db, "delete-adapter-failure@example.com");
    const key = await post(
      f.app,
      "/api/auth/api-key/create",
      {},
      user.cookie,
    );
    assert.equal(key.status, 200, JSON.stringify(key.data));
    f.db.exec(
      "CREATE TRIGGER fail_session_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;",
    );

    const first = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.equal(first.status, 500);
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.equal(countRows(f.db, "session", "userId", user.userId), 1);
    assert.equal(countRows(f.db, "apikey", "referenceId", user.userId), 0);
    assert.equal(isDeleting(user.userId), false);

    f.db.exec("DROP TRIGGER fail_session_delete");
    const retry = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(countRows(f.db, "user", "id", user.userId), 0);
    assert.equal(isDeleting(user.userId), true);
  });

  test("notify cleanup failure leaves the user intact and a retry succeeds", async () => {
    let notifyDeleteAttempts = 0;
    const f = await buildFixture((notifyPath) => {
      const store = new NotifyStore({ key: NOTIFY_KEY, storePath: notifyPath });
      return {
        delete: async (owner: string) => {
          notifyDeleteAttempts += 1;
          if (notifyDeleteAttempts === 1) throw new Error("notify store unavailable");
          return store.delete(owner);
        },
      };
    });
    const user = await signUp(f.app, f.db, "notify-failure@example.com");
    const seed = new NotifyStore({ key: NOTIFY_KEY, storePath: f.notifyPath });
    await seed.set(user.userId, { topic: "topic-retry", accessToken: "token-retry" });

    const first = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.ok(first.status >= 400 && first.status < 600, JSON.stringify(first.data));
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.equal(isDeleting(user.userId), false, "a failed cleanup clears the tombstone for retry");

    const retry = await post(
      f.app,
      "/api/auth/delete-user",
      { password: PASSWORD },
      user.cookie,
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(countRows(f.db, "user", "id", user.userId), 0);
    assert.equal(isDeleting(user.userId), true, "successful deletion keeps the tombstone");
    assert.equal(notifyDeleteAttempts, 2);
    assert.equal(
      await new NotifyStore({ key: NOTIFY_KEY, storePath: f.notifyPath }).get(user.userId),
      undefined,
    );
  });

  test("no session -> 401 UNAUTHORIZED; hooks never run, account intact", async () => {
    const f = await buildFixture();
    const user = await signUp(f.app, f.db, "nosession@example.com");
    await post(f.app, "/api/auth/api-key/create", {}, user.cookie);

    const del = await post(f.app, "/api/auth/delete-user", {}, undefined);
    assert.equal(del.status, 401, JSON.stringify(del.data));
    assert.equal((del.data as { code?: string }).code, "UNAUTHORIZED");

    assert.deepEqual(f.purgeResults, [], "beforeDelete must not run");
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.equal(countRows(f.db, "apikey", "referenceId", user.userId), 1);
  });

  test("wrong password -> 400 INVALID_PASSWORD; hooks never run, account intact", async () => {
    const f = await buildFixture();
    const user = await signUp(f.app, f.db, "wrongpw@example.com");
    await post(f.app, "/api/auth/api-key/create", {}, user.cookie);

    const del = await post(
      f.app,
      "/api/auth/delete-user",
      { password: "definitely-not-the-password" },
      user.cookie,
    );
    assert.equal(del.status, 400, JSON.stringify(del.data));
    assert.equal((del.data as { code?: string }).code, "INVALID_PASSWORD");

    assert.deepEqual(f.purgeResults, [], "beforeDelete must not run");
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.equal(countRows(f.db, "apikey", "referenceId", user.userId), 1);
  });

  test("a tombstone injected between ledger admission checks fails closed without creating a task", async () => {
    const { ledger } = makeLedgerHarness();
    const owner = "bypass-check-owner";
    let injected = false;
    const guarded = new Proxy(ledger, {
      get(target, property) {
        if (property === "getTaskByIntentKey" && !injected) {
          injected = true;
          markDeleting(owner);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = new Hono();
    app.route(
      "/ledger",
      createLedgerRoutes(guarded, {
        verifyKey: async () => ({ ok: true as const, owner }),
      }),
    );
    try {
      const response = await app.request("/ledger/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentKey: "late", spec: {} }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "account_deleted" });
      assert.equal(ledger.getTaskByIntentKey(owner, "late"), null);
    } finally {
      clearDeleting(owner);
    }
  });

  test("stale session without password -> 400 SESSION_EXPIRED; hooks never run, account intact", async () => {
    const f = await buildFixture();
    const user = await signUp(f.app, f.db, "stale@example.com");
    await post(f.app, "/api/auth/api-key/create", {}, user.cookie);
    const seed = new NotifyStore({ key: NOTIFY_KEY, storePath: f.notifyPath });
    await seed.set(user.userId, { topic: "topic-stale", accessToken: "t" });

    // Age the session past better-auth's default freshAge (1 day) without
    // touching expiresAt — the session is valid but no longer "fresh".
    f.db
      .prepare("UPDATE session SET createdAt = ?")
      .run(new Date(Date.now() - 2 * 86_400_000).toISOString());

    const del = await post(f.app, "/api/auth/delete-user", {}, user.cookie);
    assert.equal(del.status, 400, JSON.stringify(del.data));
    assert.equal((del.data as { code?: string }).code, "SESSION_EXPIRED");

    assert.deepEqual(f.purgeResults, [], "beforeDelete must not run");
    assert.equal(countRows(f.db, "user", "id", user.userId), 1);
    assert.equal(countRows(f.db, "apikey", "referenceId", user.userId), 1);
    const fresh = new NotifyStore({
      key: NOTIFY_KEY,
      storePath: f.notifyPath,
    });
    assert.equal((await fresh.get(user.userId))?.topic, "topic-stale");
  });
});

describe("Ledger.purgeOwnerData (owner-scoped account purge)", () => {
  test("cancels non-terminal via legal transitions, deletes all owner rows, leaves other owners intact, restores triggers", () => {
    const { db, ledger, advance } = makeLedgerHarness();
    const seeded = seedOwnerTasks(ledger, advance, "other");
    advance(1_000);
    const bystanderTask = ledger.createTask({
      owner: "bystander",
      intentKey: "b",
      spec: "s",
    });
    ledger.claimTask(bystanderTask.id, "bystander");
    ledger.appendStep(bystanderTask.id, "bystander", {
      stage: "s",
      action: "B",
      result: "keep",
    });

    const result = ledger.purgeOwnerData("other");
    assert.deepEqual(result, {
      cancelled: [
        { id: seeded.queued, from: "queued" },
        { id: seeded.running, from: "running" },
        { id: seeded.stuck, from: "stuck" },
      ],
      deletedTasks: 5,
    });

    // Every victim row is gone (tasks, steps, chain); terminal tasks were
    // deleted without ever appearing in `cancelled`.
    for (const id of Object.values(seeded)) {
      assert.equal(ledger.getTask(id), null, `${id} must be purged`);
    }
    assert.equal(countAll(db, "ledger_task"), 1);
    assert.equal(countAll(db, "ledger_step"), 1);
    assert.equal(countAll(db, "ledger_chain"), 1);

    // The bystander's running task + step + chain survive untouched.
    assert.equal(ledger.getTask(bystanderTask.id)?.status, "running");
    assert.equal(ledger.listSteps(bystanderTask.id, "bystander").length, 1);

    // All 4 append-only triggers were recreated in the transaction.
    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ledger_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    assert.deepEqual(triggers, LEDGER_TRIGGERS);

    // Guards back in force for subsequent writes.
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM ledger_step WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM ledger_chain WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE ledger_step SET action='x' WHERE task_id = ?")
          .run(bystanderTask.id),
      /append-only/,
    );

    // Idempotent: a repeat purge finds nothing and does not touch triggers.
    assert.deepEqual(ledger.purgeOwnerData("other"), {
      cancelled: [],
      deletedTasks: 0,
    });
    assert.equal(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ledger_%'",
          )
          .all() as { name: string }[]
      ).length,
      4,
    );
  });

  test("purging an owner with no rows is a no-op", () => {
    const { ledger } = makeLedgerHarness();
    assert.deepEqual(ledger.purgeOwnerData("nobody"), {
      cancelled: [],
      deletedTasks: 0,
    });
  });
});
