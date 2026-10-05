import "../test_env.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";

import {
  clearDeleting,
  markDeleting,
} from "../../src/account_deletion.ts";
import type { ResolvedAgentDef } from "../../src/catalog/index.ts";
import { CredentialPinError } from "../../src/credentials/pins.ts";
import type { CredentialPin } from "../../src/credentials/pins.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import { GOAL_MAX_CONCURRENT_PER_OWNER } from "../../src/goals/constants.ts";
import { GoalLedger } from "../../src/goals/ledger.ts";
import { GoalError } from "../../src/goals/errors.ts";
import { createGoalRoutes } from "../../src/goals/routes.ts";
import { createGoalRunner } from "../../src/goals/runner.ts";
import type { GoalRunner } from "../../src/goals/runner.ts";
import type { GoalRow } from "../../src/goals/types.ts";
import { migrateLedger, PUBLIC_TASK_SPEC_MAX_BYTES } from "../../src/ledger.ts";
import type { PluginRegistry } from "../../src/plugins/registry.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";

/**
 * Phase 3.6 goal route tests (`POST /v1/goals`, `GET /v1/goals/:id`,
 * `POST /v1/goals/:id/cancel`). The `makeApp` idiom mirrors
 * `test/ledger.routes.test.ts`: the app is mounted the way `src/index.ts`
 * mounts it, with the auth verifier swapped for a deterministic stub. The
 * goal runner is real but its claim timer is a fake scheduler that never
 * fires, so admitted goals stay `queued` and the routes' admission/cancel
 * behavior is fully deterministic. No model call ever runs.
 */

const EPOCH = 1_700_000_000_000;

function makeFakeScheduler() {
  const timers = new Map<ReturnType<typeof setInterval>, () => void>();
  return {
    setInterval: ((fn: () => void) => {
      const handle = {} as unknown as ReturnType<typeof setInterval>;
      timers.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: unknown) => {
      timers.delete(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval,
  };
}

/** Pin store recording mint/release traffic (the "no double-pin" observer). */
class RecordingPinStore extends CredentialPinStore {
  readonly pinCalls: { owner: string; pluginId: string; handle: string }[] = [];
  readonly releaseCalls: {
    owner: string;
    pluginId: string;
    handle?: string;
  }[] = [];

  override pin(
    owner: string,
    pluginId: string,
    credentials: Record<string, string>,
  ): CredentialPin {
    const pin = super.pin(owner, pluginId, credentials);
    this.pinCalls.push({ owner, pluginId, handle: pin.handle });
    return pin;
  }

  override release(
    owner: string,
    pluginId: string,
    handle?: string,
  ): void {
    this.releaseCalls.push({ owner, pluginId, handle });
    super.release(owner, pluginId, handle);
  }
}

const stubRegistry = {
  requirePlugin() {
    throw new Error("goal route tests bind no plugin tools");
  },
} as unknown as PluginRegistry;

const mealieAgent: ResolvedAgentDef = {
  id: "mealie-agent",
  name: "Meal planner",
  description: "test agent",
  systemPrompt: "plan the meals",
  skills: [],
  mcpServers: [{ name: "mealie", url: "https://mealie.example.com/mcp" }],
  toolAllowlist: [{ name: "list_recipes", readOnly: true }],
};

const auth = {
  authorization: "Bearer test-key",
  "content-type": "application/json",
};

type TestApp = {
  app: Hono;
  db: Database.Database;
  goalLedger: GoalLedger;
  pins: RecordingPinStore;
  goalRunner: GoalRunner;
};

/**
 * Build the goal app the way src/index.ts does (`app.route("/v1", ...)`) with
 * the auth verifier and agent lookup stubbed. The runner is constructed with
 * the same dedicated pin store the routes mint into, so pin registration and
 * release are observable end-to-end.
 */
function makeApp(
  t: TestContext,
  verifyKey?: VerifyApiKeyFn,
  agent: ResolvedAgentDef = mealieAgent,
): TestApp {
  const db = new Database(":memory:");
  migrateLedger(db);
  const goalLedger = new GoalLedger(db);
  const pins = new RecordingPinStore();
  const scheduler = makeFakeScheduler();
  const goalRunner = createGoalRunner({
    goalLedger,
    registry: stubRegistry,
    pins,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
  });
  t.after(() => goalRunner.dispose());
  const resolveAgent = async (
    id: string,
  ): Promise<ResolvedAgentDef | undefined> =>
    id === agent.id ? agent : undefined;
  const app = new Hono();
  app.route(
    "/v1",
    createGoalRoutes({
      goalLedger,
      goalRunner,
      pins,
      resolveAgent,
      verifyKey:
        verifyKey ?? (async () => ({ ok: true as const, owner: "user-1" })),
    }),
  );
  return { app, db, goalLedger, pins, goalRunner };
}

const INSTRUCTION = "plan tomorrow's meals, no shellfish, high protein";

function postBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instruction: INSTRUCTION,
    agent: "mealie-agent",
    modelPluginId: "openrouter",
    tokenBudget: 200_000,
    clientGoalId: "client-goal-1",
    credentials: { openrouter: { apiKey: "sk-test" } },
    ...overrides,
  });
}

async function postGoal(
  app: Hono,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return app.request("/v1/goals", {
    method: "POST",
    headers: auth,
    body: postBody(overrides),
  });
}

type PostBody = {
  goalId: string;
  status: string;
  todos: unknown[];
  createdAt: string;
};

