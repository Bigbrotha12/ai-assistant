import { AsyncMutex } from "./mutex.ts";

/**
 * Per-thread invocation lock registry (Phase 3, Wave C2).
 *
 * The background `JobRunner` and the synchronous chat transport both write
 * LangGraph checkpoints keyed by an owner-bound thread id. Node is
 * single-threaded, but two concurrent `graph.invoke`/`graph.streamEvents` calls
 * on the SAME checkpoint thread still interleave at await points: both read the
 * same base checkpoint, both run the model/tools, and the last writer clobbers
 * the other's messages (lost update).
 *
 * This registry owns one {@link AsyncMutex} per checkpoint thread id and is the
 * SINGLE lock authority shared by every writer in the process. `index.ts`
 * constructs ONE registry and hands it to both the JobRunner (`threadLocks`)
 * and the chat transport (`threadLocks`), so a synchronous stream and a
 * background job on the same thread serialize against EACH OTHER — not just
 * against their own kind.
 *
 * The lock is held for the WHOLE graph run (the entire stream for the sync
 * path, the whole invoke for the runner) and released in a finally, so a slow
 * client or a long job simply queues later writers on the same thread FIFO.
 *
 * The per-thread mutex is GC'd from the map once a run finishes AND the mutex
 * is idle (no holder, no waiters): a waiter queued behind us keeps the shared
 * mutex (never split a thread across two locks), and a finished run's mutex
 * does not leak.
 */
export class ThreadLockRegistry {
  private readonly locks = new Map<string, AsyncMutex>();

  /** Live per-thread mutex map (the runner's GC tests assert on `size`). */
  get mutexes(): Map<string, AsyncMutex> {
    return this.locks;
  }

  /** The mutex for a thread, creating it on first use. */
  mutexFor(threadId: string): AsyncMutex {
    let mutex = this.locks.get(threadId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.locks.set(threadId, mutex);
    }
    return mutex;
  }

  /**
   * Acquire the thread's mutex and resolve with a release function that MUST be
   * called (in a finally) when the run finishes or aborts. The mutex is GC'd on
   * release when idle. `release()` is safe to call even if a run was aborted
   * before the mutex was ever contended.
   */
  async acquire(threadId: string): Promise<() => void> {
    const mutex = this.mutexFor(threadId);
    const release = await mutex.acquire();
    return () => {
      release();
      if (this.locks.get(threadId) === mutex && mutex.isIdle) {
        this.locks.delete(threadId);
      }
    };
  }

  /** Acquire → run `fn` → release (release + GC happen even if `fn` throws). */
  async runExclusive<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(threadId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Number of live per-thread mutexes (diagnostics/tests). */
  get size(): number {
    return this.locks.size;
  }
}