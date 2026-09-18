import type { NotificationHook } from "../jobs/runner.ts";
import type { NotifyCredentials } from "./store.ts";

/**
 * Real ntfy push behind the job runner's {@link NotificationHook} DI seam.
 *
 * SECURITY CONTRACT
 *  - The access token is read from the encrypted-at-rest notify store and used
 *    ONLY in the `Authorization: Bearer` header. It is never logged, never
 *    echoed into the summary, and never returned.
 *  - Best-effort delivery: any network/store failure is swallowed (a log
 *    without the token, at most) so a push failure can never break job
 *    completion. `notifyJobComplete` always resolves.
 *  - Disabled by default: an empty `baseUrl` (NOTIFY_BASE_URL) turns every call
 *    into a silent no-op, as does an owner with no stored credentials.
 */

/** The slice of `NotifyStore` the hook needs (kept structural for test seams). */
export type NotificationCredentialSource = {
  get(owner: string): Promise<NotifyCredentials | undefined>;
};

export type NtfyNotificationHookOptions = {
  store: NotificationCredentialSource;
  /** ntfy base URL, e.g. `https://ntfy.example.com`. Empty = disabled. */
  baseUrl: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Strips trailing slashes so `${base}/${topic}` never doubles a slash. */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function createNtfyNotificationHook(
  opts: NtfyNotificationHookOptions,
): NotificationHook {
  const base = trimTrailingSlashes(opts.baseUrl.trim());
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async notifyJobComplete(owner, taskId, summary) {
      if (base === "") return;

      let credentials: NotifyCredentials | undefined;
      try {
        credentials = await opts.store.get(owner);
      } catch {
        // A store read failure (corrupt file, wrong key) must not break the
        // job. Error text from the store never carries credential material.
        console.warn(`[notify] credential lookup failed for task ${taskId}`);
        return;
      }
      if (!credentials) return;

      try {
        await doFetch(`${base}/${encodeURIComponent(credentials.topic)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "text/plain",
            Title: `Job ${taskId}`,
          },
          body: summary,
        });
      } catch (err) {
        // Best-effort: log a generic reason only. `err` may embed the request
        // URL/topic, but never the token; keep the message token-free anyway.
        const reason = err instanceof Error ? err.name : "unknown";
        console.warn(`[notify] push failed for task ${taskId}: ${reason}`);
      }
    },
  };
}