describe("goal routes — POST /v1/goals admission", () => {
  test("201: goal row created, instruction appended as the first user message, pin registered", async (t) => {
    const { app, goalLedger, pins, goalRunner } = makeApp(t);

    const res = await postGoal(app);
    assert.equal(res.status, 201);
    const body = (await res.json()) as PostBody;
    assert.match(body.goalId, /^g_/);
    assert.equal(body.status, "queued");
    assert.deepEqual(body.todos, []);

    // The goal row carries the durable admission state.
    const goal = goalLedger.getGoal(body.goalId) as GoalRow;
    assert.ok(goal);
    assert.equal(goal.owner, "user-1");
    assert.equal(goal.status, "queued");
    assert.equal(goal.instruction, INSTRUCTION);
    assert.equal(goal.idempotency_key, "client-goal-1");
    assert.equal(goal.token_budget, 200_000);
    assert.equal(goal.pinned_model, "openrouter");
    assert.equal(goal.lease_token, null);
    assert.equal(body.createdAt, new Date(goal.created_ts).toISOString());
    const snapshot = JSON.parse(goal.agent_snapshot!) as { id: string };
    assert.equal(snapshot.id, "mealie-agent");

    // The instruction is the log's FIRST `user` row (the step input seed).
    const messages = goalLedger.listGoalMessages(body.goalId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.seq, 1);
    assert.equal(JSON.parse(messages[0]!.content_json), INSTRUCTION);

    // One pin minted and registered in the runner's goalPins registry.
    assert.equal(pins.pinCalls.length, 1);
    assert.equal(pins.pinCalls[0]!.pluginId, "openrouter");
    assert.doesNotThrow(() => pins.get("user-1", "openrouter"));
    assert.equal(goalRunner.releaseGoalPin(body.goalId), 1);
  });

  test("repeat submit with the same clientGoalId returns the existing goal: no second message, no second pin", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);

    const first = await postGoal(app);
    assert.equal(first.status, 201);
    const created = (await first.json()) as PostBody;

    // The idempotent re-get is a 200 carrying the CURRENT goal state (the
    // 201 shape is shared, but a repeat is not a new creation). WIRE_SPEC §12
    // only documents the 201 — the re-get status is an implementation choice.
    const second = await postGoal(app, { instruction: "DIFFERENT instruction" });
    assert.equal(second.status, 200);
    const repeated = (await second.json()) as PostBody;
    assert.equal(repeated.goalId, created.goalId);

    // CREATE-ONLY semantics: the idempotent re-get appends nothing and never
    // double-pins (a second pin could leak a credential handle forever).
    const messages = goalLedger.listGoalMessages(created.goalId);
    assert.equal(messages.length, 1);
    assert.equal(JSON.parse(messages[0]!.content_json), INSTRUCTION);
    assert.equal(pins.pinCalls.length, 1);
  });

  test("a repeat submit succeeds even when the concurrency cap is full (idempotency precedes the cap)", async (t) => {
    const { app } = makeApp(t);
    const first = await postGoal(app);
    assert.equal(first.status, 201);
    const created = (await first.json()) as PostBody;

    // Fill the remaining slots with other goals, then confirm the cap bites for
    // a genuinely new goal.
    for (let i = 0; i < GOAL_MAX_CONCURRENT_PER_OWNER - 1; i++) {
      const filler = await postGoal(app, { clientGoalId: `filler-${i}` });
      assert.equal(filler.status, 201);
    }
    const overflow = await postGoal(app, { clientGoalId: "overflow" });
    assert.equal(overflow.status, 429);

    // The lost-response retry still recovers the original goal: the idempotent
    // re-get runs BEFORE the cap, so a full cap cannot strand the client.
    const retry = await postGoal(app, { instruction: "retry" });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as PostBody).goalId, created.goalId);
  });

  test("agent snapshot persists MCP header REFERENCES only, never resolved secrets (B1)", async (t) => {
    const secret = "super-secret-mealie-token";
    const previous = process.env.MEALIE_TOKEN;
    process.env.MEALIE_TOKEN = secret;
    t.after(() => {
      if (previous === undefined) delete process.env.MEALIE_TOKEN;
      else process.env.MEALIE_TOKEN = previous;
    });
    const agent: ResolvedAgentDef = {
      ...mealieAgent,
      mcpServers: [
        {
          name: "mealie",
          url: "https://mealie.example.com/mcp",
          // The catalog resolves `${MEALIE_TOKEN}` into the literal secret in
          // memory (catalog/mcp.ts); the route must not persist it.
          headers: { Authorization: secret },
          headerRefs: { Authorization: "${MEALIE_TOKEN}" },
        },
      ],
    };
    const { app, goalLedger } = makeApp(t, undefined, agent);
    const res = await postGoal(app);
    assert.equal(res.status, 201);
    const { goalId } = (await res.json()) as PostBody;
    const goal = goalLedger.getGoal(goalId)!;
    assert.ok(
      !goal.agent_snapshot!.includes(secret),
      "resolved secret must never reach agent_snapshot",
    );
    const snapshot = JSON.parse(goal.agent_snapshot!) as {
      mcpServers: { headerRefs?: Record<string, string> }[];
    };
    assert.deepEqual(snapshot.mcpServers[0]!.headerRefs, {
      Authorization: "${MEALIE_TOKEN}",
    });
  });

  test("an agent with a literal (non-reference) MCP header is refused at admission", async (t) => {
    const agent: ResolvedAgentDef = {
      ...mealieAgent,
      mcpServers: [
        {
          name: "mealie",
          url: "https://mealie.example.com/mcp",
          headers: { Authorization: "literal-secret" },
          headerRefs: { Authorization: "literal-secret" },
        },
      ],
    };
    const { app } = makeApp(t, undefined, agent);
    const res = await postGoal(app);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message?: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.message ?? "", /header/i);
  });

  test("M4: authorisedTools are validated, trimmed, deduplicated, and persisted (6.1 admission)", async (t) => {
    const { app, goalLedger } = makeApp(t);

    const res = await postGoal(app, {
      authorisedTools: [
        " create_mealplan ",
        "create_mealplan",
        "upsert_recipe",
      ],
    });
    assert.equal(res.status, 201);
    const { goalId } = (await res.json()) as PostBody;
    const goal = goalLedger.getGoal(goalId)!;
    // De-duplicated (case-sensitive) AFTER trim, persisted as the JSON column —
    // the exact array the `authorize` interceptor reads at dispatch time.
    assert.deepEqual(JSON.parse(goal.authorised_tools!), [
      "create_mealplan",
      "upsert_recipe",
    ]);
  });

  test("M4: omission and an explicit empty list admit with [] authorised_tools", async (t) => {
    const { app, goalLedger } = makeApp(t);

    const omitted = await postGoal(app, { clientGoalId: "omit-tools" });
    assert.equal(omitted.status, 201);
    const omittedGoal = goalLedger.getGoalByIdempotencyKey(
      "user-1",
      "omit-tools",
    )!;
    assert.deepEqual(JSON.parse(omittedGoal.authorised_tools!), []);

    const empty = await postGoal(app, {
      clientGoalId: "empty-tools",
      authorisedTools: [],
    });
    assert.equal(empty.status, 201);
    const emptyGoal = goalLedger.getGoalByIdempotencyKey(
      "user-1",
      "empty-tools",
    )!;
    assert.deepEqual(JSON.parse(emptyGoal.authorised_tools!), []);
  });

  test("M4: a malformed authorisedTools is 400 invalid_request and admits nothing", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);

    const cases: Record<string, unknown>[] = [
      { authorisedTools: "create_mealplan" }, // not an array
      { authorisedTools: [123] }, // non-string entry
      { authorisedTools: ["   "] }, // empty after trim
      { authorisedTools: ["line\nbreak"] }, // control character
      {
        authorisedTools: Array.from({ length: 33 }, (_, i) => `tool-${i}`),
      }, // > 32 distinct entries
      { authorisedTools: ["goal_complete"] }, // control-tool names are refused
      { authorisedTools: ["update_plan"] },
      { authorisedTools: ["goal_blocked"] },
      { authorisedTools: ["a".repeat(257)] }, // past the 256-byte bound
    ];
    for (const [index, overrides] of cases.entries()) {
      const clientGoalId = `bad-tools-${index}`;
      const res = await postGoal(app, { clientGoalId, ...overrides });
      assert.equal(
        res.status,
        400,
        `case ${index}: ${JSON.stringify(overrides)}`,
      );
      assert.deepEqual(await res.json(), { error: "invalid_request" });
      assert.equal(
        goalLedger.getGoalByIdempotencyKey("user-1", clientGoalId),
        undefined,
        `case ${index} must never create a goal`,
      );
    }
    // Every refusal happened before any credential pin was minted.
    assert.equal(pins.pinCalls.length, 0);
  });

  test("an empty authorisedTools array is admitted (the guard is non-empty only)", async (t) => {
    const { app } = makeApp(t);

    const res = await postGoal(app, { authorisedTools: [] });
    assert.equal(res.status, 201);
  });

  test("past GOAL_MAX_CONCURRENT_PER_OWNER active goals -> 429 busy (§5.1 retryable)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    for (let i = 0; i < GOAL_MAX_CONCURRENT_PER_OWNER; i++) {
      goalLedger.getOrCreateGoal({
        owner: "user-1",
        idempotencyKey: `seed-${i}`,
        instruction: `seed goal ${i}`,
        tokenBudget: 1_000,
        agentSnapshot: "{}",
        pinnedModel: "openrouter",
      });
    }
    assert.equal(
      goalLedger.countActiveGoals("user-1"),
      GOAL_MAX_CONCURRENT_PER_OWNER,
    );

    const res = await postGoal(app, { clientGoalId: "one-too-many" });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      error: "busy",
      message: "goal concurrency limit reached",
    });
    // The cap is checked before any credential is minted.
    assert.equal(pins.pinCalls.length, 0);
  });

  test("an unknown agent template is 400 template_not_found (chat convention)", async (t) => {
    const { app } = makeApp(t);

    const res = await postGoal(app, { agent: "ghost" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "invalid_request",
      message: "template_not_found: ghost",
    });
  });

  test("unauthorized -> 401 (verifyKey gate), and a deleting owner is 403", async (t) => {
    const denied = makeApp(
      t,
      async () => ({ ok: false as const, reason: "bad_key" as const }),
    );
    const res = await postGoal(denied.app);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });

    const { app } = makeApp(t);
    markDeleting("user-1");
    t.after(() => clearDeleting("user-1"));
    const deleted = await postGoal(app, { clientGoalId: "deleting" });
    assert.equal(deleted.status, 403);
    assert.deepEqual(await deleted.json(), { error: "account_deleted" });
  });
});

