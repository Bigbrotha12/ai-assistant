import { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Shared agent-execution tracking for the sync stream (transport/chat.ts) and
 * background jobs (jobs/runner.ts). Both paths wrap every long-lived async
 * operation (model dispatch, tool execution) in `track()` so the caller can
 * `settle()` — drain in-flight work — before releasing the thread lock /
 * disposing the run.
 */
export type TrackedExecution = {
  signal: AbortSignal;
  track<T>(run: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
};

export function createTrackedExecution(signal: AbortSignal): TrackedExecution {
  const pending = new Set<Promise<unknown>>();
  return {
    signal,
    async track<T>(run: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const work = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run();
      });
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    async settle(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

/**
 * Wrap a chat model's dispatch so its `_generate` / `_streamResponseChunks`
 * calls are tracked by the execution (so `settle()` waits for an in-flight
 * model call before the stream/job cleanup releases its resources).
 */
export function trackModelExecution(
  model: BaseChatModel,
  execution: TrackedExecution,
): void {
  const seen = new WeakSet<object>();
  const wrap = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (!(candidate instanceof BaseChatModel)) {
      if ("bound" in candidate) wrap(candidate.bound);
      return;
    }
    const generate = candidate._generate.bind(candidate);
    candidate._generate = (...args) => execution.track(() => generate(...args));
    const chunks = candidate._streamResponseChunks.bind(candidate);
    if (candidate._streamResponseChunks !== BaseChatModel.prototype._streamResponseChunks) {
      candidate._streamResponseChunks = async function* (...args) {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        const tracked = execution.track(() => done);
        try {
          execution.signal.throwIfAborted();
          yield* chunks(...args);
        } finally {
          finish();
          await tracked;
        }
      };
    }
    const bind = candidate.bindTools?.bind(candidate);
    if (bind) {
      candidate.bindTools = (...args) => {
        const bound = bind(...args);
        wrap(bound);
        return bound;
      };
    }
  };
  wrap(model);
}