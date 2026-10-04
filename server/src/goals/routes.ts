import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  accountDeletedResponse,
  keyGateResponse,
  requireApiKey,
} from "../api_key.ts";
import { isDeleting } from "../account_deletion.ts";
import type { ResolvedAgentDef } from "../catalog/index.ts";
import type {
  CredentialPinHandle,
  CredentialPinStore,
} from "../credentials/pins.ts";
import { env } from "../env.ts";
import {
  extractCredentialsFromBody,
  PluginCredentialError,
  validateCredentials,
} from "../plugins/credential.ts";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { PluginStoreError } from "../plugins/store.ts";
import { isModelPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";
import {
  PUBLIC_STEP_ID_MAX_BYTES,
  PUBLIC_TASK_PAGE_DEFAULT_LIMIT,
  PUBLIC_TASK_PAGE_MAX_LIMIT,
  PUBLIC_TASK_SPEC_MAX_BYTES,
} from "../ledger.ts";

import { GOAL_MAX_CONCURRENT_PER_OWNER } from "./constants.ts";
import { GoalError, GoalSetupError } from "./errors.ts";
import {
  parseAgentSnapshot,
  serializeAgentSnapshot,
} from "./agent_snapshot.ts";
import type { GoalLedger } from "./ledger.ts";
import type { GoalRunner } from "./runner.ts";
import {
  GOAL_LIVE_STATUSES,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
} from "./types.ts";
import type { GoalRow, GoalStatus } from "./types.ts";

/**
 * Phase 3.6 goal REST surface (`POST /v1/goals`, `GET /v1/goals/:id`,
 * `POST /v1/goals/:id/cancel`), mounted under `/v1` by `index.ts`. Mirrors
 * `createLedgerRoutes`: a `verifyKey` seam (defaults to `requireApiKey`, gated
 * through `keyGateResponse`), `isDeleting(owner)` -> `account_deleted`, an
 * owner-scoped read (cross-owner id is a `404`, never a leak), and the §5.1
 * flat `{"error":"<code>"}` envelope.
 *
 * Wire shapes are WIRE_SPEC §12. M2's admission guard rejects a non-empty
 * `authorisedTools` (there is no `authorize` interceptor until Phase 6, so a
 * write could not be gated) and terminates any goal whose non-control bound
 * surface is not read-only. Credentials are pinned at admission and registered
 * in the runner's `goalPins` registry — the runner reads ONLY its own handle,
 * never `pins.find(owner, pluginId)` (the Phase 0.3 bug class).
 *
 * The `registry` dep is optional: when present, `modelPluginId` is resolved
 * exactly as chat does and the model credentials are validated against the
 * plugin's spec (so `400 invalid_credentials` is raised at admission). When
 * absent (route-level tests, or a composition that has not wired plugins),
 * only the structural credential shape is enforced and the runner fails
 * `plugin_unavailable`/`credentials_required` on claim.
 */
export type GoalRoutesOptions = {
  /** Test seam; defaults to the real `requireApiKey` from `api_key.ts`. */
  verifyKey?: VerifyApiKeyFn;
  goalLedger: GoalLedger;
  goalRunner: GoalRunner;
  /** DEDICATED goal pin store (`goalPins`), never the job pin store (3.2). */
  pins: CredentialPinStore;
  /** Resolve a template/installed agent id to its definition (chat parity). */
  resolveAgent: (id: string) => Promise<ResolvedAgentDef | undefined>;
  /**
   * Optional plugin registry for chat-parity model-plugin + credential
   * validation. Omitted -> structural validation only (see the type docs).
   */
  registry?: PluginRegistry;
};

export function createGoalRoutes(opts: GoalRoutesOptions): Hono {
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const { goalLedger, goalRunner, pins } = opts;
  const routes = new Hono();

  routes.use(
    "*",
    bodyLimit({
      maxSize: env.MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );

  routes.post("/goals", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!isRecord(body)) return c.json({ error: "invalid_request" }, 400);

    // 1. Field validation. `publicTextError`-style: non-empty, control-free,
    //    byte-bounded. The instruction is the durable goal text; the client
    //    goal id maps to the ledger's idempotency key.
    const instructionError = publicTextError(
      body["instruction"],
      PUBLIC_TASK_SPEC_MAX_BYTES,
      false,
    );
    if (instructionError !== null) return publicFieldError(c, instructionError);
    const instruction = body["instruction"] as string;

    const clientGoalIdError = publicTextError(
      body["clientGoalId"],
      PUBLIC_STEP_ID_MAX_BYTES,
      true,
    );
    if (clientGoalIdError !== null) return publicFieldError(c, clientGoalIdError);
    const clientGoalId = body["clientGoalId"] as string;

    const agentError = publicTextError(
      body["agent"],
      PUBLIC_STEP_ID_MAX_BYTES,
      true,
    );
    if (agentError !== null) return publicFieldError(c, agentError);
    const agentId = body["agent"] as string;

    const modelPluginError = publicTextError(
      body["modelPluginId"],
      PUBLIC_STEP_ID_MAX_BYTES,
      true,
    );
    if (modelPluginError !== null) return publicFieldError(c, modelPluginError);
    const modelPluginId = body["modelPluginId"] as string;

    const tokenBudget = body["tokenBudget"];
    if (
      typeof tokenBudget !== "number" ||
      !Number.isSafeInteger(tokenBudget) ||
      tokenBudget <= 0
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }

    // Idempotent re-get FIRST: a repeat submit must return the existing goal
    // even when the cap is now full, the agent template was since uninstalled,
    // or the retry no longer carries credentials (the original admission
    // succeeded; the client is only recovering the goal id). Doing this AFTER
    // the cap/agent checks makes a lost-response retry unrecoverable once the
    // server-side create has consumed a slot.
    const existing = goalLedger.getGoalByIdempotencyKey(owner, clientGoalId);
    if (existing) return c.json(postShape(existing), 200);

    // 2. Admission guard (3.5 / waves §M2): `authorisedTools` is empty in M2 —
    //    no `authorize` interceptor exists, so binding a write the pipeline
    //    cannot gate would be the exact failure the read-only invariant
    //    prevents. The route refuses loudly rather than admitting it.
    const authorisedTools = body["authorisedTools"];
    if (authorisedTools !== undefined) {
      if (!Array.isArray(authorisedTools)) {
        return c.json({ error: "invalid_request" }, 400);
      }
      if (authorisedTools.length > 0) {
        return c.json(
          {
            error: "invalid_request",
            message: "authorised tools are not supported until M4",
          },
          400,
        );
      }
    }

    // 3. Concurrency cap (2.3): `queued` + `running` count against the per-owner
    //    cap; a paused goal holds no slot. §5.1 `busy` is concurrent-capacity
    //    and retryable.
    if (goalLedger.countActiveGoals(owner) >= GOAL_MAX_CONCURRENT_PER_OWNER) {
      return c.json(
        { error: "busy", message: "goal concurrency limit reached" },
        429,
      );
    }

    // 4. Agent resolution — chat convention: a missing template id is
    //    `400 invalid_request` with `template_not_found: <id>`.
    const resolvedAgent = await opts.resolveAgent(agentId);
    if (!resolvedAgent) {
      return c.json(
        { error: "invalid_request", message: `template_not_found: ${agentId}` },
        400,
      );
    }

    // Snapshot the agent for durable use WITHOUT resolved MCP header secrets:
    // only `${VAR}` references are persisted and re-resolved from the
    // environment at claim time. Validating the round-trip here fails an
    // unserializable agent (a literal header) at admission rather than at the
    // first claim.
    let agentSnapshot: string;
    try {
      agentSnapshot = serializeAgentSnapshot(resolvedAgent);
      parseAgentSnapshot(agentSnapshot);
    } catch (error) {
      if (error instanceof GoalSetupError) {
        return c.json(
          { error: "invalid_request", message: error.failureReason },
          400,
        );
      }
      throw error;
    }

    // 5. Model plugin + credential validation (chat parity). With a registry
    //    this is the same `requirePlugin`/`isModelPlugin`/`supportsStreaming`
    //    + `extract`/`validate` sequence chat runs; without one, only the
    //    structural credential shape is enforced.
    const credentials = resolveModelCredentials(
      body,
      modelPluginId,
      opts.registry,
    );
    if (!credentials.ok) return credentials.response;

    // 6. Pin first, then create. The pin is the ONLY credential reference the
    //    loop will read; it is registered under the goal id after the row
    //    exists. A race that loses the get-or-create releases the minted pin.
    let handle: CredentialPinHandle;
    try {
      handle = pins.pin(owner, modelPluginId, credentials.credentials).handle;
    } catch {
      return c.json({ error: "invalid_credentials" }, 400);
    }
    let goal: GoalRow;
    try {
      goal = goalLedger.getOrCreateGoal({
        owner,
        idempotencyKey: clientGoalId,
        instruction,
        tokenBudget,
        agentSnapshot,
        pinnedModel: modelPluginId,
      });
    } catch (error) {
      pins.release(owner, modelPluginId, handle);
      throw error;
    }
    // Lost the get-or-create race: the winner already appended the
    // instruction. Release the redundant pin and return the existing goal.
    if (goalLedger.listGoalMessages(goal.id).length > 0) {
      pins.release(owner, modelPluginId, handle);
      return c.json(postShape(goal), 200);
    }
    if (isDeleting(owner)) {
      pins.release(owner, modelPluginId, handle);
      return accountDeletedResponse(c);
    }
    // CREATE ONLY: the instruction becomes the step input vector's first
    // `user` message (the durable, checkpointer-less conversation seed).
    goalLedger.appendGoalMessage(goal.id, owner, {
      role: "user",
      content: instruction,
    });
    // 7. Register the handle the runner resolves this goal's credentials from.
    try {
      goalRunner.registerGoalPin(goal.id, modelPluginId, handle);
    } catch (error) {
      pins.release(owner, modelPluginId, handle);
      throw error;
    }
    return c.json(postShape(goal), 201);
  });

  routes.get("/goals/:id", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    const goal = goalLedger.getGoal(id);
    // Cross-owner is indistinguishable from missing: a 404, never a leak.
    if (!goal || goal.owner !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(goalDetail(goalLedger, goal));
  });

  routes.post("/goals/:id/cancel", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    const goal = goalLedger.getGoal(id);
    if (!goal || goal.owner !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const updated = goalLedger.cancelGoal(id, owner);
      // Release the goal's admitted credential handle(s) — the same release
      // every terminal path performs.
      goalRunner.releaseGoalPin(id);
      return c.json({
        goalId: updated.id,
        status: "cancelled",
        previousStatus: goal.status,
        effectState: goalLedger.effectState(id),
      });
    } catch (error) {
      return goalError(c, error, "goal_not_cancellable");
    }
  });

  // ── Phase 5.1 resume: re-credential + answer, atomically. ──
  routes.post("/goals/:id/resume", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    const goal = goalLedger.getGoal(id);
    if (!goal || goal.owner !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    // Only a paused goal is resumable; a live or terminal goal is the
    // §5.1 `goal_not_resumable` refusal (never an implicit cancel/retry).
    if (goal.status !== "paused") {
      return c.json({ error: "goal_not_resumable" }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const record = body as Record<string, unknown>;
    // `answer` is user text written straight into the durable message log, so
    // it takes the same bound `instruction` takes at admission: non-empty,
    // control-free, byte-capped (413 `request_too_large` past the cap).
    const answer = record["answer"];
    const answerError = publicTextError(
      answer,
      PUBLIC_TASK_SPEC_MAX_BYTES,
      false,
    );
    if (answerError !== null) return publicFieldError(c, answerError);
    const answerText = answer as string;

    // Admission-cap parity with `POST /goals`: a paused goal holds no slot, so
    // resuming is exactly where an owner could otherwise drift past
    // `GOAL_MAX_CONCURRENT_PER_OWNER` by cycling pause/resume. 429 `busy` is
    // the same retryable refusal admission gives (the claim gate still bounds
    // concurrent execution either way).
    if (goalLedger.countActiveGoals(owner) >= GOAL_MAX_CONCURRENT_PER_OWNER) {
      return c.json(
        { error: "busy", message: "goal concurrency limit reached" },
        429,
      );
    }

    // Credentials are re-supplied because the D8 lease is RAM-only: after a
    // restart (or once the 3h TTL lapses) the goal has no usable handle, which
    // is exactly why it paused. Model plugin parity with admission.
    const credentials = resolveModelCredentials(
      record,
      goal.pinned_model ?? "",
      opts.registry,
    );
    if (!credentials.ok) return credentials.response;

    // Pin + register BEFORE the CAS so the goal can never become `queued`
    // without a handle to spend. A refused resume releases the handle THIS
    // route minted — straight from the store: it is not in the runner's
    // `goalPins` registry yet, so `releaseGoalPin` would drain a stale entry
    // (or nothing) and strand the new one for the full pin TTL.
    const modelPluginId = goal.pinned_model ?? "";
    let handle: CredentialPinHandle;
    try {
      handle = pins.pin(owner, modelPluginId, credentials.credentials).handle;
    } catch {
      return c.json({ error: "invalid_credentials" }, 400);
    }
    try {
      // ONE transaction: append the durable answer + CAS `paused -> queued`
      // requiring `lease_owner IS NULL` (plan §"Resume is atomic"). A lost CAS
      // (or a goal that moved on) THROWS from inside it, so the answer rolls
      // back with it — nothing durable changes on a refused resume.
      goalLedger.transaction(() => goalLedger.resumeGoal(id, owner, answerText));
    } catch (error) {
      // This handle never reached the runner's registry — release it from the
      // STORE (see above), then let the mapper answer.
      pins.release(owner, modelPluginId, handle);
      return goalError(c, error, "goal_not_resumable");
    }
    try {
      goalRunner.registerGoalPin(id, modelPluginId, handle);
    } catch (error) {
      // The pin is registered under the goal id; without it the claim would
      // pause on `credentials_required` again. Cancel rather than leave a goal
      // queued that can only fail.
      goalLedger.cancelGoal(id, owner);
      goalRunner.releaseGoalPin(id);
      pins.release(owner, modelPluginId, handle);
      throw error;
    }
    return c.json({ goalId: id, status: "queued" });
  });

  // ── Phase 5.3 list + delete. ──
  routes.get("/goals", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);

    const status = c.req.query("status");
    let statusFilter: GoalStatus | undefined;
    if (status !== undefined) {
      if (!(GOAL_STATUSES as readonly string[]).includes(status)) {
        return c.json({ error: "invalid_request" }, 400);
      }
      statusFilter = status as GoalStatus;
    }
    const page = goalPageQuery(c);
    if (page === null) return c.json({ error: "invalid_request" }, 400);

    const { goals, nextOffset } = goalLedger.listGoals(owner, {
      ...(statusFilter === undefined ? {} : { status: statusFilter }),
      limit: page.limit,
      offset: page.offset,
    });
    // Same `nextOffset` convention as the ledger list: page metadata rides in
    // headers, never in the body (WIRE_SPEC §12).
    c.header("x-ledger-page-limit", String(page.limit));
    c.header("x-ledger-page-offset", String(page.offset));
    if (nextOffset !== null) {
      c.header("x-ledger-next-offset", String(nextOffset));
    }
    return c.json({
      goals: goals.map((goal) => ({
        goalId: goal.id,
        status: goal.status,
        instruction: goal.instruction,
        pauseReason: goal.pause_reason,
        // Same gate as `goalDetail`: a `needs_user_input` pause without its
        // question cannot be rendered, so the list alone must be able to drive
        // the resume flow (no per-goal `GET` just to show the prompt).
        pauseQuestion:
          goal.pause_reason === "needs_user_input" ? goal.pause_question : null,
        resultSummary: goal.result_summary,
        failureReason: goal.status === "failed" ? goal.failure_reason : null,
        tokenBudget: goal.token_budget,
        tokensSpent: goal.tokens_spent,
        canCancel: (GOAL_LIVE_STATUSES as readonly string[]).includes(goal.status),
        canResume: goal.status === "paused",
        terminal: (GOAL_TERMINAL_STATUSES as readonly string[]).includes(goal.status),
        createdAt: new Date(goal.created_ts).toISOString(),
        updatedAt: new Date(goal.updated_ts).toISOString(),
      })),
    });
  });

  routes.delete("/goals/:id", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    const goal = goalLedger.getGoal(id);
    if (!goal || goal.owner !== owner) {
      return c.json({ error: "not_found" }, 404);
    }
    // Only a TERMINAL goal is deletable (WIRE_SPEC §12): cancel a live one
    // first, so a delete can never discard running work.
    if (!(GOAL_TERMINAL_STATUSES as readonly string[]).includes(goal.status)) {
      return c.json({ error: "goal_not_deletable" }, 409);
    }
    try {
      // A terminal goal already released its pin, but a terminal goal created
      // before a restart may still hold a stale registry entry.
      goalRunner.releaseGoalPin(id);
      goalLedger.deleteGoal(id, owner);
      return c.body(null, 204);
    } catch (error) {
      return goalError(c, error, "goal_not_deletable");
    }
  });

  return routes;
}