describe("goal routes — GET /v1/goals/:id", () => {
  test("full §12 shape: todos/effectState/unresolvedMutations/steps parse", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    assert.equal(res.status, 201);
    const { goalId } = (await res.json()) as PostBody;

    // Seed the derived/read columns the runner and M4 own: todos, spend,
    // steps and a mutation row (`effectState` is derived from state).
    db.prepare("UPDATE goal SET todos = ?, tokens_spent = 41230 WHERE id = ?").run(
      JSON.stringify([
        { text: "build the meal plan", done: true },
        { text: "check protein targets", done: false },
      ]),
      goalId,
    );
    const step1 = goalLedger.insertGoalStep(goalId, "user-1", {
      kind: "model",
      mutating: false,
      messageFromSeq: 1,
      messageToSeq: 1,
      tokens: 1234,
    });
    goalLedger.markStepTerminal(goalId, "user-1", step1.seq);
    const step2 = goalLedger.insertGoalStep(goalId, "user-1", {
      kind: "plan",
      mutating: false,
      tokens: 12,
    });
    goalLedger.markStepTerminal(goalId, "user-1", step2.seq);
    db.prepare(
      `INSERT INTO goal_mutation
         (id, goal_id, plugin_id, tool, args_hash, state, step_seq, created_ts)
       VALUES ('mut-applied', ?, 'mealie', 'create_mealplan', 'hash-a', 'applied', 1, ?)`,
    ).run(goalId, EPOCH);
    db.prepare(
      `INSERT INTO goal_mutation
         (id, goal_id, plugin_id, tool, args_hash, state, step_seq, created_ts)
       VALUES ('mut-unresolved', ?, 'mealie', 'create_mealplan', 'hash-u', 'unresolved', 2, ?)`,
    ).run(goalId, EPOCH + 1);

    const getRes = await app.request(`/v1/goals/${goalId}`, { headers: auth });
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      goalId,
      status: "queued",
      pauseReason: null,
      pauseQuestion: null,
      resultSummary: null,
      failureReason: null,
      instruction: INSTRUCTION,
      todos: [
        { text: "build the meal plan", done: true },
        { text: "check protein targets", done: false },
      ],
      tokenBudget: 200_000,
      tokensSpent: 41230,
      effectState: "unknown",
      canCancel: true,
      canResume: false,
      terminal: false,
      unresolvedMutations: [{ tool: "create_mealplan", argsHash: "hash-u" }],
      steps: [
        { seq: 1, kind: "model", status: "terminal", tokens: 1234 },
        { seq: 2, kind: "plan", status: "terminal", tokens: 12 },
      ],
      updatedAt: new Date(
        goalLedger.getGoal(goalId)!.updated_ts,
      ).toISOString(),
    });
  });

  test("a malformed todos column parses defensively as [] (a read never 500s)", async (t) => {
    const { app, db } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    db.prepare("UPDATE goal SET todos = 'not-json' WHERE id = ?").run(goalId);

    const getRes = await app.request(`/v1/goals/${goalId}`, { headers: auth });
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as { todos: unknown[] };
    assert.deepEqual(body.todos, []);
  });

  test("another owner's goal and a missing id are both 404 (no leak)", async (t) => {
    const { app, goalLedger, pins, goalRunner } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;

    const intruder = new Hono();
    intruder.route(
      "/v1",
      createGoalRoutes({
        goalLedger,
        goalRunner,
        pins,
        resolveAgent: async () => mealieAgent,
        verifyKey: async () => ({ ok: true as const, owner: "intruder" }),
      }),
    );
    const crossOwner = await intruder.request(`/v1/goals/${goalId}`, {
      headers: auth,
    });
    assert.equal(crossOwner.status, 404);
    assert.deepEqual(await crossOwner.json(), { error: "not_found" });

    const missing = await app.request("/v1/goals/g_no-such-goal", {
      headers: auth,
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  });
});

describe("goal routes — POST /v1/goals/:id/cancel", () => {
  test("cancel from queued -> 200 cancelled, lease cleared, pin released", async (t) => {
    const { app, goalLedger, pins, goalRunner } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;

    const cancel = await app.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), {
      goalId,
      status: "cancelled",
      previousStatus: "queued",
      effectState: "none_known",
    });

    const goal = goalLedger.getGoal(goalId)!;
    assert.equal(goal.status, "cancelled");
    assert.equal(goal.lease_owner, null);
    assert.equal(goal.lease_token, null);
    assert.equal(goal.lease_expiry, null);

    // The admitted credential handle is released (registry + store).
    assert.equal(pins.releaseCalls.length, 1);
    assert.equal(pins.releaseCalls[0]!.owner, "user-1");
    assert.equal(pins.releaseCalls[0]!.pluginId, "openrouter");
    assert.equal(goalRunner.releaseGoalPin(goalId), 0);
    assert.throws(
      () => pins.get("user-1", "openrouter"),
      (err: unknown) =>
        err instanceof CredentialPinError && err.code === "pin_not_found",
    );

    // The read surface reflects the terminal state.
    const getRes = await app.request(`/v1/goals/${goalId}`, { headers: auth });
    const body = (await getRes.json()) as {
      status: string;
      terminal: boolean;
      canCancel: boolean;
    };
    assert.equal(body.status, "cancelled");
    assert.equal(body.terminal, true);
    assert.equal(body.canCancel, false);
  });

  test("cancel of a terminal goal -> 409 goal_not_cancellable", async (t) => {
    const { app } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    const first = await app.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(first.status, 200);

    const second = await app.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "goal_not_cancellable" });
  });

  test("cancel is owner-scoped and auth-gated", async (t) => {
    const { app, goalLedger, pins, goalRunner } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;

    const denied = makeApp(
      t,
      async () => ({ ok: false as const, reason: "bad_key" as const }),
    );
    const unauth = await denied.app.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(unauth.status, 401);

    const intruder = new Hono();
    intruder.route(
      "/v1",
      createGoalRoutes({
        goalLedger,
        goalRunner,
        pins,
        resolveAgent: async () => mealieAgent,
        verifyKey: async () => ({ ok: true as const, owner: "intruder" }),
      }),
    );
    const crossOwner = await intruder.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(crossOwner.status, 404);
    // The refusal never touched the goal.
    assert.equal(goalLedger.getGoal(goalId)!.status, "queued");
  });

  test("cancel closes an in-flight step row (no orphaned running step)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    // Put the goal in-flight with a running step, as the runner does.
    goalLedger.claimGoal(goalId, "user-1");
    const step = goalLedger.insertGoalStep(goalId, "user-1", {
      kind: "model",
      mutating: false,
    });
    assert.equal(goalLedger.getGoal(goalId)!.status, "running");

    const cancel = await app.request(`/v1/goals/${goalId}/cancel`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(cancel.status, 200);
    // Boot recovery only repairs RUNNING goals, so a step left `running` under
    // a terminal goal would be orphaned forever.
    const closed = goalLedger
      .listGoalSteps(goalId)
      .find((row) => row.seq === step.seq);
    assert.equal(closed?.status, "terminal");
  });
});

