import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import type { Context } from "hono";
import { getOrCreateTask } from "../credentials/idempotency.ts";
import { env } from "../config/env.ts";
import { accountDeletedResponse, requireApiKey, requireOwner } from "../auth/request_auth.ts";
import type { OwnerVariables, VerifyApiKeyFn } from "../auth/request_auth.ts";
import { AccountDeletedError, isDeleting } from "../auth/account_deletion.ts";
import {
  Ledger,
  migrateLedger,
  projectPublicTaskProgress,
  PUBLIC_STEP_ID_MAX_BYTES,
  PUBLIC_STEP_LIMIT,
  PUBLIC_TASK_PAGE_DEFAULT_LIMIT,
  PUBLIC_TASK_PAGE_MAX_LIMIT,
  PUBLIC_TASK_SPEC_MAX_BYTES,
} from "./index.ts";
import type { PublicStepRow, PublicTaskRow, TaskRow } from "./index.ts";
import { configureLedgerConnection, hardenLedgerFiles } from "./schema.ts";
import type { JobRunner } from "../jobs/runner.ts";

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
configureLedgerConnection(ledgerDb);
migrateLedger(ledgerDb);
// The ledger persists user conversation content (`spec` = last user message
// text, tool results in ledger_step.result), so its file AND the WAL/SHM
// sidecars WAL creates must be hardened like the sibling stores — SQLite
// creates them 0644 under a default umask otherwise. Runs after the
// user_version read inside migrateLedger, which materializes the sidecars.
hardenLedgerFiles(env.LEDGER_DB_PATH);
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
// Periodic retention sweep purges terminal tasks (and their steps/chain)
// once they have sat past LEDGER_RETENTION_MS. Tick errors are logged, never
// crash the timer; the timer is unref'd inside the Ledger so it cannot keep
// the process alive.
ledger.startRetentionSweep(env.LEDGER_SWEEP_INTERVAL_MS, {
  onError: (err) => console.error("ledger: retention sweep failed", err),
});

