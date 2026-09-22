/**
 * Context budget error, shared by the sync/async paths (F8): the client owns
 * truncation/compaction (plan §6); the gateway's only remaining context concern
 * is surfacing a budget-budget-busting input as a distinct, actionable error.
 * The former server-side truncation/compaction helpers
 * (`truncatePairAware`, `createContextManager`, `maybeCompactAfterStream`,
 * `estimateMessageTokens`) were removed with the sync-path checkpoint cutover —
 * they are unreferenced in `src`.
 */
export class ContextBudgetError extends Error {
  readonly code = "context_length_exceeded";

  constructor(readonly estimatedTokens: number, readonly limitTokens: number) {
    super(`Required model input exceeds context budget (${estimatedTokens} > ${limitTokens} estimated tokens)`);
    this.name = "ContextBudgetError";
  }
}