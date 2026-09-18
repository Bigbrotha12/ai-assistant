import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createNtfyNotificationHook } from "../../src/notify/hook.ts";
import type { NotificationCredentialSource } from "../../src/notify/hook.ts";
import type { NotifyCredentials } from "../../src/notify/store.ts";

const BASE = "https://ntfy.example.com";
const TOKEN = "secret-access-token-abc123";

function fakeStore(
  credentials: NotifyCredentials | undefined,
): NotificationCredentialSource {
  return { get: async () => credentials };
}

type FetchCall = { url: string; init: RequestInit };

/** Records calls and returns a 200 without hitting the network. */
function recordingFetch() {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CREDS: NotifyCredentials = { topic: "assistant-user-a-abc", accessToken: TOKEN };

describe("ntfy notification hook", () => {
  test("POSTs to the encoded topic URL with auth, Title, and summary body", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: BASE,
      fetchImpl,
    });

    await hook.notifyJobComplete("user-a", "task-42", "job finished successfully");

    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(url, `${BASE}/${encodeURIComponent(CREDS.topic)}`);
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers["Content-Type"], "text/plain");
    assert.equal(headers.Title, "Job task-42");
    assert.equal(init.body, "job finished successfully");
  });

  test("empty baseUrl disables the hook: fetch is never called", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({ store: fakeStore(CREDS), baseUrl: "", fetchImpl });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(calls.length, 0);
  });

  test("no stored credentials for the owner: fetch is never called", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(undefined),
      baseUrl: BASE,
      fetchImpl,
    });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(calls.length, 0);
  });

  test("a rejecting fetch resolves without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: BASE,
      fetchImpl,
    });

    await assert.doesNotReject(async () => {
      await hook.notifyJobComplete("user-a", "task-42", "summary");
    });
  });

  test("the access token never appears in logged error output", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connection refused for Bearer ${TOKEN}`);
    }) as typeof fetch;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const hook = createNtfyNotificationHook({
        store: fakeStore(CREDS),
        baseUrl: BASE,
        fetchImpl,
      });
      await hook.notifyJobComplete("user-a", "task-42", "summary");
    } finally {
      console.warn = original;
    }

    assert.equal(warnings.some((line) => line.includes(TOKEN)), false);
  });
});