/**
 * `GET /v1/goals` paging query (`WIRE_SPEC §12`: "follow
 * `ledger.routes.ts:479-506`"), reusing the ledger list's caps so a goal list
 * cannot be used to read more per page than a task list can.
 */
function goalPageQuery(c: Context): { limit: number; offset: number } | null {
  const rawLimit = c.req.query("limit");
  let limit = PUBLIC_TASK_PAGE_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(rawLimit)) return null;
    const parsed = Number(rawLimit);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > PUBLIC_TASK_PAGE_MAX_LIMIT
    ) {
      return null;
    }
    limit = parsed;
  }

  const rawOffset = c.req.query("offset");
  let offset = 0;
  if (rawOffset !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawOffset)) return null;
    const parsed = Number(rawOffset);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    offset = parsed;
  }
  return { limit, offset };
}

/**
 * `POST` response shape (`WIRE_SPEC §12`): the 201 create and the 200
 * idempotent re-get share it; the re-get reports the goal's CURRENT status and
 * todos rather than pretending it is newly queued.
 */
function postShape(goal: GoalRow): {
  goalId: string;
  status: GoalStatus;
  todos: unknown[];
  createdAt: string;
} {
  return {
    goalId: goal.id,
    status: goal.status,
    todos: parseJsonArray(goal.todos),
    createdAt: new Date(goal.created_ts).toISOString(),
  };
}

