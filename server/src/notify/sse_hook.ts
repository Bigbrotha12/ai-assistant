import type { NotificationHook } from "../jobs/runner.ts";
import type { SseHub, SseNotification } from "./sse_hub.ts";

/** The hub capability the hook needs (kept structural for test seams). */
export type SseBroadcaster = Pick<SseHub, "broadcast">;

/**
 * The runner's {@link NotificationHook}: fans a completed background job out to
 * every open SSE stream for the owner (see `sse_hub.ts`). Delivery rides the
 * owner's already-authenticated event stream, so a completion reaches the client
 * without a separate push channel or per-device credentials.
 *
 * The client extracts the task id from the `Job <taskId>` title prefix
 * (`^Job\s+([^\s]+)`), so that format is part of the wire contract — keep the
 * title exactly `Job ${taskId}`.
 *
 * `broadcast` is synchronous, never throws, and is a no-op when the owner has no
 * open streams, so a completion is never delayed or failed by delivery.
 */
export function createSseNotificationHook(hub: SseBroadcaster): NotificationHook {
  return {
    notifyJobComplete(owner, taskId, summary) {
      const event: SseNotification = { title: `Job ${taskId}`, body: summary };
      hub.broadcast(owner, event);
    },
    notifyGoalStopped(owner, goalId, status, reason) {
      const title = status === "paused" ? "Goal needs you" : "Goal failed";
      const event: SseNotification = { title, body: `Goal ${goalId} ${status} (${reason})` };
      hub.broadcast(owner, event);
    },
  };
}
