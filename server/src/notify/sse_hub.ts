/**
 * In-memory, owner-scoped registry of SSE connections for job-completion
 * notifications. `SseNotificationHook` (`sse_hook.ts`) broadcasts through it;
 * `createSseNotifyRoutes` (`sse_routes.ts`) opens a stream per request.
 *
 * SINGLE-REPLICA ASSUMPTION: the registry lives in one process, like the RAM
 * session store and the runner registries. A second replica would not see
 * another replica's streams, so a job completing on replica A could miss a
 * client streamed to replica B. `index.ts` documents this same constraint.
 *
 * LIFECYCLE / TEARDOWN (DEFENSIVE_PATTERNS §3–4): a stream is removed the
 * moment the client disconnects (the `ReadableStream` cancel callback), when
 * its owner is closed (`closeOwner`, used by account deletion), or when a write
 * fails because the socket is gone. Every removal is idempotent, so a late
 * completion or a double close can never resurrect or leak an entry.
 * `broadcast` is a no-op for an owner with no open streams and never throws, so
 * a dead stream can never fail a job's completion.
 */

const DEFAULT_KEEP_ALIVE_MS = 30_000;

/** The wire shape of one notification event (see the client contract). */
export type SseNotification = {
  /** Client-parsed title; the job hook always sends `Job <taskId>`. */
  title: string;
  /** Notification body (the job summary). */
  body: string;
};

/** A single connected client's stream. */
export type SseConnection = {
  /** The `text/event-stream` response to return from the route. */
  response: Response;
  /** Server-side close (idempotent); also removes it from its owner's set. */
  close(): void;
};

export type SseHubOptions = {
  /** Keep-alive comment cadence in ms. Defaults to 30_000; test seam. */
  keepAliveMs?: number;
};

export type SseHub = {
  /** Register a connection for `owner` and return the streaming response. */
  open(owner: string): SseConnection;
  /** Send one event to every open stream for `owner` (no-op when none). */
  broadcast(owner: string, event: SseNotification): void;
  /** Close and forget every stream for `owner`. Idempotent. */
  closeOwner(owner: string): void;
  /** Open-stream count across all owners, or just `owner` when given. */
  connectionCount(owner?: string): number;
  /** Close every stream and stop the keep-alive timer (shutdown). Idempotent. */
  dispose(): void;
};

type LiveStream = {
  owner: string;
  alive: boolean;
  controller: ReadableStreamDefaultController<Uint8Array>;
};

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
} as const;

/** Wraps a payload as exactly one SSE data frame terminated by a blank line. */
function dataFrame(event: SseNotification): string {
  return `data: ${JSON.stringify({ title: event.title, body: event.body })}\n\n`;
}

export function createSseHub(opts: SseHubOptions = {}): SseHub {
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const encoder = new TextEncoder();
  const byOwner = new Map<string, Set<LiveStream>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const forget = (stream: LiveStream): void => {
    const set = byOwner.get(stream.owner);
    if (!set) return;
    set.delete(stream);
    if (set.size > 0) return;
    byOwner.delete(stream.owner);
    if (byOwner.size === 0) stopTimer();
  };

  const closeStream = (stream: LiveStream): void => {
    if (!stream.alive) return;
    stream.alive = false;
    forget(stream);
    try {
      stream.controller.close();
    } catch {
      // Already closed/errored — e.g. the client disconnected first.
    }
  };

  const write = (stream: LiveStream, chunk: string): void => {
    if (!stream.alive) return;
    try {
      stream.controller.enqueue(encoder.encode(chunk));
    } catch {
      // The controller is gone (the socket vanished between the alive check and
      // here). Drop the stream so a later broadcast never retries a dead one.
      closeStream(stream);
    }
  };

  const startTimer = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      // Snapshot: a failing write removes its stream mid-iteration.
      for (const set of [...byOwner.values()]) {
        for (const stream of [...set]) write(stream, ": keepalive\n\n");
      }
    }, keepAliveMs);
    timer.unref?.();
  };

  return {
    open(owner) {
      let stream: LiveStream | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = { owner, alive: true, controller };
          let set = byOwner.get(owner);
          if (!set) {
            set = new Set();
            byOwner.set(owner, set);
          }
          set.add(stream);
          startTimer();
        },
        cancel() {
          // The client hung up: drop the registration and never touch the
          // controller (the stream is already being closed by the runtime).
          if (stream) {
            stream.alive = false;
            forget(stream);
          }
        },
      });
      return {
        response: new Response(body, { headers: SSE_HEADERS }),
        close() {
          if (stream) closeStream(stream);
        },
      };
    },
    broadcast(owner, event) {
      const set = byOwner.get(owner);
      if (!set || set.size === 0) return;
      // Snapshot so a write failure that removes a stream does not mutate the
      // set mid-iteration (a `for…of` over a Set is otherwise order-sensitive
      // to deletion).
      for (const stream of [...set]) write(stream, dataFrame(event));
    },
    closeOwner(owner) {
      const set = byOwner.get(owner);
      if (!set) return;
      for (const stream of [...set]) closeStream(stream);
    },
    connectionCount(owner) {
      if (owner === undefined) {
        let total = 0;
        for (const set of byOwner.values()) total += set.size;
        return total;
      }
      return byOwner.get(owner)?.size ?? 0;
    },
    dispose() {
      for (const set of [...byOwner.values()]) {
        for (const stream of [...set]) closeStream(stream);
      }
      byOwner.clear();
      stopTimer();
    },
  };
}
