import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncMutex } from "./jobs/mutex.ts";

/**
 * Process-local deletion coordination. Tombstones, owner barriers, and pending
 * deletion state live for the lifetime of one gateway process. This deliberate
 * SINGLE-REPLICA assumption requires **exactly one gateway replica; no
 * overlapping rolling deployments**. A second process can miss a tombstone or
 * owner barrier and admit work that raced deletion; there is no in-process
 * replica-count guard, so ops must enforce the Deployment and rollout. Lock
 * order is owner barrier -> NotifyStore mutex; code must never acquire an owner
 * barrier while holding the store mutex. Multi-replica deletion coordination is
 * a separate distributed-coordination project.
 */
const deletingOwners = new Set<string>();
const pendingDeletionOwners = new Set<string>();
const ownerBarriers = new Map<string, AsyncMutex>();

type AccountDeletionRequestState = {
  pendingOwner?: string;
};

const accountDeletionRequests = new AsyncLocalStorage<AccountDeletionRequestState>();

export const ACCOUNT_DELETED_ERROR = "account_deleted" as const;

export class AccountDeletedError extends Error {
  readonly code = ACCOUNT_DELETED_ERROR;

  constructor(owner: string) {
    super(`account deleted: ${owner}`);
    this.name = "AccountDeletedError";
  }
}

export async function withOwnerBarrier<T>(
  owner: string,
  fn: () => Promise<T>,
): Promise<T> {
  let barrier = ownerBarriers.get(owner);
  if (!barrier) {
    barrier = new AsyncMutex();
    ownerBarriers.set(owner, barrier);
  }
  const current = barrier;
  try {
    return await current.runExclusive(fn);
  } finally {
    if (current.isIdle && ownerBarriers.get(owner) === current) {
      ownerBarriers.delete(owner);
    }
  }
}

export function runWithAccountDeletionRequest<T>(fn: () => Promise<T>): Promise<T> {
  return accountDeletionRequests.run({ pendingOwner: undefined }, fn);
}

export function markDeleting(owner: string): void {
  deletingOwners.add(owner);
  pendingDeletionOwners.add(owner);
  const request = accountDeletionRequests.getStore();
  if (request) request.pendingOwner = owner;
}

export function isDeleting(owner: string): boolean {
  return deletingOwners.has(owner);
}

export function clearDeleting(owner: string): void {
  deletingOwners.delete(owner);
  pendingDeletionOwners.delete(owner);
}

export function completeDeletion(owner: string): void {
  pendingDeletionOwners.delete(owner);
  const request = accountDeletionRequests.getStore();
  if (request?.pendingOwner === owner) request.pendingOwner = undefined;
}

export function handleAccountDeletionAPIError(): void {
  const request = accountDeletionRequests.getStore();
  const owner = request?.pendingOwner;
  if (!owner || !pendingDeletionOwners.has(owner)) return;
  clearDeleting(owner);
  request.pendingOwner = undefined;
}

export function assertNotDeleting(owner: string): void {
  if (isDeleting(owner)) throw new AccountDeletedError(owner);
}
