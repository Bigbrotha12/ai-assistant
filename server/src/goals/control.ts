import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { GoalError } from "./errors.ts";
import type { GoalLedger } from "./ledger.ts";

/**
 * Goal control tools (Phase 3.3, plan §Control tools / §Termination).
 *
 * `update_plan` and `goal_complete` are plain `DynamicStructuredTool`s with
 * their OWN `func` — they are passed straight into `createAgentGraph({ tools })`
 * and are NEVER wrapped by `createBoundTool` (`tools/bind.ts`): they do not
 * dispatch through the tool pipeline (no serialize/cache/budget/fence), they
 * write the goal row directly, and they must be excluded from the M2 read-only
 * surface check.
 *
 * Termination mechanics (the signal itself lives in the runner): a control
 * tool performs its guarded CAS + sets nothing else; the runner's
 * `beforeModelCall` re-reads the goal and throws `GoalTerminalSignal` before
 * the next model call, and the runner's post-invoke re-read covers the
 * `toolRounds >= maxIterations` early return. The `func` therefore NEVER
 * throws the signal: `ToolNode` is `{ handleToolErrors: false }`, so a
 * throwing `func` rejects `graph.invoke` outright instead of unwinding as "the
 * control tool already committed". A CAS miss rolls the transaction back and
 * returns a plain tool result.
 *
 * Transaction composition (see `GoalLedger.transaction`): the append + CAS +
 * step-flag writes of one tool all run inside ONE better-sqlite3 transaction,
 * in the order documented on each tool below. A missed CAS aborts the whole
 * transaction, so a stale control call can never leave a stray assistant
 * message behind.
 */

/** Per-step context handed to {@link buildControlTools} by the runner. */
export type GoalControlToolContext = {
  goalId: string;
  owner: string;
  /** The goal's current lease — the control tool must present it on its CAS. */
  leaseOwner: string;
  leaseToken: string;
  /** The running step's `seq` — `goal_complete` marks it terminal. */
  stepSeq: number;
  goalLedger: GoalLedger;
};

/** Internal marker: a guarded write matched 0 rows → abort the transaction. */
class ControlToolStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlToolStaleError";
  }
}

/**
 * Builds the two goal-native control tools for ONE running step. The runner
 * appends the result to the SAME `tools` array as the plugin/MCP tools.
 */
export function buildControlTools(
  ctx: GoalControlToolContext,
): DynamicStructuredTool[] {
  const { goalId, owner, leaseOwner, leaseToken, stepSeq, goalLedger } = ctx;

  const updatePlan = new DynamicStructuredTool({
    name: "update_plan",
    description:
      "Publish or revise the goal's todo list. Call this before starting work " +
      "and whenever the plan changes. `plan` is a short human-readable summary " +
      "of the current approach; `todos` is the full ordered todo list.",
    schema: z.object({
      plan: z
        .string()
        .describe("Short description of the current plan/approach."),
      todos: z
        .array(z.string())
        .describe("The full ordered todo list (replaces the previous list)."),
    }),
    func: async ({ plan, todos }) => {
      try {
        goalLedger.transaction(() => {
          // (1) Capture the plan text in the durable message log.
          goalLedger.appendGoalMessage(goalId, owner, {
            role: "assistant",
            content: plan,
          });
          // (2) Replace the todo list. A miss (goal moved / lease superseded)
          // aborts the transaction so the plan message is not left behind.
          const applied = goalLedger.setGoalTodos(
            goalId,
            owner,
            todos,
            leaseOwner,
            leaseToken,
          );
          if (!applied) {
            throw new ControlToolStaleError(
              `goal ${goalId} is no longer running for this lease`,
            );
          }
        });
        return JSON.stringify({ ok: true, todos: todos.length });
      } catch (error) {
        if (isControlCasMiss(error)) {
          return JSON.stringify({
            ok: false,
            reason: "goal_no_longer_running",
          });
        }
        throw error;
      }
    },
  });

  const goalComplete = new DynamicStructuredTool({
    name: "goal_complete",
    description:
      "Mark the goal complete once its objective is fully achieved. `summary` " +
      "is the final result the user will read. Only call this when the work is " +
      "actually done; the goal cannot run further afterwards.",
    schema: z.object({
      summary: z
        .string()
        .describe("The final result summary delivered to the user."),
    }),
    func: async ({ summary }) => {
      try {
        goalLedger.transaction(() => {
          // (1) Persist the result as the final assistant message.
          goalLedger.appendGoalMessage(goalId, owner, {
            role: "assistant",
            content: { summary },
          });
          // (2) CAS `running -> complete`, writing `result_summary` in the
          // same transaction (throws on a lease/transition miss → rollback).
          goalLedger.transitGoal(goalId, owner, {
            next: "complete",
            summary,
            leaseOwner,
            leaseToken,
          });
          // (3) Flag this step terminal (idempotent: already-terminal → false).
          goalLedger.markStepTerminal(goalId, owner, stepSeq, leaseOwner, leaseToken);
        });
        return JSON.stringify({ ok: true, status: "complete" });
      } catch (error) {
        if (isControlCasMiss(error)) {
          return JSON.stringify({
            ok: false,
            reason: "goal_no_longer_running",
          });
        }
        throw error;
      }
    },
  });

  return [updatePlan, goalComplete];
}

/**
 * True for the expected "the guarded CAS did not match" errors — a
 * superseded lease, an already-moved goal, or a deleted one. These are the
 * only cases the control tool converts into a plain (non-throwing) result;
 * any other error is an infrastructure failure and propagates.
 */
function isControlCasMiss(error: unknown): boolean {
  if (error instanceof ControlToolStaleError) return true;
  if (!(error instanceof GoalError)) return false;
  return (
    error.code === "GOAL_INVALID_TRANSITION" ||
    error.code === "GOAL_LEASE_CONFLICT" ||
    error.code === "GOAL_NOT_FOUND"
  );
}
