import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import type { Context } from "hono";
import { env } from "./env.ts";
import { requireApiKey, unauthorized } from "./inference.ts";
import { Ledger, LedgerError, migrateLedger } from "./ledger.ts";

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
export const ledger = new Ledger(ledgerDb, {
  stuckTimeoutMs: env.LEDGER_STUCK_TIMEOUT_MS,
  leaseExpiryMs: env.LEDGER_LEASE_EXPIRY_MS,
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

export function createLedgerRoutes(l: Ledger): Hono {
  const routes = new Hono();

  routes.post("/tasks", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      intentKey?: unknown;
      spec?: unknown;
      worker?: unknown;
    } | null;
    if (!body || typeof body.intentKey !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const task = l.createTask({
      owner,
      intentKey: body.intentKey,
      spec: JSON.stringify(body.spec ?? {}),
      worker: typeof body.worker === "string" ? body.worker : undefined,
    });
    return c.json(task, 201);
  });

  routes.get("/tasks", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    return c.json(l.listTasks(owner));
  });

  routes.get("/tasks/:id", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    const id = c.req.param("id");
    // Scope the read to the caller (IDOR): cross-owner reads are a miss → 404.
    const task = l.getTask(id, owner);
    if (!task) return c.json({ error: "not_found" }, 404);
    return c.json({
      ...task,
      steps: l.listSteps(task.id, owner),
      chain: l.readChain(task.id, owner),
    });
  });

  routes.post("/tasks/:id/claim", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    try {
      return c.json(l.claimTask(c.req.param("id"), owner));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/steps", async (c) => {
    const owner = await requireApiKey(c);
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
    try {
      const out = l.appendStep(
        c.req.param("id"),
        owner,
        {
          stage: body.stage,
          action: body.action,
          result: typeof body.result === "string" ? body.result : null,
        },
        typeof body.fenceToken === "string" ? body.fenceToken : undefined,
      );
      return c.json(out, 201);
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/heartbeat", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => null)) as {
      fenceToken?: unknown;
    } | null;
    try {
      return c.json(
        l.heartbeat(
          c.req.param("id"),
          owner,
          body && typeof body.fenceToken === "string"
            ? body.fenceToken
            : undefined,
        ),
      );
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/resume", async (c) => {
    const owner = await requireApiKey(c);
    if (!owner) return unauthorized(c);
    try {
      return c.json(l.resumeTask(c.req.param("id"), owner));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  routes.post("/tasks/:id/complete", async (c) => {
    const owner = await requireApiKey(c);
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
      return c.json(l.completeTask(c.req.param("id"), owner, status));
    } catch (e) {
      return ledgerError(c, e);
    }
  });

  return routes;
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