/** Puts an admitted goal into `paused(needs_user_input)` with a live question. */
async function pauseGoal(
  app: Hono,
  goalLedger: GoalLedger,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await postGoal(app, { clientGoalId: `pause-${Math.random()}`, ...overrides });
  assert.equal(res.status, 201);
  const { goalId } = (await res.json()) as PostBody;
  const claimed = goalLedger.claimGoal(goalId, "user-1");
  goalLedger.appendGoalMessage(goalId, "user-1", {
    role: "assistant",
    content: { question: "high protein?" },
  });
  goalLedger.pauseGoal(goalId, "user-1", {
    next: "paused",
    reason: "needs_user_input",
    question: "high protein?",
    leaseOwner: "user-1",
    leaseToken: claimed.lease_token!,
  });
  return goalId;
}

/**
 * Admit + spend-to-budget + pause a goal `paused(budget_exhausted)` with
 * `tokens_spent` exactly at its 200_000 budget — the shape the parallel
 * runner step produces when enforcement trips.
 */
async function pauseBudgetExhausted(
  app: Hono,
  goalLedger: GoalLedger,
  tokensSpent = 200_000,
): Promise<string> {
  const res = await postGoal(app, {
    clientGoalId: `budget-${Math.random()}`,
  });
  assert.equal(res.status, 201);
  const { goalId } = (await res.json()) as PostBody;
  goalLedger.addGoalTokens(goalId, "user-1", tokensSpent);
  const claimed = goalLedger.claimGoal(goalId, "user-1");
  goalLedger.pauseGoal(goalId, "user-1", {
    next: "paused",
    reason: "budget_exhausted",
    leaseOwner: "user-1",
    leaseToken: claimed.lease_token!,
  });
  return goalId;
}

/**
 * Raw `goal_mutation` insert (Phase 6 rows normally come from the pipeline's
 * `reserve` interceptor — M2/M4 tests seed them directly). [pluginId] lets a
 * test seed two rows that share `(tool, args_hash)` under different plugins —
 * the UNIQUE key is `(goal_id, plugin_id, tool, args_hash)` — to exercise the
 * `resolveMutations` ambiguity refusal.
 */