export function createLedgerRoutes(
  l: Ledger,
  opts: { verifyKey?: VerifyApiKeyFn; jobRunner?: JobRunner } = {},
): Hono<OwnerVariables> {
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono<OwnerVariables>();

  routes.use(
    "/tasks/*",
    bodyLimit({
      maxSize: env.MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );
  routes.use("/tasks/*", requireOwner(verifyKey));

  routes.post("/tasks", async (c) => {
    const owner = c.get("owner");
    const body = (await c.req.json().catch(() => null)) as {
      intentKey?: unknown;
      spec?: unknown;
      worker?: unknown;
    } | null;
    if (!body) return c.json({ error: "invalid_request" }, 400);

    const intentKeyError = publicTextError(
      body.intentKey,
      PUBLIC_STEP_ID_MAX_BYTES,
      true,
    );
    if (intentKeyError !== null) return publicFieldError(c, intentKeyError);
    const intentKey = body.intentKey as string;

    let worker: string | undefined;
    if (body.worker !== undefined) {
      const workerError = publicTextError(
        body.worker,
        PUBLIC_STEP_ID_MAX_BYTES,
        false,
      );
      if (workerError !== null) return publicFieldError(c, workerError);
      worker = body.worker as string;
    }

    const spec = body.spec === undefined ? {} : body.spec;
    if (!isJsonObject(spec)) return c.json({ error: "invalid_request" }, 400);
    let serializedSpec: string | undefined;
    try {
      serializedSpec = JSON.stringify(spec);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (serializedSpec === undefined) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (exceedsByteLimit(serializedSpec, PUBLIC_TASK_SPEC_MAX_BYTES)) {
      return c.json({ error: "request_too_large" }, 413);
    }

    if (isDeleting(owner)) return accountDeletedResponse(c);
    const existing = l.getTaskByIntentKey(owner, intentKey);
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const created = existing === null;
    let task: TaskRow;
    try {
      task = await getOrCreateTask(l, {
        owner,
        intentKey,
        spec: serializedSpec,
        worker,
      });
    } catch (error) {
      if (error instanceof AccountDeletedError) return accountDeletedResponse(c);
      throw error;
    }
    if (isDeleting(owner)) return accountDeletedResponse(c);
    return c.json(toPublicTask(task), created ? 201 : 200);
  });

  routes.get("/tasks", async (c) => {
    const owner = c.get("owner");
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const page = publicTaskPage(c);
    if (page === null) return c.json({ error: "invalid_request" }, 400);
    const result = l.listPublicTasks(owner, page.limit, page.offset);
    c.header("x-ledger-page-limit", String(page.limit));
    c.header("x-ledger-page-offset", String(page.offset));
    if (result.nextOffset !== null) {
      c.header("x-ledger-next-offset", String(result.nextOffset));
    }
    return c.json(result.tasks.map(toPublicTask));
  });

  // Status-by-idempotency-key: the client's poll-after-drop endpoint.
  // Owner-scoped via getTaskByIntentKey — a cross-owner lookup is a miss →
  // 404 (IDOR), never a leak. Registered before `/tasks/:id`; Hono's router
  // disambiguates by segment count regardless.
  routes.get("/tasks/by-key/:intentKey", async (c) => {
    const owner = c.get("owner");
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const intentKey = c.req.param("intentKey");
    const intentKeyError = publicTextError(
      intentKey,
      PUBLIC_STEP_ID_MAX_BYTES,
      true,
    );
    if (intentKeyError !== null) return publicFieldError(c, intentKeyError);
    const limit = publicReadLimit(c);
    if (limit === null) return c.json({ error: "invalid_request" }, 400);
    const task = l.getTaskByIntentKey(owner, intentKey);
    if (!task) return c.json({ error: "not_found" }, 404);
    const steps = l.listPublicSteps(task.id, owner, limit);
    const stats = l.getPublicStepStats(task.id, owner);
    return c.json({
      ...toPublicTask(task),
      projection: projectPublicTaskProgress(
        task,
        steps,
        opts.jobRunner?.getTaskExecution(task.id, owner),
        stats ?? undefined,
      ),
    });
  });

  routes.get("/tasks/:id", async (c) => {
    const owner = c.get("owner");
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    const limit = publicReadLimit(c);
    if (limit === null) return c.json({ error: "invalid_request" }, 400);
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const task = l.getTask(id, owner);

    if (!task) return c.json({ error: "not_found" }, 404);
    const steps = l.listPublicSteps(task.id, owner, limit);
    const stats = l.getPublicStepStats(task.id, owner);
    return c.json({
      ...toPublicTask(task),
      projection: projectPublicTaskProgress(
        task,
        steps,
        opts.jobRunner?.getTaskExecution(task.id, owner),
        stats ?? undefined,
      ),
      steps: steps.map(toPublicStep),
      chain: l.readPublicChain(task.id, owner, limit),
    });
  });

  routes.post("/tasks/:id/cancel", async (c) => {
    const owner = c.get("owner");
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const id = c.req.param("id");
    const idError = publicTextError(id, PUBLIC_STEP_ID_MAX_BYTES, true);
    if (idError !== null) return publicFieldError(c, idError);
    if (!opts.jobRunner) {
      return c.json({ error: "background_unavailable" }, 503);
    }
    const report = opts.jobRunner.cancelTask(id, owner);
    if (isDeleting(owner)) return accountDeletedResponse(c);
    if (report === null) return c.json({ error: "not_found" }, 404);
    return c.json(report, report.stage === "cancelling" ? 202 : 200);
  });

  return routes;
}

const PUBLIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type PublicFieldError = "invalid_request" | "request_too_large";

function exceedsByteLimit(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") > maxBytes;
}

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
  return exceedsByteLimit(value, maxBytes) ? "request_too_large" : null;
}

function publicFieldError(c: Context, error: PublicFieldError): Response {
  return error === "request_too_large"
    ? c.json({ error }, 413)
    : c.json({ error }, 400);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicTaskPage(
  c: Context,
): { limit: number; offset: number } | null {
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

function publicReadLimit(c: Context): number | null {
  const raw = c.req.query("limit");
  if (raw === undefined) return PUBLIC_STEP_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit <= PUBLIC_STEP_LIMIT
    ? limit
    : null;
}

function toPublicStep(
  step: PublicStepRow,
): Omit<PublicStepRow, "resultBytes"> {
  const { resultBytes: _resultBytes, ...publicStep } = step;
  return publicStep;
}

/** A `TaskRow` as returned to clients: the internal snapshot `payload` column
 *  (ledger v5) is stripped. Job-status delivery must never echo the client's
 *  own message snapshot — the client already owns it; the ledger holds it
 *  transiently ONLY for the runner's crash-resume, purged with the task by the
 *  retention sweep. */
function toPublicTask(
  task: TaskRow | PublicTaskRow,
): Omit<TaskRow, "payload" | "job_spec"> {
  const { payload: _payload, job_spec: _jobSpec, ...publicTask } =
    task as TaskRow;
  return publicTask;
}
