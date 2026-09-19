import { randomUUID } from "node:crypto";
import type { Ledger, TaskRow } from "../ledger.ts";
import { getOrCreateTask } from "./idempotency.ts";

export type ManagedAdmission =
  | { kind: "admitted"; task: TaskRow }
  | { kind: "in_flight"; task: TaskRow }
  | { kind: "already_terminal"; task: TaskRow }
  | { kind: "thread_conflict"; task: TaskRow };

export async function prepareManagedTurn(
  ledger: Ledger,
  input: { owner: string; messageId: string; spec: string; clientThreadId?: string },
): Promise<TaskRow> {
  return getOrCreateTask(ledger, {
    owner: input.owner,
    intentKey: input.messageId,
    spec: input.spec,
    worker: input.clientThreadId ?? randomUUID(),
  });
}

export function inspectManagedTurn(task: TaskRow, clientThreadId?: string): ManagedAdmission | undefined {
  if (!task.worker || (clientThreadId !== undefined && task.worker !== clientThreadId)) {
    return { kind: "thread_conflict", task };
  }
  if (task.status === "running") return { kind: "in_flight", task };
  if (isTerminalStatus(task.status)) return { kind: "already_terminal", task };
  return undefined;
}

export function admitManagedTurn(ledger: Ledger, task: TaskRow): ManagedAdmission {
  const current = ledger.getTask(task.id, task.owner);
  if (!current) throw new Error("managed_task_missing");
  const duplicate = inspectManagedTurn(current, task.worker ?? undefined);
  if (duplicate) return duplicate;
  const claimed = current.status === "queued"
    ? ledger.claimTask(current.id, current.owner)
    : ledger.resumeTask(current.id, current.owner);
  return { kind: "admitted", task: claimed };
}

export function isTerminalStatus(status: TaskRow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "awaiting_review";
}