function insertMutation(
  db: Database.Database,
  goalId: string,
  tool: string,
  argsHash: string,
  state: string,
  pluginId = "plugin",
): void {
  db.prepare(
    `INSERT INTO goal_mutation
       (id, goal_id, plugin_id, tool, args_hash, state, step_seq, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    `mut-${goalId}-${pluginId}-${tool}-${argsHash}`,
    goalId,
    pluginId,
    tool,
    argsHash,
    state,
    EPOCH,
  );
}

/**
 * Admit + pause a goal `paused(needs_mutation_resolution)` carrying one
 * `unresolved` mutation — the post-crash shape boot recovery leaves behind
 * (Phase 6, plan §Recovery).
 */
async function pauseForMutationResolution(
  app: Hono,
  db: Database.Database,
  goalLedger: GoalLedger,
  tool: string,
  argsHash: string,
): Promise<string> {
  const res = await postGoal(app, {
    clientGoalId: `paused-mut-${Math.random()}`,
  });
  assert.equal(res.status, 201);
  const { goalId } = (await res.json()) as PostBody;
  insertMutation(db, goalId, tool, argsHash, "unresolved");
  const claimed = goalLedger.claimGoal(goalId, "user-1");
  goalLedger.pauseGoal(goalId, "user-1", {
    next: "paused",
    reason: "needs_mutation_resolution",
    leaseOwner: "user-1",
    leaseToken: claimed.lease_token!,
  });
  return goalId;
}

describe("goal routes — POST /v1/goals/:id/resume (5.1)", () => {
  test("resume re-pins, appends the durable answer, and requeues", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "yes, high protein, no shellfish",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });

    const row = goalLedger.getGoal(goalId)!;
    assert.equal(row.status, "queued");
    // The answered question is cleared — the client must stop offering it.
    assert.equal(row.pause_reason, null);
    assert.equal(row.pause_question, null);
    // The next claim starts a FRESH run's clock.
    assert.equal(row.run_started_ts, null);

    // The answer is durable, after the question: question and answer both in
    // context for the next step (plan §"The question survives").
    const messages = goalLedger.listGoalMessages(goalId);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(JSON.parse(messages[2]!.content_json), "yes, high protein, no shellfish");

    // A NEW credential handle was minted and registered for the goal.
    assert.equal(pins.pinCalls.length, 2);
    assert.doesNotThrow(() => pins.get("user-1", "openrouter"));
    // …and the STALE admission handle the paused goal still carried in the
    // runner registry is released as it is overwritten — otherwise it would
    // sit in the pin store for the full TTL.
    assert.ok(
      pins.releaseCalls.some((call) => call.handle === pins.pinCalls[0]!.handle),
      `the replaced admission pin must be released; ` +
        `released=${JSON.stringify(pins.releaseCalls)}`,
    );
  });

  test("resume of a non-paused goal is 409 goal_not_resumable", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody; // still queued

    const attempt = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "hello",
        credentials: { openrouter: { apiKey: "sk" } },
      }),
    });
    assert.equal(attempt.status, 409);
    assert.deepEqual(await attempt.json(), { error: "goal_not_resumable" });
    // A refused resume appends nothing.
    assert.equal(goalLedger.listGoalMessages(goalId).length, 1);
  });

  test("a resume without credentials is 400 and does not requeue", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answer: "yes" }),
    });
    assert.equal(res.status, 400);
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.listGoalMessages(goalId).length, 2);
  });

  test("resume is owner-scoped and auth-gated", async (t) => {
    const { app, goalLedger, goalRunner, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);

    const denied = makeApp(
      t,
      async () => ({ ok: false as const, reason: "bad_key" as const }),
    );
    const unauth = await denied.app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answer: "x", credentials: { openrouter: { apiKey: "k" } } }),
    });
    assert.equal(unauth.status, 401);

    const intruder = new Hono();
    intruder.route(
      "/v1",
      createGoalRoutes({
        goalLedger,
        goalRunner,
        pins,
        resolveAgent: async () => mealieAgent,
        verifyKey: async () => ({ ok: true as const, owner: "intruder" }),
      }),
    );
    const crossOwner = await intruder.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answer: "x", credentials: { openrouter: { apiKey: "k" } } }),
    });
    assert.equal(crossOwner.status, 404);
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
  });

  test("resume with a higher tokenBudget raises the budget and requeues (Phase 7)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const goalId = await pauseBudgetExhausted(app, goalLedger);
    assert.equal(goalLedger.getGoal(goalId)!.token_budget, 200_000);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "keep going with a bigger budget",
        tokenBudget: 500_000,
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });

    const row = goalLedger.getGoal(goalId)!;
    assert.equal(row.status, "queued");
    assert.equal(row.token_budget, 500_000, "the budget was raised");
    assert.equal(row.tokens_spent, 200_000, "spend is preserved, not reset");
  });

  test("a tokenBudget <= tokensSpent is 400 invalid_request and stays paused (atomic)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    const goalId = await pauseBudgetExhausted(app, goalLedger);
    const messagesBefore = goalLedger.listGoalMessages(goalId).length;
    const pinsBefore = pins.pinCalls.length;

    // At the spend (200_000) and just below it.
    for (const bad of [200_000, 199_999]) {
      const res = await app.request(`/v1/goals/${goalId}/resume`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          answer: "keep going",
          tokenBudget: bad,
          credentials: { openrouter: { apiKey: "sk-resumed" } },
        }),
      });
      assert.equal(res.status, 400, `budget ${bad}`);
      assert.deepEqual(await res.json(), { error: "invalid_request" });
    }

    const row = goalLedger.getGoal(goalId)!;
    assert.equal(row.status, "paused", "refused before the transaction");
    assert.equal(row.token_budget, 200_000, "budget unchanged");
    assert.equal(row.pause_reason, "budget_exhausted");
    assert.equal(
      goalLedger.listGoalMessages(goalId).length,
      messagesBefore,
      "no answer appended (atomic refusal)",
    );
    assert.equal(pins.pinCalls.length, pinsBefore, "no pin minted");
  });

  test("a tokenBudget <= the current budget is 400 invalid_request even when > tokensSpent (stays paused, no answer)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    // Spend 100_000 of the 200_000 budget: a 150_000 raise clears the
    // tokens_spent gate but would LOWER the per-goal budget, so it must be
    // refused before any transaction.
    const goalId = await pauseBudgetExhausted(app, goalLedger, 100_000);
    const messagesBefore = goalLedger.listGoalMessages(goalId).length;
    const pinsBefore = pins.pinCalls.length;

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "keep going",
        tokenBudget: 150_000,
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });

    const row = goalLedger.getGoal(goalId)!;
    assert.equal(row.status, "paused", "refused before the transaction");
    assert.equal(row.token_budget, 200_000, "budget unchanged");
    assert.equal(
      goalLedger.listGoalMessages(goalId).length,
      messagesBefore,
      "no answer appended (atomic refusal)",
    );
    assert.equal(pins.pinCalls.length, pinsBefore, "no pin minted");

    // Strictly greater than BOTH the current budget and tokensSpent still
    // raises and persists.
    const ok = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "keep going with a bigger budget",
        tokenBudget: 250_000,
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { goalId, status: "queued" });

    const raised = goalLedger.getGoal(goalId)!;
    assert.equal(raised.status, "queued");
    assert.equal(raised.token_budget, 250_000, "the budget was raised");
    assert.equal(raised.tokens_spent, 100_000, "spend preserved, not reset");
  });

  test("a non-integer / zero / negative tokenBudget is 400 invalid_request", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const goalId = await pauseBudgetExhausted(app, goalLedger);

    for (const bad of [0, -1, 1.5, "500000", null]) {
      const res = await app.request(`/v1/goals/${goalId}/resume`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          answer: "keep going",
          tokenBudget: bad,
          credentials: { openrouter: { apiKey: "sk-resumed" } },
        }),
      });
      assert.equal(res.status, 400, `tokenBudget ${JSON.stringify(bad)}`);
      assert.deepEqual(await res.json(), { error: "invalid_request" });
    }
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.getGoal(goalId)!.token_budget, 200_000);
  });

  test("resume without tokenBudget leaves the budget unchanged (regression)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const goalId = await pauseBudgetExhausted(app, goalLedger);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "keep going at the same budget",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });
    assert.equal(goalLedger.getGoal(goalId)!.token_budget, 200_000);
  });
});

describe("goal routes — resume with resolveMutations (Phase 6)", () => {
  const MUTATION_TOOL = "create_mealplan";
  const MUTATION_HASH = "hash-abcdef";

  function resumeBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      answer: "yes, proceed",
      credentials: { openrouter: { apiKey: "sk-resumed" } },
      resolveMutations: [
        { tool: MUTATION_TOOL, argsHash: MUTATION_HASH, resolution: "applied" },
      ],
      ...overrides,
    });
  }

  test("applied: the mutation resolves atomically with the resume and effectState becomes completed_steps_only", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const goalId = await pauseForMutationResolution(
      app,
      db,
      goalLedger,
      MUTATION_TOOL,
      MUTATION_HASH,
    );

    // Baseline: the unresolved mutation reports `unknown` on the detail read.
    type Detail = {
      effectState: string;
      unresolvedMutations: { tool: string; argsHash: string }[];
    };
    const before = (await (
      await app.request(`/v1/goals/${goalId}`, { headers: auth })
    ).json()) as Detail;
    assert.equal(before.effectState, "unknown");
    assert.deepEqual(before.unresolvedMutations, [
      { tool: MUTATION_TOOL, argsHash: MUTATION_HASH },
    ]);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });

    const row = goalLedger.getGoal(goalId)!;
    assert.equal(row.status, "queued");
    assert.equal(row.pause_reason, null);
    // The answer WAS appended — the resume + resolution committed together.
    assert.equal(goalLedger.listGoalMessages(goalId).length, 2);
    // The mutation row is now an `applied` tombstone.
    const mutation = db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { state: string };
    assert.equal(mutation.state, "applied");

    const after = (await (
      await app.request(`/v1/goals/${goalId}`, { headers: auth })
    ).json()) as Detail;
    assert.equal(after.effectState, "completed_steps_only");
    assert.deepEqual(after.unresolvedMutations, []);
  });

  test("not_applied: the row is deleted and effectState clears to none_known", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const goalId = await pauseForMutationResolution(
      app,
      db,
      goalLedger,
      MUTATION_TOOL,
      MUTATION_HASH,
    );

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody({
        resolveMutations: [
          {
            tool: MUTATION_TOOL,
            argsHash: MUTATION_HASH,
            resolution: "not_applied",
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });
    assert.equal(goalLedger.getGoal(goalId)!.status, "queued");
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { n: number };
    assert.equal(n, 0, "not_applied deletes the row (R18: no effect escaped)");
    const after = (await (
      await app.request(`/v1/goals/${goalId}`, { headers: auth })
    ).json()) as { effectState: string };
    assert.equal(after.effectState, "none_known");
  });

  test("a malformed resolveMutations is a 400 that changes NOTHING (atomic refusal)", async (t) => {
    const { app, db, goalLedger, pins } = makeApp(t);
    const goalId = await pauseForMutationResolution(
      app,
      db,
      goalLedger,
      MUTATION_TOOL,
      MUTATION_HASH,
    );
    const messagesBefore = goalLedger.listGoalMessages(goalId).length;
    const pinsBefore = pins.pinCalls.length;

    const malformed: Record<string, unknown>[] = [
      // resolution outside the closed union
      {
        resolveMutations: [
          { tool: MUTATION_TOOL, argsHash: MUTATION_HASH, resolution: "bogus" },
        ],
      },
      // missing tool / missing argsHash
      { resolveMutations: [{ argsHash: MUTATION_HASH, resolution: "applied" }] },
      { resolveMutations: [{ tool: MUTATION_TOOL, resolution: "applied" }] },
      // > 50 entries
      {
        resolveMutations: Array.from({ length: 51 }, (_, i) => ({
          tool: `t-${i}`,
          argsHash: `h-${i}`,
          resolution: "applied",
        })),
      },
    ];
    for (const [index, overrides] of malformed.entries()) {
      const res = await app.request(`/v1/goals/${goalId}/resume`, {
        method: "POST",
        headers: auth,
        body: resumeBody(overrides),
      });
      assert.equal(res.status, 400, `case ${index}`);
      assert.deepEqual(await res.json(), { error: "invalid_request" });
    }

    // Atomicity: still paused, no answer appended, no pin minted, and the
    // mutation row is untouched.
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.listGoalMessages(goalId).length, messagesBefore);
    assert.equal(pins.pinCalls.length, pinsBefore);
    const mutation = db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { state: string };
    assert.equal(mutation.state, "unresolved");
    assert.equal(goalLedger.effectState(goalId), "unknown");
  });

  test("an entry not in the unresolved list is refused 400 and the goal stays paused", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const goalId = await pauseForMutationResolution(
      app,
      db,
      goalLedger,
      MUTATION_TOOL,
      MUTATION_HASH,
    );

    // A REAL tool with the WRONG argsHash: the (tool, argsHash) pair must
    // match exactly what the detail endpoint listed.
    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody({
        resolveMutations: [
          { tool: MUTATION_TOOL, argsHash: "hash-wrong", resolution: "applied" },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.listGoalMessages(goalId).length, 1, "no answer was appended");
    const mutation = db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { state: string };
    assert.equal(mutation.state, "unresolved", "nothing was resolved or deleted");
  });

  test("a key matching TWO unresolved rows (different plugin_ids) is refused 400 before any transaction", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const res = await postGoal(app, {
      clientGoalId: `paused-ambig-${Math.random()}`,
    });
    assert.equal(res.status, 201);
    const { goalId } = (await res.json()) as PostBody;
    // Two plugins share BOTH the tool name AND the args hash — possible
    // because the ledger's UNIQUE key is `(goal_id, plugin_id, tool,
    // args_hash)` while the resume entry keys only `(tool, args_hash)` (the
    // §12 list exposes no plugin_id, so the client cannot disambiguate).
    insertMutation(
      db,
      goalId,
      MUTATION_TOOL,
      MUTATION_HASH,
      "unresolved",
      "plugin",
    );
    insertMutation(
      db,
      goalId,
      MUTATION_TOOL,
      MUTATION_HASH,
      "unresolved",
      "plugin-b",
    );
    const claimed = goalLedger.claimGoal(goalId, "user-1");
    goalLedger.pauseGoal(goalId, "user-1", {
      next: "paused",
      reason: "needs_mutation_resolution",
      leaseOwner: "user-1",
      leaseToken: claimed.lease_token!,
    });

    const resume = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody(),
    });
    assert.equal(resume.status, 400);
    assert.deepEqual(await resume.json(), { error: "invalid_request" });
    // The refusal happens at the PRE-CHECK, before the pin or the answer
    // append: a 400, never a 409 rollback leaving the goal un-resumable.
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(
      goalLedger.listGoalMessages(goalId).length,
      1,
      "no answer was appended",
    );
    const rows = db
      .prepare(
        "SELECT state FROM goal_mutation WHERE goal_id = ? ORDER BY plugin_id",
      )
      .all(goalId) as { state: string }[];
    assert.deepEqual(
      rows.map((row) => row.state),
      ["unresolved", "unresolved"],
      "neither ambiguous row was resolved",
    );
  });

  test("the SAME key twice within resolveMutations is refused 400 and the goal stays paused", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const goalId = await pauseForMutationResolution(
      app,
      db,
      goalLedger,
      MUTATION_TOOL,
      MUTATION_HASH,
    );

    // A duplicate entry would hit the same row twice — the second pass sees it
    // resolved and throws INSIDE the transaction. The route must refuse it at
    // the pre-check instead (duplicate keys are a client bug, not a resolution).
    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody({
        resolveMutations: [
          { tool: MUTATION_TOOL, argsHash: MUTATION_HASH, resolution: "applied" },
          {
            tool: MUTATION_TOOL,
            argsHash: MUTATION_HASH,
            resolution: "not_applied",
          },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_request" });
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(
      goalLedger.listGoalMessages(goalId).length,
      1,
      "no answer was appended",
    );
    const mutation = db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { state: string };
    assert.equal(mutation.state, "unresolved", "the row was not resolved or deleted");
  });

  test("resolveMutations with nothing unresolved resolves nothing — resume still 200 (empty path)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    // The NORMAL pause (needs_user_input) carries no mutation rows.
    const goalId = await pauseGoal(app, goalLedger);

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "yes",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
        resolveMutations: [],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });
    assert.equal(goalLedger.getGoal(goalId)!.status, "queued");
    assert.equal(goalLedger.effectState(goalId), "none_known");
  });

  test("resume adopts a straggler `pending` row so it becomes resolvable (N2)", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    // A paused goal carrying a `pending` mutation that the normal paths missed
    // (a `markMutation` settle that missed AND the boot adoption that also
    // missed). `pending` is invisible to `listUnresolvedMutations`, so the
    // client cannot resolve it yet.
    const goalId = await pauseGoal(app, goalLedger);
    insertMutation(db, goalId, MUTATION_TOOL, MUTATION_HASH, "pending");
    assert.equal(goalLedger.effectState(goalId), "unknown");
    assert.deepEqual(
      goalLedger.listUnresolvedMutations(goalId),
      [],
      "a pending row is not listed for resolution",
    );

    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "yes",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
        resolveMutations: [],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { goalId, status: "queued" });
    assert.equal(goalLedger.getGoal(goalId)!.status, "queued");

    // The straggler was adopted `unresolved` inside the resume transaction and
    // is now resolvable via a subsequent GET + resume.
    const mutation = db
      .prepare("SELECT state FROM goal_mutation WHERE goal_id = ?")
      .get(goalId) as { state: string };
    assert.equal(mutation.state, "unresolved");

    const detail = (await (
      await app.request(`/v1/goals/${goalId}`, { headers: auth })
    ).json()) as {
      effectState: string;
      unresolvedMutations: { tool: string; argsHash: string }[];
    };
    assert.equal(detail.effectState, "unknown");
    assert.deepEqual(detail.unresolvedMutations, [
      { tool: MUTATION_TOOL, argsHash: MUTATION_HASH },
    ]);
  });

  test("resolving BEFORE adopting a pending straggler never collides with a pre-validated key under another plugin (N2 ordering)", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const res = await postGoal(app, {
      clientGoalId: `paused-straggler-${Math.random()}`,
    });
    assert.equal(res.status, 201);
    const { goalId } = (await res.json()) as PostBody;
    // The route's pre-check lists `unresolved` rows only, so it validates the
    // 'p1' row below and counts exactly one match for the key. A `pending`
    // straggler sharing `(tool, args_hash)` under plugin 'p2' is legal (the
    // UNIQUE key includes `plugin_id`) and invisible to that pre-check.
    insertMutation(db, goalId, MUTATION_TOOL, MUTATION_HASH, "unresolved", "p1");
    insertMutation(db, goalId, MUTATION_TOOL, MUTATION_HASH, "pending", "p2");
    const claimed = goalLedger.claimGoal(goalId, "user-1");
    goalLedger.pauseGoal(goalId, "user-1", {
      next: "paused",
      reason: "needs_mutation_resolution",
      leaseOwner: "user-1",
      leaseToken: claimed.lease_token!,
    });
    const messagesBefore = goalLedger.listGoalMessages(goalId).length;

    const resume = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: resumeBody(),
    });
    // If the straggler were adopted before the resolution it would become a
    // second key-matching `unresolved` row and `resolveMutations` would throw,
    // surfacing 409 + rollback (and, without resolutions, stranding the pair).
    assert.equal(resume.status, 200);
    assert.deepEqual(await resume.json(), { goalId, status: "queued" });

    // The answer WAS appended — the resume + resolution committed together.
    assert.equal(goalLedger.listGoalMessages(goalId).length, messagesBefore + 1);

    // 'p1' resolved to its `applied` tombstone; 'p2' adopted from `pending`.
    const rows = db
      .prepare(
        "SELECT plugin_id, state FROM goal_mutation WHERE goal_id = ? ORDER BY plugin_id",
      )
      .all(goalId) as { plugin_id: string; state: string }[];
    assert.deepEqual(rows, [
      { plugin_id: "p1", state: "applied" },
      { plugin_id: "p2", state: "unresolved" },
    ]);

    // The adopted straggler is now visible to the NEXT GET for resolution.
    const detail = (await (
      await app.request(`/v1/goals/${goalId}`, { headers: auth })
    ).json()) as {
      effectState: string;
      unresolvedMutations: { tool: string; argsHash: string }[];
    };
    assert.equal(detail.effectState, "unknown");
    assert.deepEqual(detail.unresolvedMutations, [
      { tool: MUTATION_TOOL, argsHash: MUTATION_HASH },
    ]);
  });
});

