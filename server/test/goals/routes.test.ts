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
import { createGoalRoutes } from "../../src/goals/routes.ts";
import { createGoalRunner } from "../../src/goals/runner.ts";
import type { GoalRunner } from "../../src/goals/runner.ts";
import type { GoalRow } from "../../src/goals/types.ts";
import { migrateLedger } from "../../src/ledger.ts";
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

  test("a non-empty authorisedTools is refused: M2 cannot gate a write (3.5 admission guard)", async (t) => {
    const { app, goalLedger, pins } = makeApp(t);

    const res = await postGoal(app, { authorisedTools: ["create_mealplan"] });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "invalid_request",
      message: "authorised tools are not supported until M4",
    });
    assert.equal(
      goalLedger.getGoalByIdempotencyKey("user-1", "client-goal-1"),
      undefined,
    );
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
