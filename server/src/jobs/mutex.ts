/**
 * Per-thread invocation mutex (Phase 2, Wave C1: background jobs).
 *
 * Node is single-threaded, but two concurrent `graph.invoke` calls on the SAME
 * checkpoint thread still interleave at await points: both would read the same
 * base checkpoint, both would run the model/tools, and the last writer would
 * clobber the other's messages (lost update). This is a plain promise-chain
 * mutex — no timers, no native locks — so only one `graph.invoke` runs against
 * a given thread_id at a time. The `JobRunner` keeps one `AsyncMutex` per
 * checkpoint thread_id.
 *
 * `acquire()` resolves with a release function once the previous holder is
 * done; `runExclusive(fn)` is the ergonomic wrapper (acquire → run → release
 * in a finally, so an exception never leaks the lock). The lock is fair in the
 * FIFO sense: waiters are chained onto `tail`, so they run in acquisition
 * order.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  /** Active holders + queued waiters (incremented on acquire, decremented on
   *  release). Lets the JobRunner safely GC a thread's mutex: a mutex may only
   *  be evicted when nobody holds it and nobody is queued behind it. */
  private waiters = 0;

  /** Wait for the lock; resolves with a release function that MUST be called. */
  async acquire(): Promise<() => void> {
    this.waiters += 1;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    await previous;
    return () => {
      release();
      this.waiters -= 1;
    };
  }

  /** True when nobody holds the lock and nobody is waiting for it. */
  get isIdle(): boolean {
    return this.waiters === 0;
  }

  /** Acquire → run `fn` → release (release happens even if `fn` throws). */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}