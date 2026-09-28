import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { createNtfyNotificationHook, notifyEgressConfigWarning } from "../../src/notify/hook.ts";
import type { NotificationCredentialSource } from "../../src/notify/hook.ts";
import type { NotifyCredentials } from "../../src/notify/store.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

const BASE = "https://ntfy.example.com";
const TOKEN = "secret-access-token-abc123";

function fakeStore(
  credentials: NotifyCredentials | undefined,
): NotificationCredentialSource {
  return { get: async () => credentials };
}

const DNS: Record<string, readonly LookupAddress[]> = {
  "ntfy.example.com": [{ address: "1.1.1.1", family: 4 }],
  "ntfy.internal": [{ address: "192.168.1.50", family: 4 }],
};

/** DNS seam for `validatedFetch`; literal-IP URLs bypass it entirely. */
function fakeLookup(records: Record<string, readonly LookupAddress[]> = DNS): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
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
      lookup: fakeLookup(),
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
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "",
      fetchImpl,
      lookup: fakeLookup(),
    });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(calls.length, 0);
  });

  test("no stored credentials for the owner: fetch is never called", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(undefined),
      baseUrl: BASE,
      fetchImpl,
      lookup: fakeLookup(),
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
      lookup: fakeLookup(),
    });

    await assert.doesNotReject(async () => {
      await hook.notifyJobComplete("user-a", "task-42", "summary");
    });
  });

  test("the access token never appears in logged error output", async () => {
    // A distinct token-shaped value in the thrown message: if the hook ever
    // logs `err.message` (previously it logged only `err.name`) this catches it.
    const leaked = `ntfy_live_${TOKEN}`;
    const fetchImpl = (async () => {
      throw new Error(`connection refused for Bearer ${leaked}`);
    }) as typeof fetch;
    const logs: string[] = [];
    const original = { warn: console.warn, log: console.log, error: console.error };
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.warn = capture;
    console.log = capture;
    console.error = capture;
    let result: unknown;
    try {
      const hook = createNtfyNotificationHook({
        store: fakeStore(CREDS),
        baseUrl: BASE,
        fetchImpl,
        lookup: fakeLookup(),
      });
      result = await hook.notifyJobComplete("user-a", "task-42", "summary");
    } finally {
      console.warn = original.warn;
      console.log = original.log;
      console.error = original.error;
    }

    assert.equal(
      logs.some((line) => line.includes(leaked) || line.includes(TOKEN)),
      false,
      "the token (or its token-shaped variant) must never reach any log sink",
    );
    // The response path carries nothing either: the hook resolves void.
    assert.equal(result, undefined);
    assert.equal(String(result).includes(TOKEN), false);
  });

  test("rejects loopback, RFC1918, link-local, and cloud-metadata hosts by default", async () => {
    for (const baseUrl of [
      "http://127.0.0.1",
      "http://10.1.2.3",
      "http://172.16.5.5",
      "http://192.168.1.50",
      "http://169.254.169.254",
      "http://[::1]",
    ]) {
      const { calls, fetchImpl } = recordingFetch();
      const hook = createNtfyNotificationHook({
        store: fakeStore(CREDS),
        baseUrl,
        fetchImpl,
        // Isolate the range check from the ambient NODE_ENV scheme policy.
        mode: "test",
      });

      await hook.notifyJobComplete("user-a", "task-42", "summary");

      assert.equal(calls.length, 0, `${baseUrl} must be refused before any fetch`);
    }
  });

  test("rejects a hostname that resolves to a private address by default", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "https://ntfy.internal",
      fetchImpl,
      lookup: fakeLookup(),
      // No trustedHosts: `ntfy.internal` resolves to 192.168.1.50 via the seam.
    });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(
      calls.length,
      0,
      "a hostname resolving to a private address must be refused before any fetch",
    );
  });

  test("accepts a literal private host listed in trustedHosts", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "http://192.168.1.50:8080",
      fetchImpl,
      trustedHosts: ["192.168.1.50"],
    });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `http://192.168.1.50:8080/${encodeURIComponent(CREDS.topic)}`);
  });

  test("accepts a hostname listed in trustedHosts whose records are private", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const hook = createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "https://ntfy.internal",
      fetchImpl,
      lookup: fakeLookup(),
      trustedHosts: ["ntfy.internal"],
    });

    await hook.notifyJobComplete("user-a", "task-42", "summary");

    assert.equal(calls.length, 1);
  });

  test("production rejects a plain http: ntfy URL unless its host is trusted", async () => {
    const untrusted = recordingFetch();
    await createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "http://ntfy.example.com",
      fetchImpl: untrusted.fetchImpl,
      lookup: fakeLookup(),
      mode: "production",
    }).notifyJobComplete("user-a", "task-42", "summary");
    assert.equal(untrusted.calls.length, 0, "untrusted http: must be refused");

    const trusted = recordingFetch();
    await createNtfyNotificationHook({
      store: fakeStore(CREDS),
      baseUrl: "http://ntfy.example.com",
      fetchImpl: trusted.fetchImpl,
      lookup: fakeLookup(),
      mode: "production",
      trustedHosts: ["ntfy.example.com"],
    }).notifyJobComplete("user-a", "task-42", "summary");
    assert.equal(trusted.calls.length, 1, "trusted http: is the documented carve-out");
  });

  test("refuses a 3xx redirect instead of following it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
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
        lookup: fakeLookup(),
      });
      await hook.notifyJobComplete("user-a", "task-42", "summary");
    } finally {
      console.warn = original;
    }

    assert.equal(calls, 1, "the redirect response is not retried/followed");
    assert.equal(
      warnings.some((line) => line.includes("SsrfValidationError")),
      true,
      "redirect refusal is surfaced as a swallowed SSRF error",
    );
  });
});

