import { toolArgsHash } from "../../middleware/cache.ts";
import type { GoalLedger } from "../../goals/ledger.ts";
import type { ToolInterceptor } from "../pipeline.ts";
import {
  GOAL_TOOL_REFUSED,
  goalToolRefusalContent,
} from "./authorize.ts";

/**
 * `reserve` interceptor — goal-channel at-most-once mutation guard (plan
 * F3(b), L12 / R12 / R21).
 *
 * A MUTATING (`readOnly === false`) call reserves its `(pluginId, tool,
 * argsHash)` key on the `goal_mutation` ledger BEFORE any egress and records
 * the body's outcome AFTER it settles. Read-only calls are never reserved:
 * they cannot escape an effect, so deduping them would only refuse legitimate
 * repeats.
 *
 * Registered INNERMOST, between `budget` and `execution` (M4 order), so it
 * observes the body's true outcome: `execution`'s bound and the body run
 * INSIDE `reserve`'s `try`, while `dispatch.executed`/`dispatch.bodyFailed`
 * are both final by the time its `finally` runs. `budget` stays OUTSIDE, so
 * its own `finally` still runs after `reserve`'s and quarantine still fires
 * (D7).
 *
 * ## Two synchronous transactions
 *
 * A `better-sqlite3` transaction cannot span an `await next()`, so the guard
 * is split into two independent synchronous transactions:
 *
 *   - **txn1** (before the body) does read + conditional insert/replace and
 *     returns the verdict. It is synchronous, so under Node's single thread
 *     two identical same-round siblings cannot interleave: the first inserts
 *     `pending`, the second reads it and is refused (R21).
 *   - **txn2** (in `finally`, after the body settles) stamps the outcome onto
 *     the row txn1 created. It never inserts — `markMutation` UPDATEs by the
 *     UNIQUE `(goal_id, plugin_id, tool, args_hash)` key.
 *
 * A refusal is a NON-THROWING denial (the supported contract): set
 * `dispatch.content` + `dispatch.errorCode` and return WITHOUT `next()`, so
 * `ok:false`, `outcome:"error"`, and `executed:false` fall out of the
 * pipeline's frozen denial contract, the body never runs, and the channel's
 * `onBodySkipped` still releases its raw-body deferred. The refusal is also
 * recorded append-only on `goal_refusal` (args redacted by the ledger); L6: the
 * denial fields are set FIRST and the record is contained in a `try`/`catch`,
 * so a persistence failure cannot turn the non-throwing denial into a throw.
 *
 * M2: the `finally`'s `markMutation` is likewise contained. Bookkeeping must
 * never override the body outcome — an unguarded throw there (e.g. the DB
 * closed during shutdown) would REPLACE a thrown body error or corrupt a clean
 * dispatch, while the pipeline contract is that a thrown body error propagates
 * unchanged.
 *
 * ## Outcome classification (three-way)
 *
 * `dispatch.executed` alone cannot express the body's outcome (it is set
 * immediately before the body), so txn2 reads all three signals:
 *
 * | Condition                                  | State       | Identical call |
 * |--------------------------------------------|-------------|----------------|
 * | Body never ran (`executed === false`)      | `retryable` | Permitted (row replaced) |
 * | Body ran; clean success                    | `applied`   | Refused        |
 * | Body ran; threw **or** `bodyFailed`        | `unresolved`| Refused until resolved |
 *
 * The `bodyFailed` arm is the tombstone regression guard: an MCP tool that
 * RETURNS `isError: true` does not throw, so without it a domain-failed
 * mutation would be misclassified `applied` and the identical call silently
 * refused forever.
 *
 * ## R22 — reserve sits INSIDE budget
 *
 * Unlike the job channel's `replay` (which sits outside `budget`), `reserve`
 * is inside it. On reserve's short-circuit denial the denied call already holds
 * a plugin slot; if a CONCURRENT same-plugin call is waiting on that slot, the
 * release is a microtask away and the waiter may be refused `budget_exhausted`
 * before it is released. Accepted: the window is a single microtask, and the
 * alternative (reserve outside budget) would let a reservation run on a call
 * budget never admits.
 */
export function createReserveInterceptor(opts: {
  ledger: GoalLedger;
  goalId: string;
}): ToolInterceptor {
  const ledger = opts.ledger;
  const goalId = opts.goalId;
  return {
    name: "reserve",
    async around(dispatch, next) {
      const call = dispatch.call;
      if (call.readOnly) {
        await next();
        return;
      }
      const key = {
        pluginId: call.pluginId,
        tool: call.tool,
        argsHash: toolArgsHash(call.args),
      };
      // txn1 — synchronous: read + conditional replace, atomic under Node's
      // single thread.
      const verdict = ledger.reserveMutation(goalId, key, call.stepSeq);
      if (!verdict.ok) {
        // L6: set the dispatch denial FIRST, then attempt the durable record
        // inside a contained try/catch. A persistence failure must not convert
        // this non-throwing denial into a throw.
        dispatch.content = goalToolRefusalContent(verdict.reason, call.tool);
        dispatch.errorCode = GOAL_TOOL_REFUSED;
        try {
          ledger.recordGoalRefusal(goalId, {
            stepSeq: call.stepSeq ?? 0,
            ...(call.toolCallId === undefined
              ? {}
              : { toolCallId: call.toolCallId }),
            tool: call.tool,
            args: call.args,
            reason: verdict.reason,
          });
        } catch (err) {
          console.warn(
            `[goals] failed to record refusal for tool '${call.tool}':`,
            err,
          );
        }
        return; // no next(): the body never runs
      }
      let threw = false;
      try {
        await next();
      } catch (error) {
        threw = true;
        throw error;
      } finally {
        // txn2 — synchronous, after the body (never spans an await):
        // `executed` is final here, and `bodyFailed` has been set by the body
        // itself if the underlying tool reported an in-band domain failure.
        //
        // M2: bookkeeping must NEVER override the body outcome. `markMutation`
        // can throw (e.g. the DB closed during shutdown), and an unguarded
        // throw here would REPLACE a body error (or corrupt a clean dispatch)
        // — the pipeline contract is that a thrown body error propagates
        // unchanged. Contained like every other settlement sink.
        try {
          ledger.markMutation(
            goalId,
            key,
            dispatch.executed
              ? threw || dispatch.bodyFailed
                ? "unresolved"
                : "applied"
              : "retryable",
          );
        } catch (err) {
          console.warn(
            `[goals] failed to settle mutation '${call.tool}':`,
            err,
          );
          // F3: a failed settle leaves the row `pending`. Pending rows are
          // INVISIBLE to `resolveMutations` (which only sees `unresolved`), so
          // without this the goal would be stranded un-resolvable until the next
          // restart adopts it. Adopting to `unresolved` now makes the
          // `needs_mutation_resolution` pause the step-end will perform actually
          // breakable by the client. Contained: this is bookkeeping and must
          // never mask the body outcome (the same rule as the settle above).
          try {
            ledger.adoptPendingMutations(goalId);
          } catch (adoptErr) {
            console.warn(
              `[goals] failed to adopt pending mutations for goal ` +
                `${goalId} after a settle failure:`,
              adoptErr,
            );
          }
        }
      }
    },
  };
}
