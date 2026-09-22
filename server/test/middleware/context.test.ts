import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ContextBudgetError } from "../../src/middleware/context.ts";

/**
 * Context-budget error tests. The former server-side truncation/compaction
 * helpers (`truncatePairAware`, `createContextManager`,
 * `maybeCompactAfterStream`, `estimateMessageTokens`) were removed with the
 * sync-path checkpoint cutover (plan §9 / F8) — the client owns context
 * management; the gateway only surfaces a budget-busting input as a distinct,
 * actionable error.
 */

describe("ContextBudgetError", () => {
  test("carries the context_length_exceeded code and the estimate/limit", () => {
    const err = new ContextBudgetError(400, 100);
    assert.equal(err.code, "context_length_exceeded");
    assert.equal(err.estimatedTokens, 400);
    assert.equal(err.limitTokens, 100);
    assert.ok(err instanceof Error);
    assert.match(err.message, /400 > 100 estimated tokens/);
  });

  test("is recognized via instanceof (the shared pre-stream mapping path)", () => {
    const err: unknown = new ContextBudgetError(10, 5);
    assert.ok(err instanceof ContextBudgetError);
  });
});