/**
 * `GET /v1/goals/:id` (`WIRE_SPEC §12`). JSON columns are parsed defensively:
 * a malformed `todos`/mutation row can never 500 the read. `pauseQuestion`,
 * `resultSummary` and `failureReason` are null unless their status condition
 * holds; `canResume` is included for §12 parity (resume itself is Phase 5).
 */
function goalDetail(goalLedger: GoalLedger, goal: GoalRow): {
  goalId: string;
  status: GoalStatus;
  pauseReason: string | null;
  pauseQuestion: string | null;
  resultSummary: string | null;
  failureReason: string | null;
  instruction: string;
  todos: unknown[];
  tokenBudget: number;
  tokensSpent: number;
  effectState: string;
  canCancel: boolean;
  canResume: boolean;
  terminal: boolean;
  unresolvedMutations: { tool: string; argsHash: string }[];
  steps: { seq: number; kind: string; status: string; tokens: number }[];
  updatedAt: string;
} {
  const terminal = (GOAL_TERMINAL_STATUSES as readonly string[]).includes(
    goal.status,
  );
  const canCancel = (GOAL_LIVE_STATUSES as readonly string[]).includes(
    goal.status,
  );
  return {
    goalId: goal.id,
    status: goal.status,
    pauseReason: goal.pause_reason,
    pauseQuestion:
      goal.pause_reason === "needs_user_input" ? goal.pause_question : null,
    resultSummary: goal.status === "complete" ? goal.result_summary : null,
    failureReason: goal.status === "failed" ? goal.failure_reason : null,
    instruction: goal.instruction,
    todos: parseJsonArray(goal.todos),
    tokenBudget: goal.token_budget,
    tokensSpent: goal.tokens_spent,
    effectState: goalLedger.effectState(goal.id),
    canCancel,
    canResume: goal.status === "paused",
    terminal,
    unresolvedMutations: goalLedger.listUnresolvedMutations(goal.id).map(
      (mutation) => ({ tool: mutation.tool, argsHash: mutation.args_hash }),
    ),
    steps: goalLedger.listGoalSteps(goal.id).map((step) => ({
      seq: step.seq,
      kind: step.kind,
      status: step.status,
      tokens: step.tokens,
    })),
    updatedAt: new Date(goal.updated_ts).toISOString(),
  };
}

