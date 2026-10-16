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
 * L12 control-tool gate (N1): true when the goal carries a `pending` or
 * `unresolved` mutation — an effect whose outcome is UNKNOWN. A control tool
 * must refuse while this holds rather than CAS the goal terminal: leaving the
 * goal `running` is what lets the runner's step-end L12 guard pause
 * `needs_mutation_resolution` on the re-read. Completing (or asking) now would
 * strand the `unresolved` rows under a terminal goal — only `paused` goals
 * resume — and would report success for effects that may or may not have
 * reached the provider. `update_plan` stays ungated: it never leaves
 * `running`, so the same step-end guard covers it.
 */
const hasUnknownOutcome = (goalLedger: GoalLedger, goalId: string): boolean =>
  goalLedger.effectState(goalId) === "unknown";

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

  // `goal_complete` CASes `running -> complete`. It is REFUSED while the goal's
  // effect state is `unknown` (N1/L12): a sibling mutation may have reached the
  // provider without a recorded outcome, and completing would make its
  // `unresolved` row unreachable (only `paused` goals resume) while reporting
  // the goal done. The refusal writes nothing; the goal stays `running` and the
  // runner's step-end guard pauses `needs_mutation_resolution` instead.
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
      // Refuse while a mutation's outcome is unknown — never append or CAS.
      if (hasUnknownOutcome(goalLedger, goalId)) {
        return JSON.stringify({
          ok: false,
          reason: "unknown_mutation_outcome",
        });
      }
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

  // Phase 5.1 (plan §Control tools): `goal_blocked` is the model's ONLY way to
  // ask the user a question. It is structurally identical to `goal_complete`
  // (append + lease-guarded CAS + step flag in ONE transaction) and differs
  // only in the target: `running -> paused` with reason `needs_user_input` and
  // the question, which the CAS both stores in `pause_question` AND leaves in
  // the durable log — so a resume can rebuild the full conversation with the
  // question and its answer both in context (plan §"The question survives").
  //
  // Pausing clears the lease (the plan's CAS), so the step ends here: the
  // runner's post-invoke re-read sees a goal that is no longer `running` and
  // persists NOTHING from the round, exactly as for `goal_complete`.
  //
  // Like `goal_complete`, it is REFUSED while the goal's effect state is
  // `unknown` (N1/L12): asking the user a question would move the goal
  // `paused(needs_user_input)` and strand the `unresolved` mutation rows under
  // a pause reason that offers no way to resolve them. The refusal writes
  // nothing, so the runner's step-end guard pauses `needs_mutation_resolution`
  // instead. The question is not put to the user until the effects are known.
  const goalBlocked = new DynamicStructuredTool({
    name: "goal_blocked",
    description:
      "Pause the goal and ask the user a question you cannot answer yourself. " +
      "`question` must be specific and self-contained — it is the only thing " +
      "the user sees, so it must carry every detail they need to decide. The " +
      "goal stops until they answer via resume.",
    schema: z.object({
      question: z
        .string()
        .describe(
          "The question to put to the user. Self-contained: include the " +
            "specific options or facts they need to choose.",
        ),
    }),
    func: async ({ question }) => {
      // Refuse while a mutation's outcome is unknown — never append or CAS.
      if (hasUnknownOutcome(goalLedger, goalId)) {
        return JSON.stringify({
          ok: false,
          reason: "unknown_mutation_outcome",
        });
      }
      try {
        goalLedger.transaction(() => {
          // (1) The question is durable in the conversation log — this is
          // what makes the resume context complete, not just `pause_question`.
          goalLedger.appendGoalMessage(goalId, owner, {
            role: "assistant",
            content: { question },
          });
          // (2) Close the step BEFORE the pause CAS. Order matters: pausing
          // CLEARS the lease columns, and `markStepTerminal`'s optional lease
          // fence matches on them — so closing after the CAS would miss its own
          // fence and silently leave the step `running`. While the lease is
          // still live the fence proves this step owns the goal.
          goalLedger.markStepTerminal(goalId, owner, stepSeq, leaseOwner, leaseToken);
          // (3) CAS `running -> paused` with the typed reason + question in the
          // same transaction; a miss throws and rolls the message + step close
          // back with it.
          goalLedger.pauseGoal(goalId, owner, {
            next: "paused",
            reason: "needs_user_input",
            question,
            leaseOwner,
            leaseToken,
          });
        });
        return JSON.stringify({ ok: true, status: "paused", reason: "needs_user_input" });
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

  return [updatePlan, goalComplete, goalBlocked];
}

/**
 * The control tools' wire names. The runner feeds this to BOTH tool channels:
 * the MCP binder's `excludeToolNames` and the plugin-tool list handed to the
 * graph, so neither channel can shadow a control tool with a same-named tool of
 * its own (Phase 5.1).
 */
export const CONTROL_TOOL_NAMES = [
  "update_plan",
  "goal_complete",
  "goal_blocked",
] as const;

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
