import type { ToolBody, ToolBodies, ToolCallScope } from "./pipeline.ts";

/**
 * `bind.ts` — shared channel-side construction of a dispatch's `ToolBodies` and
 * `ToolCallScope` (plan §4.2 `makePluginBodies`).
 *
 * Every plugin-source channel (sync today; job; warmup after 1.9c) needs the
 * same three things, and only the raw executor call differs:
 *
 *   1. a `rawSettled` deferred that resolves when the RAW (unbounded) handler
 *      settles — NOT when the bounded race settles — so the `budget`
 *      interceptor can tell an unsettled timeout (quarantine) from a release;
 *   2. a `plugin` body that invokes the raw handler and resolves that deferred
 *      on BOTH settlement paths, including a synchronous throw before the raw
 *      work starts;
 *   3. a `scope` carrying `rawSettled` + `onBodySkipped` (which resolves the
 *      SAME deferred when the core reports the body never started, so budget
 *      releases rather than quarantines — D9) plus any channel-owned extras
 *      (`track`/`trackUntil`/`onToolStart`/`onToolEnd`).
 *
 * Extracted from the byte-identical blocks in `agents/orchestrator.ts` and
 * `jobs/runner.ts` (finding m1). `ToolCallScope` is `readonly`, so the scope is
 * constructed complete here and never mutated afterwards.
 */
export type MakePluginBodiesOptions = {
  /**
   * Invokes the raw handler with the composed body signal. Channel-specific
   * post-settlement work (e.g. sync's post-execution account-deletion tombstone
   * re-check) belongs here: a throw after the handler resolved rejects the body
   * after `rawSettled` has already resolved, so budget releases rather than
   * quarantines.
   */
  readonly invoke: (signal: AbortSignal) => Promise<string>;
  /** Channel-owned scope fields beyond `rawSettled`/`onBodySkipped`. */
  readonly scope?: Omit<ToolCallScope, "rawSettled" | "onBodySkipped">;
  /**
   * Label used in the default `mcp` body's fail-loud message (e.g. `"sync"`,
   * `"job"`). No channel routes MCP through this pipeline yet (step 1.11), so
   * this body should stay unreachable; it exists so a wiring bug is not masked
   * by a silent empty result.
   */
  readonly channelLabel: string;
};

export function makePluginBodies(
  opts: MakePluginBodiesOptions,
): { bodies: ToolBodies; scope: ToolCallScope } {
  let settleRaw!: () => void;
  const rawSettled = new Promise<void>((resolve) => {
    settleRaw = resolve;
  });
  const plugin: ToolBody = async (_dispatch, bodySignal) => {
    let raw: Promise<string>;
    try {
      raw = Promise.resolve(opts.invoke(bodySignal));
    } catch (error) {
      // The body was invoked (so the core will NOT fire `onBodySkipped`), but
      // the raw work never started; settle now so budget releases.
      settleRaw();
      throw error;
    }
    void raw.then(settleRaw, settleRaw);
    return raw;
  };
  const scope: ToolCallScope = {
    rawSettled,
    // REQUIRED wiring (D9): resolve the SAME deferred when the core reports the
    // body never started, so budget releases rather than quarantines.
    onBodySkipped: () => settleRaw(),
    ...opts.scope,
  };
  return {
    bodies: {
      plugin,
      mcp: async () => {
        throw new Error(
          `${opts.channelLabel} channel: mcp source not wired through the pipeline yet (step 1.11)`,
        );
      },
    },
    scope,
  };
}
