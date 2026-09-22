import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Context } from "hono";
import { getOrCreateTask } from "./credentials/idempotency.ts";
import { env } from "./env.ts";
import { requireApiKey, unauthorized } from "./inference.ts";
import { Ledger, LedgerError, migrateLedger } from "./ledger.ts";
import type { TaskRow } from "./ledger.ts";
import type { VerifyApiKeyFn } from "./plugins/routes.ts";

/**
 * The ledger lives in a dedicated SQLite file (`LEDGER_DB_PATH`, default
 * `./data/ledger.db`), separate from the better-auth DB (`DB_PATH`). Rationale:
 * the ledger is append-only, write-once, and versioned independently via
 * `PRAGMA user_version`; mixing it into the auth DB would couple two schemas
 * with unrelated lifecycles and complicate per-schema migrations. A dedicated
 * file also keeps auth's admin surface (user/session/apikey tables) untouched
 * by ledger migrations.
 */
mkdirSync(dirname(env.LEDGER_DB_PATH), { recursive: true });
const ledgerDb = new Database(env.LEDGER_DB_PATH);
migrateLedger(ledgerDb);
// The ledger persists user conversation content (`spec` = last user message
// text, tool results in ledger_step.result), so its file must be hardened like
// the sibling stores — SQLite creates it 0644 under a default umask otherwise.
chmodSync(env.LEDGER_DB_PATH, 0o600);
export const ledger = new Ledger(ledgerDb, {
  stuckTimeoutMs: env.LEDGER_STUCK_TIMEOUT_MS,
  leaseExpiryMs: env.LEDGER_LEASE_EXPIRY_MS,
  terminalRetentionMs: env.LEDGER_RETENTION_MS,
});
// One-time startup orphan reconciliation: tasks left `running` by a crash or
// restart with a lapsed lease / stale heartbeat become `stuck` before the
// server accepts requests, so they can be resumed instead of lying false-stuck.
// Count only, no task details.
const orphanedCount = ledger.reconcileOrphans().marked.length;
if (orphanedCount > 0) {
  console.log(
    `ledger: reconciled ${orphanedCount} orphaned running task(s) as stuck`,
  );
}
// D6: periodic retention sweep purges terminal tasks (and their steps/chain)
// once they have sat past LEDGER_RETENTION_MS. Tick errors are logged, never
// crash the timer; the timer is unref'd inside the Ledger so it cannot keep
// the process alive.
ledger.startRetentionSweep(env.LEDGER_SWEEP_INTERVAL_MS, {
  onError: (err) => console.error("ledger: retention sweep failed", err),
});