describe("goal routes — GET /v1/goals + DELETE (5.3)", () => {
  test("list returns the owner's goals newest-first with paging headers", async (t) => {
    const { app } = makeApp(t);
    const first = (await (await postGoal(app, { clientGoalId: "a" })).json()) as PostBody;
    const second = (await (await postGoal(app, { clientGoalId: "b" })).json()) as PostBody;

    const res = await app.request("/v1/goals", { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { goals: { goalId: string; canResume: boolean }[] };
    assert.deepEqual(body.goals.map((g) => g.goalId), [second.goalId, first.goalId]);
    assert.equal(res.headers.get("x-ledger-page-limit"), "50");
    assert.equal(res.headers.get("x-ledger-next-offset"), null);
    assert.equal(body.goals[0]!.canResume, false);

    // Paging: a 1-item page reports a next offset.
    const page = await app.request("/v1/goals?limit=1", { headers: auth });
    const pageBody = (await page.json()) as { goals: { goalId: string }[] };
    assert.equal(pageBody.goals.length, 1);
    assert.equal(pageBody.goals[0]!.goalId, second.goalId);
    assert.equal(page.headers.get("x-ledger-next-offset"), "1");

    const second_page = await app.request("/v1/goals?limit=1&offset=1", { headers: auth });
    const secondBody = (await second_page.json()) as { goals: { goalId: string }[] };
    assert.deepEqual(secondBody.goals.map((g) => g.goalId), [first.goalId]);
  });

  test("list status filter and invalid query are 400-free / 400 respectively", async (t) => {
    const { app } = makeApp(t);
    await postGoal(app, { clientGoalId: "a" });

    const filtered = await app.request("/v1/goals?status=queued", { headers: auth });
    const filteredBody = (await filtered.json()) as { goals: unknown[] };
    assert.equal(filtered.status, 200);
    assert.equal(filteredBody.goals.length, 1);

    const none = await app.request("/v1/goals?status=complete", { headers: auth });
    assert.equal(((await none.json()) as { goals: unknown[] }).goals.length, 0);

    assert.equal((await app.request("/v1/goals?status=bogus", { headers: auth })).status, 400);
    assert.equal((await app.request("/v1/goals?limit=0", { headers: auth })).status, 400);
    assert.equal((await app.request("/v1/goals?limit=999", { headers: auth })).status, 400);
    assert.equal((await app.request("/v1/goals?offset=-1", { headers: auth })).status, 400);
    assert.equal((await app.request("/v1/goals?limit=abc", { headers: auth })).status, 400);
  });

  test("list is owner-scoped and never leaks another owner's goals", async (t) => {
    const { app, goalLedger, goalRunner, pins } = makeApp(t);
    await postGoal(app, { clientGoalId: "mine" });

    const intruder = new Hono();
    intruder.route(
      "/v1",
      createGoalRoutes({
        goalLedger,
        goalRunner,
        pins,
        resolveAgent: async () => mealieAgent,
        verifyKey: async () => ({ ok: true as const, owner: "intruder" }),
      }),
    );
    const res = await intruder.request("/v1/goals", { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { goals: unknown[] }).goals, []);
  });

  test("delete removes a terminal goal and every child row", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    goalLedger.claimGoal(goalId, "user-1");
    goalLedger.insertGoalStep(goalId, "user-1", { kind: "model", mutating: false });
    goalLedger.transitGoal(goalId, "user-1", { next: "complete", summary: "done" });

    const del = await app.request(`/v1/goals/${goalId}`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(del.status, 204);
    assert.equal(goalLedger.getGoal(goalId), undefined);
    for (const table of ["goal_step", "goal_message"]) {
      const { n } = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE goal_id = ?`)
        .get(goalId) as { n: number };
      assert.equal(n, 0, `${table} rows must be deleted`);
    }
    // The write-once triggers are RESTORED after the drop-and-recreate, so the
    // table protects itself again. Probed on a FRESH goal: the deleted goal's row
    // is gone, and `goal_message.goal_id` references `goal(id)`, so a probe
    // message under the deleted id would fail the FK check instead.
    const probe = (await (await postGoal(app, { clientGoalId: "probe" })).json()) as PostBody;
    db.prepare(
      `INSERT INTO goal_message
         (id, goal_id, seq, role, content_json, created_ts)
       VALUES ('m-probe', ?, 2, 'user', '"probe"', ?)`,
    ).run(probe.goalId, EPOCH);
    assert.throws(
      () => db.prepare("DELETE FROM goal_message WHERE id = 'm-probe'").run(),
      /append.only/i,
      "the append-only DELETE trigger must be back after deleteGoal",
    );
  });

  test("delete of a LIVE goal is 409 goal_not_deletable (cancel first)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;

    const del = await app.request(`/v1/goals/${goalId}`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 409);
    assert.deepEqual(await del.json(), { error: "goal_not_deletable" });
    assert.ok(goalLedger.getGoal(goalId), "the goal survives the refusal");

    // Paused is also live: cancel is required first.
    goalLedger.claimGoal(goalId, "user-1");
    const claimed = goalLedger.getGoal(goalId)!;
    goalLedger.pauseGoal(goalId, "user-1", {
      next: "paused",
      reason: "credentials_required",
      leaseOwner: "user-1",
      leaseToken: claimed.lease_token!,
    });
    const paused = await app.request(`/v1/goals/${goalId}`, { method: "DELETE", headers: auth });
    assert.equal(paused.status, 409);
  });

  test("delete is owner-scoped and auth-gated", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    goalLedger.claimGoal(goalId, "user-1");
    goalLedger.transitGoal(goalId, "user-1", {
      next: "complete",
      summary: "done",
      leaseOwner: "user-1",
      leaseToken: goalLedger.getGoal(goalId)!.lease_token!,
    });

    const denied = makeApp(
      t,
      async () => ({ ok: false as const, reason: "bad_key" as const }),
    );
    assert.equal(
      (await denied.app.request(`/v1/goals/${goalId}`, { method: "DELETE", headers: auth })).status,
      401,
    );
    assert.ok(goalLedger.getGoal(goalId), "the goal survives an unauthorized delete");
  });
});

/** Every trigger name currently defined on the shared database. */
function triggerNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe("goal routes — Phase 5 review regressions", () => {
  test("a resume that loses the CAS releases the pin IT minted (5.1)", async (t) => {
    const { app, db, goalLedger, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);
    // A paused row still carrying a lease is exactly what `resumeGoal`'s CAS
    // refuses (`AND lease_owner IS NULL`), so the resume loses after the pin
    // was minted and before it was registered with the runner.
    db.prepare(
      "UPDATE goal SET lease_owner = 'someone', lease_token = 'tok' WHERE id = ?",
    ).run(goalId);

    const mintedBefore = pins.pinCalls.length;
    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "hello",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "goal_not_resumable" });

    assert.equal(pins.pinCalls.length, mintedBefore + 1, "resume minted one pin");
    const minted = pins.pinCalls[pins.pinCalls.length - 1]!.handle;
    assert.ok(
      pins.releaseCalls.some((call) => call.handle === minted),
      `the newly minted handle must be released, not a stale registry entry; ` +
        `released=${JSON.stringify(pins.releaseCalls)}`,
    );
    // Nothing durable changed: still paused, no answer appended.
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.listGoalMessages(goalId).length, 2);
  });

  test("a resume that throws rolls back the pin too, with ITS code (5.1, 4)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);
    const original = goalLedger.resumeGoal.bind(goalLedger);
    goalLedger.resumeGoal = () => {
      throw new GoalError("GOAL_INVALID_TRANSITION", "forced failure");
    };
    let res: Response;
    try {
      res = await app.request(`/v1/goals/${goalId}/resume`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          answer: "hello",
          credentials: { openrouter: { apiKey: "sk-resumed" } },
        }),
      });
    } finally {
      goalLedger.resumeGoal = original;
    }

    assert.equal(res!.status, 409);
    // NOT `goal_not_cancellable`: the mapper's invalid-transition code comes
    // from the route that caught it.
    assert.deepEqual(await res!.json(), { error: "goal_not_resumable" });
    const minted = pins.pinCalls[pins.pinCalls.length - 1]!.handle;
    assert.ok(
      pins.releaseCalls.some((call) => call.handle === minted),
      "the minted pin is released on the throw path as well",
    );
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
  });

  test("a FAILED delete never leaves the write-once triggers dropped (5.3)", async (t) => {
    const { app, db, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    goalLedger.claimGoal(goalId, "user-1");
    goalLedger.transitGoal(goalId, "user-1", { next: "complete", summary: "done" });

    const guardsBefore = triggerNames(db);
    assert.ok(guardsBefore.includes("goal_message_append_only_delete"));
    assert.ok(guardsBefore.includes("goal_refusal_append_only_delete"));

    // Poison the parent delete so every DELETE inside `deleteGoal` throws
    // mid-way — the DROP TRIGGER statements must roll back WITH it, or one
    // failed delete disarms the append-only invariant process-wide.
    db.exec(
      "CREATE TRIGGER goal_delete_poison BEFORE DELETE ON goal " +
        "BEGIN SELECT RAISE(ABORT, 'poisoned'); END",
    );
    const guardsWithPoison = triggerNames(db).sort();
    try {
      const del = await app.request(`/v1/goals/${goalId}`, {
        method: "DELETE",
        headers: auth,
      });
      assert.equal(del.status, 500);
      assert.deepEqual(await del.json(), { error: "internal" });

      assert.deepEqual(
        triggerNames(db).sort(),
        guardsWithPoison,
        "both append-only guards must survive a failed delete",
      );
      assert.ok(guardsWithPoison.includes("goal_message_append_only_delete"));
      assert.ok(guardsWithPoison.includes("goal_refusal_append_only_delete"));
      assert.ok(goalLedger.getGoal(goalId), "the goal survives the failed delete");

      // And the guard still refuses a real message delete afterwards.
      const probe = (await (
        await postGoal(app, { clientGoalId: "guard-probe" })
      ).json()) as PostBody;
      db.prepare(
        `INSERT INTO goal_message
           (id, goal_id, seq, role, content_json, created_ts)
         VALUES ('m-guard-probe', ?, 2, 'user', '"probe"', ?)`,
      ).run(probe.goalId, EPOCH);
      assert.throws(
        () => db.prepare("DELETE FROM goal_message WHERE id = 'm-guard-probe'").run(),
        /append.only/i,
        "the write-once invariant is still enforced",
      );
    } finally {
      db.exec("DROP TRIGGER goal_delete_poison");
    }
  });

  test("a mid-delete invalid transition reports goal_not_deletable (5.3)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const res = await postGoal(app);
    const { goalId } = (await res.json()) as PostBody;
    goalLedger.claimGoal(goalId, "user-1");
    goalLedger.transitGoal(goalId, "user-1", {
      next: "complete",
      summary: "done",
      leaseOwner: "user-1",
      leaseToken: goalLedger.getGoal(goalId)!.lease_token!,
    });

    const original = goalLedger.deleteGoal.bind(goalLedger);
    goalLedger.deleteGoal = () => {
      throw new GoalError("GOAL_INVALID_TRANSITION", "not terminal");
    };
    let del: Response;
    try {
      del = await app.request(`/v1/goals/${goalId}`, { method: "DELETE", headers: auth });
    } finally {
      goalLedger.deleteGoal = original;
    }

    assert.equal(del!.status, 409);
    // NOT `goal_not_cancellable` — each route names its own refusal.
    assert.deepEqual(await del!.json(), { error: "goal_not_deletable" });
    assert.ok(goalLedger.getGoal(goalId));
  });

  test("the list carries pauseQuestion so a paused goal can be rendered (5.3)", async (t) => {
    const { app, goalLedger } = makeApp(t);
    const pausedId = await pauseGoal(app, goalLedger);
    await postGoal(app, { clientGoalId: "queued-for-list" });

    const res = await app.request("/v1/goals", { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      goals: {
        goalId: string;
        pauseReason: string | null;
        pauseQuestion: string | null;
        canResume: boolean;
      }[];
    };
    const paused = body.goals.find((goal) => goal.goalId === pausedId)!;
    assert.equal(paused.pauseReason, "needs_user_input");
    assert.equal(paused.pauseQuestion, "high protein?", "the list alone drives the resume flow");
    assert.equal(paused.canResume, true);
    for (const goal of body.goals) {
      if (goal.goalId === pausedId) continue;
      assert.equal(goal.pauseQuestion, null, "no question without a needs_user_input pause");
    }
  });

  test("resume respects the per-owner admission cap (429 busy)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger); // a paused goal holds no slot
    for (let i = 0; i < GOAL_MAX_CONCURRENT_PER_OWNER; i++) {
      const queued = await postGoal(app, { clientGoalId: `cap-${i}` });
      assert.equal(queued.status, 201);
    }

    const mintedBefore = pins.pinCalls.length;
    const res = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "yes",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      error: "busy",
      message: "goal concurrency limit reached",
    });
    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(
      pins.pinCalls.length,
      mintedBefore,
      "a capped resume never mints a pin",
    );
  });

  test("answer takes the same bound as instruction (5.1)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);
    const goalId = await pauseGoal(app, goalLedger);
    const mintedBefore = pins.pinCalls.length;

    const oversized = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "a".repeat(PUBLIC_TASK_SPEC_MAX_BYTES + 1),
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" });

    // Control characters (newlines included) are refused exactly as the
    // admission route refuses a multi-line `instruction`.
    const controlChar = await app.request(`/v1/goals/${goalId}/resume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answer: "line one\nline two",
        credentials: { openrouter: { apiKey: "sk-resumed" } },
      }),
    });
    assert.equal(controlChar.status, 400);
    assert.deepEqual(await controlChar.json(), { error: "invalid_request" });

    assert.equal(goalLedger.getGoal(goalId)!.status, "paused");
    assert.equal(goalLedger.listGoalMessages(goalId).length, 2, "no answer was written");
    assert.equal(pins.pinCalls.length, mintedBefore, "a refused answer never mints a pin");
  });
});
