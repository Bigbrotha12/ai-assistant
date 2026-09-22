import { TERMINAL_TASK_STATUSES, type TaskRow } from "../ledger.ts";

export type ManagedAdmission =
  | { kind: "admitted"; task: TaskRow }
  | { kind: "in_flight"; task: TaskRow }
  | { kind: "already_terminal"; task: TaskRow }
  | { kind: "thread_conflict"; task: TaskRow };

export function inspectManagedTurn(task: TaskRow, clientThreadId?: string): ManagedAdmission | undefined {
  if (!task.worker || (clientThreadId !== undefined && task.worker !== clientThreadId)) {
    return { kind: "thread_conflict", task };
  }
  if (task.status === "running") return { kind: "in_flight", task };
  if (isTerminalStatus(task.status)) return { kind: "already_terminal", task };
  return undefined;
}

/** Single source of truth: `server/src/ledger.ts` TERMINAL_TASK_STATUSES. */
export function isTerminalStatus(status: TaskRow["status"]): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}