type CredentialResolution =
  | { ok: true; credentials: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Chat-parity model resolution. With [registry]: resolve the plugin
 * (`requirePlugin`), require a streaming model plugin, then extract + validate
 * the per-plugin credentials against its spec — `400 invalid_request` for a
 * bad/uninstalled/non-streaming plugin, `400 invalid_credentials` for a
 * missing/invalid value, `502 inference_unavailable` when the store is not
 * loaded. Without it, the structural shape is enforced (a `credentials`
 * object carrying a string-valued entry for [modelPluginId]).
 */
function resolveModelCredentials(
  body: Record<string, unknown>,
  modelPluginId: string,
  registry: PluginRegistry | undefined,
): CredentialResolution {
  if (!registry) {
    const structural = structuralModelCredentials(body, modelPluginId);
    if (structural === null) {
      return { ok: false, response: invalidCredentials() };
    }
    return { ok: true, credentials: structural };
  }
  let plugin: ModelPluginDefinition;
  try {
    const resolved = registry.requirePlugin(modelPluginId);
    if (!isModelPlugin(resolved) || !resolved.inference.supportsStreaming) {
      return { ok: false, response: invalidRequest() };
    }
    plugin = resolved;
  } catch (error) {
    if (error instanceof PluginRegistryError) {
      return { ok: false, response: invalidRequest() };
    }
    if (error instanceof PluginStoreError && error.code === "NOT_LOADED") {
      return { ok: false, response: inferenceUnavailable() };
    }
    throw error;
  }
  try {
    const input = extractCredentialsFromBody(body, modelPluginId, plugin.credentials, {
      isModel: true,
    });
    const credentials = validateCredentials(
      plugin.credentials,
      input,
      modelPluginId,
      { isModel: true },
    );
    return { ok: true, credentials };
  } catch (error) {
    if (error instanceof PluginCredentialError) {
      return { ok: false, response: invalidCredentials() };
    }
    throw error;
  }
}

/**
 * Registry-free fallback: the `credentials[modelPluginId]` entry must be an
 * object with at least one string value. Missing/non-object/empty ->
 * `invalid_credentials` (the credential pin has nothing to hold).
 */
function structuralModelCredentials(
  body: Record<string, unknown>,
  modelPluginId: string,
): Record<string, string> | null {
  const credentialsField = body["credentials"];
  if (!isRecord(credentialsField)) return null;
  const perPlugin = credentialsField[modelPluginId];
  if (!isRecord(perPlugin)) return null;
  const out: Record<string, string> = {};
  for (const [reference, value] of Object.entries(perPlugin)) {
    if (typeof value === "string") out[reference] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function invalidRequest(): Response {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function invalidCredentials(): Response {
  return new Response(JSON.stringify({ error: "invalid_credentials" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function inferenceUnavailable(): Response {
  return new Response(JSON.stringify({ error: "inference_unavailable" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

const PUBLIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type PublicFieldError = "invalid_request" | "request_too_large";

function publicTextError(
  value: unknown,
  maxBytes: number,
  identifier: boolean,
): PublicFieldError | null {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    PUBLIC_CONTROL_CHARACTERS.test(value)
  ) {
    return "invalid_request";
  }
  if (identifier && (value === "." || value === "..")) {
    return "invalid_request";
  }
  return Buffer.byteLength(value, "utf8") > maxBytes
    ? "request_too_large"
    : null;
}

function publicFieldError(c: Context, error: PublicFieldError): Response {
  return error === "request_too_large"
    ? c.json({ error }, 413)
    : c.json({ error }, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive JSON-column read for the `todos` list (never throws). */
function parseJsonArray(json: string | null): unknown[] {
  if (json === null || json.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `GoalError -> HTTP` mapper, mirroring `ledgerError`: a cross-owner or
 * unknown goal is `404 not_found` (no leak) and a lease fence miss is `409`.
 *
 * [invalidTransition] is supplied BY THE ROUTE, not hardcoded: the same
 * `GOAL_INVALID_TRANSITION` means a different refusal on each surface
 * (`goal_not_cancellable` on cancel, `goal_not_resumable` on resume,
 * `goal_not_deletable` on delete) and the Dart side registers all three with
 * distinct copy — defaulting it to one of them would silently lie from a
 * pre-check that got relaxed or a TOCTOU window.
 */
function goalError(
  c: Context,
  error: unknown,
  invalidTransition: "goal_not_cancellable" | "goal_not_resumable" | "goal_not_deletable",
): Response {
  if (error instanceof GoalError) {
    if (error.code === "GOAL_NOT_FOUND" || error.code === "GOAL_FORBIDDEN") {
      return c.json({ error: "not_found" }, 404);
    }
    if (error.code === "GOAL_INVALID_TRANSITION") {
      return c.json({ error: invalidTransition }, 409);
    }
    if (error.code === "GOAL_LEASE_CONFLICT") {
      return c.json({ error: "goal_lease_conflict" }, 409);
    }
  }
  console.error("goals: unexpected error", error);
  return c.json({ error: "internal" }, 500);
}
