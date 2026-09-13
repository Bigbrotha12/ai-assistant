import type { Ledger, StepRow, TaskRow } from "../ledger.ts";

/**
 * Idempotency — Phase 2, Wave B (rebuild, correct).
 *
 * Two guarantees for the async job path:
 *
 * 1. OWNER-SCOPED GET-OR-CREATE BY IDEMPOTENCY KEY. A client generates a
 *    `messageId` once per send and reuses it across retries. The server maps
 *    (owner, messageId) to exactly ONE task: `getOrCreateTask` returns the
 *    existing task when one exists and otherwise creates it. It is NOT a raw
 *    INSERT — the ledger's v4 unique index on (owner, intent_key) means a
 *    concurrent writer can win the race, so the create is wrapped and a
 *    SQLITE_CONSTRAINT violation re-reads the existing row instead of 500ing
 *    (the old raw `createTask` 500ed on a repeat).
 *
 * 2. TOOL-CALL REPLAY DEDUPE. A checkpoint-resumed worker must NEVER re-execute
 *    a tool whose result was already persisted. `recordToolResult` appends a
 *    step whose row carries the tool-call-id (ledger v4 `tool_call_id`), and
 *    `hasToolResult` does an indexed point lookup for it. The partial unique
 *    index on (task_id, tool_call_id) also makes `recordToolResult` idempotent:
 *    a duplicate record is caught and returns the existing step.
 *
 * 3. RETRY RULE. Only `readOnly` (safe-to-repeat, GET-ish) tools may be
 *    re-run after a partial success; mutating tools (`readOnly: false`) are
 *    un-dedupable and must never be retried. `canRetryTool` encodes that.
 */

export interface GetOrCreateTaskInput {
  owner: string;
  intentKey: string;
  spec: string;
  worker?: string;
}

export interface RecordToolResultInput {
  taskId: string;
  owner: string;
  fenceToken?: string;
  toolCallId: string;
  toolName: string;
  result: string;
}

export interface HasToolResultInput {
  taskId: string;
  owner: string;
  toolCallId: string;
}

/** better-sqlite3 surfaces UNIQUE/CHECK/trigger aborts with a `SQLITE_CONSTRAINT*` code. */
function isUniqueConstraintViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    (e as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

/**
 * Owner-scoped get-or-create by idempotency key. Returns the existing task for
 * (owner, intentKey) when one exists; otherwise creates one via the ledger.
 * Race-safe: if a concurrent writer wins the INSERT, the UNIQUE violation is
 * caught and the existing row is re-read — never a 500.
 */
export async function getOrCreateTask(
  ledger: Ledger,
  input: GetOrCreateTaskInput,
): Promise<TaskRow> {
  const existing = ledger.getTaskByIntentKey(input.owner, input.intentKey);
  if (existing) return existing;
  try {
    return ledger.createTask(input);
  } catch (e) {
    if (isUniqueConstraintViolation(e)) {
      const raced = ledger.getTaskByIntentKey(input.owner, input.intentKey);
      if (raced) return raced;
    }
    throw e;
  }
}

/**
 * Atomic tool-call-id + result persistence (replay dedupe). Appends a `tool`
 * step whose row carries the tool-call-id. Idempotent: if that tool-call-id
 * was already recorded (a resumed worker racing a prior record, or a retry
 * after a partial commit), the UNIQUE index aborts the append and the existing
 * step is returned — no duplicate row, no re-execution.
 */
export function recordToolResult(
  ledger: Ledger,
  input: RecordToolResultInput,
): StepRow {
  try {
    return ledger.appendStep(
      input.taskId,
      input.owner,
      {
        stage: "tool",
        action: `tool:${input.toolName}`,
        result: input.result,
        toolCallId: input.toolCallId,
      },
      input.fenceToken,
    ).step;
  } catch (e) {
    if (isUniqueConstraintViolation(e)) {
      const existing = ledger.getStepByToolCallId(
        input.taskId,
        input.toolCallId,
        input.owner,
      );
      if (existing) return existing;
    }
    throw e;
  }
}

/**
 * True when a tool-call-id's result is already persisted for the task.
 * Owner-scoped: a cross-owner read is a miss (false). Indexed point lookup.
 */
export function hasToolResult(
  ledger: Ledger,
  input: HasToolResultInput,
): boolean {
  return (
    ledger.getStepByToolCallId(input.taskId, input.toolCallId, input.owner) !==
    null
  );
}

/**
 * Retry rule: only read-only (safe-to-repeat) tools may be re-run after a
 * partial success. Mutating tools are un-dedupable — re-running them could
 * apply a side effect twice — so a checkpoint resume must never retry them.
 */
export function canRetryTool(tool: { readOnly: boolean }): boolean {
  return tool.readOnly;
}