export function createLedgerRoutes(
  l: Ledger,
  opts: { verifyKey?: VerifyApiKeyFn } = {},
): Hono {
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono();

  routes.post("/tasks", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      intentKey?: unknown;
      spec?: unknown;
      worker?: unknown;
    } | null;
    if (!body || typeof body.intentKey !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    // M2: owner-scoped get-or-create. A repeat (owner, intentKey) returns the
    // EXISTING task with 200 instead of raw-INSERT 500ing on the v4 unique
    // index. The pre-check distinguishes created (201) from returned (200).
    const existing = l.getTaskByIntentKey(owner, body.intentKey);
    const created = existing === null;
    const task = await getOrCreateTask(l, {
      owner,
      intentKey: body.intentKey,
      spec: JSON.stringify(body.spec ?? {}),
      worker: typeof body.worker === "string" ? body.worker : undefined,
    });
    return c.json(toPublicTask(task), created ? 201 : 200);
  });

  routes.get("/tasks", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    return c.json(l.listTasks(owner).map(toPublicTask));
  });

  // Status-by-idempotency-key: the client's poll-after-drop endpoint (plan
  // line 228). Owner-scoped via getTaskByIntentKey — a cross-owner lookup is a
  // miss → 404 (IDOR), never a leak. Registered before `/tasks/:id`; Hono's
  // router disambiguates by segment count regardless.
  routes.get("/tasks/by-key/:intentKey", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const task = l.getTaskByIntentKey(owner, c.req.param("intentKey"));
    if (!task) return c.json({ error: "not_found" }, 404);
    return c.json(toPublicTask(task));
  });

  routes.get("/tasks/:id", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const id = c.req.param("id");
    // Scope the read to the caller (IDOR): cross-owner reads are a miss → 404.
    const task = l.getTask(id, owner);
    if (!task) return c.json({ error: "not_found" }, 404);
    return c.json({
      ...toPublicTask(task),
      steps: l.listSteps(task.id, owner),
      chain: l.readChain(task.id, owner),
    });
  });

  routes.post("/tasks/:id/claim", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    try {
      return c.json(toPublicTask(l.claimTask(c.req.param("id"), owner)));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/steps", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      stage?: unknown;
      action?: unknown;
      result?: unknown;
      fenceToken?: unknown;
    } | null;
    if (
      !body ||
      typeof body.stage !== "string" ||
      typeof body.action !== "string"
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const id = c.req.param("id");
    const task = l.getTask(id, owner);
    if (!task) return c.json({ error: "not_found" }, 404);
    const fenceToken =
      typeof body.fenceToken === "string" ? body.fenceToken : undefined;
    // M8: a RUNNING task is fence-protected — a caller appending steps without
    // the claim/resume fence token is (or may be) a superseded worker and must
    // not write. Queued/terminal transitions never carry a fence, so the gate
    // is conditional on `running`.
    if (task.status === "running" && !fenceToken) {
      return c.json({ error: "fence_conflict" }, 403);
    }
    try {
      const out = l.appendStep(
        id,
        owner,
        {
          stage: body.stage,
          action: body.action,
          result: typeof body.result === "string" ? body.result : null,
        },
        fenceToken,
      );
      return c.json(out, 201);
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/heartbeat", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      fenceToken?: unknown;
    } | null;
    const id = c.req.param("id");
    const task = l.getTask(id, owner);
    if (!task) return c.json({ error: "not_found" }, 404);
    const fenceToken =
      body && typeof body.fenceToken === "string" ? body.fenceToken : undefined;
    // M8: heartbeats only apply to `running` tasks, and those are
    // fence-protected — a heartbeat without the fence token is a superseded
    // worker trying to extend a lease it no longer holds.
    if (task.status === "running" && !fenceToken) {
      return c.json({ error: "fence_conflict" }, 403);
    }
    try {
      return c.json(toPublicTask(l.heartbeat(id, owner, fenceToken)));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/resume", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    try {
      return c.json(toPublicTask(l.resumeTask(c.req.param("id"), owner)));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/complete", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      status?: unknown;
    } | null;
    const status = body?.status;
    if (
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "cancelled" &&
      status !== "awaiting_review"
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json(toPublicTask(l.completeTask(c.req.param("id"), owner, status)));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  return routes;
}

/** A `TaskRow` as returned to clients: the internal snapshot `payload` column
 *  (ledger v5) is stripped. Job-status delivery must never echo the client's
 *  own message snapshot — the client already owns it; the ledger holds it
 *  transiently ONLY for the runner's crash-resume, purged with the task by the
 *  retention sweep (plan §10). */
function toPublicTask(task: TaskRow): Omit<TaskRow, "payload"> {
  const { payload: _payload, ...publicTask } = task;
  return publicTask;
}

function ledgerError(c: Context, e: unknown): Response {
  if (e instanceof LedgerError) {
    if (e.code === "TASK_NOT_FOUND") return c.json({ error: "not_found" }, 404);
    if (e.code === "FORBIDDEN" || e.code === "LEASE_CONFLICT" || e.code === "FENCE_CONFLICT") {
      return c.json({ error: e.code.toLowerCase() }, 403);
    }
    if (e.code === "INVALID_CONFIG") return c.json({ error: "invalid_config" }, 500);
    return c.json({ error: e.code.toLowerCase() }, 409);
  }
  console.error("ledger: unexpected error", e);
  return c.json({ error: "internal" }, 500);
}

export const ledgerRoutes = createLedgerRoutes(ledger);
