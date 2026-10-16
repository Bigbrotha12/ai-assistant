import type { GoalLedger } from "../../goals/ledger.ts";
import type { ToolDispatch, ToolInterceptor } from "../pipeline.ts";

/** Dispatch error code set by an `authorize` refusal (no egress attempted). */
export const GOAL_TOOL_REFUSED = "goal_tool_refused";

/**
 * Tool-visible refusal text for a denied goal-channel tool call. Deliberately
 * carries only the tool name and the typed reason — never the arguments — so a
 * secret-shaped argument cannot reach the model transcript (the durable
 * `goal_refusal` row applies the same discipline via `redactForOutbound`).
 *
 * Exported alongside {@link GOAL_TOOL_REFUSED} so the later `reserve`
 * interceptor can emit the `duplicate_mutation`/`unresolved_mutation` arms of
 * the SAME vocabulary rather than re-deriving their text.
 */
export function goalToolRefusalContent(
  reason: "unauthorized" | "duplicate_mutation" | "unresolved_mutation",
  tool: string,
): string {
  return `Tool '${tool}' was refused (${reason}) and was not executed.`;
}

/**
 * `authorize` interceptor — goal-channel mutating-tool authorisation guard
 * (plan M4 / §goalAuthorised, L6).
 *
 * Every goal carries an immutable `authorised_tools` set fixed at admission.
 * A MUTATING (`readOnly === false`) call whose name is not in that set is
 * refused BEFORE any egress: the interceptor records an append-only
 * `unauthorized` refusal on the ledger, sets the tool-visible content and the
 * `goal_tool_refused` dispatch code, and returns WITHOUT `next()` — so
 * `ok:false`, `outcome:"error"`, and `executed:false` all fall out of the
 * pipeline's frozen denial contract.
 *
 * `goalAuthorised` rides the call (set by the channel's binder from the same
 * admission set) rather than being re-derived here, keeping the interceptor
 * stateless per dispatch apart from its constructor deps — the same
 * `ledger`/`goalId` split as the goal fence (`goal_fence.ts`).
 *
 * There is deliberately no `beforeBody`: the call's `goalAuthorised` is
 * immutable for the life of the goal (the set is written once at admission and
 * never mutated), so no interceptor between here and the body can flip it;
 * and liveness (a goal cancelled mid-setup) is already re-checked by the goal
 * fence's `beforeBody`, which runs at the same innermost point. A second hook
 * would add a second lifecycle to keep in sync for no additional guard.
 *
 * Registered directly INSIDE the goal fence's position but AFTER `serialize`
 * (wired order `fence → serialize → authorize → cache → budget → reserve →
 * execution`, plan M4): the fence owns liveness and must win, and the refusal
 * is recorded against args that already passed the bounds check. Unlike
 * `cache`/`budget`/`reserve`, an unauthorised call pays no cache admission and
 * never reserves a mutation row — but it does pay serialization, because
 * `authorize` sits after it.
 *
 * Recording the refusal must never break the denial (L6): `dispatch.content`
 * and `dispatch.errorCode` are set FIRST, then `recordGoalRefusal` is attempted
 * inside a contained `try`/`catch`. A persistence failure is logged and
 * swallowed, so a non-throwing denial stays non-throwing rather than surfacing
 * as a body error.
 */
export function createAuthorizeInterceptor(opts: {
  ledger: GoalLedger;
  goalId: string;
}): ToolInterceptor {
  const ledger = opts.ledger;
  const goalId = opts.goalId;
  const refuse = (dispatch: ToolDispatch): void => {
    const call = dispatch.call;
    dispatch.content = goalToolRefusalContent("unauthorized", call.tool);
    dispatch.errorCode = GOAL_TOOL_REFUSED;
    try {
      ledger.recordGoalRefusal(goalId, {
        stepSeq: call.stepSeq ?? 0,
        ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
        tool: call.tool,
        args: call.args,
        reason: "unauthorized",
      });
    } catch (err) {
      console.warn(
        `[goals] failed to record refusal for tool '${call.tool}':`,
        err,
      );
    }
  };
  return {
    name: "authorize",
    async around(dispatch, next) {
      if (!dispatch.call.readOnly && dispatch.call.goalAuthorised !== true) {
        refuse(dispatch);
        return;
      }
      await next();
    },
  };
}