describe("notifyEgressConfigWarning", () => {
  test("returns null when NOTIFY_BASE_URL is empty (notifications disabled)", () => {
    assert.equal(notifyEgressConfigWarning(""), null);
    assert.equal(notifyEgressConfigWarning("   "), null);
  });

  test("returns null for a normal public https deployment", () => {
    // The common case must never warn (isIpAllowed is inconclusive for a
    // hostname; only literal IPs are range-checked here).
    assert.equal(notifyEgressConfigWarning("https://ntfy.example.com"), null);
    assert.equal(notifyEgressConfigWarning("https://ntfy.example.com/ntfy"), null);
  });

  test("returns null for a private-resolving HOSTNAME (no DNS at boot)", () => {
    // Without a DNS lookup we cannot know `ntfy.internal` is private, so the
    // helper stays quiet; the hook still refuses it at delivery time.
    assert.equal(notifyEgressConfigWarning("https://ntfy.internal"), null);
  });

  test("warns on an untrusted literal private/reserved address and names the knob", () => {
    for (const baseUrl of [
      "https://127.0.0.1",
      "https://10.1.2.3",
      "https://172.16.5.5",
      "https://192.168.1.50:8080",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[fd00::1]",
    ]) {
      const warning = notifyEgressConfigWarning(baseUrl);
      assert.notEqual(warning, null, `${baseUrl} must warn`);
      assert.match(warning!, /NOTIFY_TRUSTED_HOSTS/);
      // The offending host is named (bracket-stripped and lowercased).
      const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
      assert.ok(warning!.includes(host), `${baseUrl}: warning must name '${host}'`);
    }
  });

  test("returns null when the private literal host is trusted", () => {
    assert.equal(
      notifyEgressConfigWarning("http://192.168.1.50:8080", {
        trustedHosts: ["192.168.1.50"],
      }),
      null,
    );
  });

  test("warns on production http: for an untrusted host", () => {
    const warning = notifyEgressConfigWarning("http://ntfy.example.com", {
      mode: "production",
    });
    assert.notEqual(warning, null);
    assert.match(warning!, /http:/);
    assert.match(warning!, /ntfy\.example\.com/);
    assert.match(warning!, /NOTIFY_TRUSTED_HOSTS/);
    assert.match(warning!, /cleartext/, "must disclose the cleartext-token tradeoff");
  });

  test("production http: is fine when the host is trusted", () => {
    assert.equal(
      notifyEgressConfigWarning("http://ntfy.example.com", {
        mode: "production",
        trustedHosts: ["ntfy.example.com"],
      }),
      null,
    );
  });

  test("http: outside production does not warn for a public host", () => {
    assert.equal(
      notifyEgressConfigWarning("http://ntfy.example.com", { mode: "development" }),
      null,
    );
  });

  test("a URL that violates both rules is reported once, naming both reasons", () => {
    const warning = notifyEgressConfigWarning("http://192.168.1.50", {
      mode: "production",
    });
    assert.notEqual(warning, null);
    assert.match(warning!, /private\/reserved/);
    assert.match(warning!, /http: in production/);
    assert.match(warning!, /NOTIFY_TRUSTED_HOSTS/);
  });
});
