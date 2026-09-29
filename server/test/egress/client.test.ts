import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import tls from "node:tls";
import { Agent } from "undici";
import { createPinnedEgressClient } from "../../src/egress/client.ts";
import { createEgressPolicy, SsrfValidationError } from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

/**
 * The egress facade's job is PARITY with the `ssrf.ts` primitives it composes,
 * plus the per-request re-validation that long-lived streams need. Every test
 * stubs BOTH the DNS resolver (`lookup`) and the network caller (`fetchFn`) so
 * nothing touches the real network.
 */
function fakeLookup(records: readonly LookupAddress[]): LookupFn {
  return async (_hostname, _options) => [...records];
}

const PUBLIC = [{ address: "1.1.1.1", family: 4 }];

function fetchSpy(): {
  callCount: number;
  lastInit?: RequestInit;
  lastUrl?: string;
  fn: typeof fetch;
} {
  const spy: {
    callCount: number;
    lastInit?: RequestInit;
    lastUrl?: string;
    fn: typeof fetch;
  } = {
    callCount: 0,
    fn: async (input, init) => {
      spy.callCount += 1;
      spy.lastUrl = String(input);
      spy.lastInit = init;
      return new Response("ok", { status: 200 });
    },
  };
  return spy;
}

function dispatcherOf(init: RequestInit | undefined): unknown {
  return (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher;
}

describe("EgressClient.fetch without a policy (validatedFetch parity)", () => {
  test("rejects private/loopback/link-local/metadata literals with no trusted hosts", async () => {
    for (const url of [
      "https://10.0.0.5/api",
      "https://127.0.0.1/api",
      "https://192.168.1.1/api",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/api",
    ]) {
      const spy = fetchSpy();
      const client = createPinnedEgressClient({ mode: "test", fetchFn: spy.fn });
      await assert.rejects(
        client.fetch(url),
        (error: unknown) =>
          error instanceof SsrfValidationError && error.code === "DISALLOWED_HOST",
        url,
      );
      assert.equal(spy.callCount, 0, `must not fetch ${url}`);
    }
  });

  test("refuses a 3xx redirect", async () => {
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: fakeLookup(PUBLIC),
      fetchFn: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.internal/x" } }),
    });
    await assert.rejects(
      client.fetch("https://example.com/api"),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "REDIRECT_REFUSED",
    );
  });

  test("honours trustedHosts and httpAllowedHosts supplied at construction", async () => {
    const spy = fetchSpy();
    const client = createPinnedEgressClient({
      mode: "test",
      trustedHosts: ["internal.example"],
      httpAllowedHosts: ["internal.example"],
      lookup: fakeLookup([{ address: "10.0.0.5", family: 4 }]),
      fetchFn: spy.fn,
    });
    const response = await client.fetch("https://internal.example/api");
    assert.equal(response.status, 200);
    assert.equal(spy.callCount, 1);
  });

  test("httpAllowedHosts is a separate production http: carve-out from trustedHosts", async () => {
    const allowed = fetchSpy();
    const allowedClient = createPinnedEgressClient({
      mode: "production",
      trustedHosts: ["ntfy.internal"],
      httpAllowedHosts: ["ntfy.internal"],
      lookup: fakeLookup([{ address: "10.0.0.9", family: 4 }]),
      fetchFn: allowed.fn,
    });
    const response = await allowedClient.fetch("http://ntfy.internal/topic");
    assert.equal(response.status, 200);
    assert.equal(allowed.callCount, 1);

    const httpsOnly = fetchSpy();
    const httpsOnlyClient = createPinnedEgressClient({
      mode: "production",
      trustedHosts: ["ntfy.internal"],
      lookup: fakeLookup([{ address: "10.0.0.9", family: 4 }]),
      fetchFn: httpsOnly.fn,
    });
    await assert.rejects(
      httpsOnlyClient.fetch("http://ntfy.internal/topic"),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "UNSUPPORTED_SCHEME",
    );
    assert.equal(httpsOnly.callCount, 0);
  });
});

describe("EgressClient.fetch with a policy (policyFetch parity)", () => {
  function policy() {
    return createEgressPolicy({
      subject: "tool:vikunja",
      mode: "test",
      destinations: [{
        baseUrl: "https://vikunja.example.com",
        pinnedIps: ["1.1.1.1"],
        methods: ["POST"],
        exactPaths: ["/list_tasks"],
      }],
    });
  }

  test("rejects a URL outside the policy path or method", async () => {
    const spy = fetchSpy();
    const client = createPinnedEgressClient({ fetchFn: spy.fn });
    await assert.rejects(
      client.fetch("https://vikunja.example.com/other", { method: "POST" }, policy()),
      (error: unknown) => error instanceof SsrfValidationError && error.code === "EGRESS_DENIED",
    );
    await assert.rejects(
      client.fetch("https://vikunja.example.com/list_tasks", { method: "GET" }, policy()),
      (error: unknown) => error instanceof SsrfValidationError && error.code === "EGRESS_DENIED",
    );
    assert.equal(spy.callCount, 0);
  });

  test("pins the connector to the policy's validated IP", async (t) => {
    const stopped = new Error("fake connector complete");
    t.mock.method(tls, "connect", (options: tls.ConnectionOptions & { lookup: LookupFunction }) => {
      options.lookup("vikunja.example.com", { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
      });
      throw stopped;
    });
    const client = createPinnedEgressClient({
      fetchFn: async (_url, init) => {
        const dispatcher = dispatcherOf(init);
        assert.ok(dispatcher instanceof Agent);
        await assert.rejects(
          dispatcher.request({
            origin: "https://vikunja.example.com",
            path: "/list_tasks",
            method: "POST",
          }),
          stopped,
        );
        return new Response("ok");
      },
    });
    const response = await client.fetch(
      "https://vikunja.example.com/list_tasks",
      { method: "POST" },
      policy(),
    );
    assert.equal(await response.text(), "ok");
  });
});

describe("EgressClient.openPinned", () => {
  test("re-validates on every fetch rather than reusing the first decision", async () => {
    const spy = fetchSpy();
    const client = createPinnedEgressClient({
      mode: "test",
      trustedHosts: ["pinned.example"],
      lookup: fakeLookup([{ address: "10.0.0.5", family: 4 }]),
      fetchFn: spy.fn,
    });
    const stream = await client.openPinned("https://pinned.example/mcp");
    try {
      const first = await stream.fetch("https://pinned.example/mcp");
      assert.equal(first.status, 200);
      assert.equal(spy.callCount, 1);

      // Validation is synchronous (as MCP's `mcpFetch` is today): a disallowed
      // URL throws before the network is reached, on the second call too.
      assert.throws(
        () => stream.fetch("https://10.0.0.5/mcp"),
        (error: unknown) =>
          error instanceof SsrfValidationError && error.code === "DISALLOWED_HOST",
      );
      assert.equal(spy.callCount, 1, "the second call must re-validate before fetching");
    } finally {
      await stream.dispose();
    }
  });

  test("forces redirect: manual against a pinned agent and preserves caller init", async () => {
    const spy = fetchSpy();
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: fakeLookup(PUBLIC),
      fetchFn: spy.fn,
    });
    const stream = await client.openPinned("https://example.com/mcp");
    try {
      await stream.fetch("https://example.com/mcp", {
        headers: { accept: "text/event-stream" },
      });
      assert.equal(spy.lastInit?.redirect, "manual");
      assert.ok(dispatcherOf(spy.lastInit) instanceof Agent, "default agent is buildPinnedAgent");
      assert.deepEqual(spy.lastInit?.headers, { accept: "text/event-stream" });
    } finally {
      await stream.dispose();
    }
  });

  test("uses retained pins without DNS and validates them before building the agent", async () => {
    let lookups = 0;
    let captured: readonly string[] = [];
    const spy = fetchSpy();
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: async () => {
        lookups++;
        return [{ address: "1.1.1.1", family: 4 }];
      },
      fetchFn: spy.fn,
    });
    const stream = await client.openPinned("https://retained.example/mcp", {
      pinnedIps: ["93.184.216.34"],
      createAgent: (_hostname, _parsed, pinned) => {
        captured = pinned;
        return { destroy: async () => {} };
      },
    });
    try {
      assert.equal(lookups, 0, "retained pins must not trigger a DNS lookup");
      assert.deepEqual(captured, ["93.184.216.34"]);
    } finally {
      await stream.dispose();
    }
  });

  test("re-authorizes retained pins and refuses an unsafe one", async () => {
    const client = createPinnedEgressClient({ mode: "test", fetchFn: fetchSpy().fn });
    await assert.rejects(
      client.openPinned("https://retained.example/mcp", {
        pinnedIps: ["169.254.169.254"],
      }),
      (error: unknown) => error instanceof SsrfValidationError && error.code === "EGRESS_DENIED",
    );
  });

  test("resolves an unpinned host exactly once", async () => {
    let lookups = 0;
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: async () => {
        lookups++;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetchFn: fetchSpy().fn,
    });
    const stream = await client.openPinned("https://unpinned.example/mcp", {
      createAgent: () => ({ destroy: async () => {} }),
    });
    try {
      assert.equal(lookups, 1);
    } finally {
      await stream.dispose();
    }
  });

  test("dispose is idempotent and destroys the agent exactly once", async () => {
    let destroys = 0;
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: fakeLookup(PUBLIC),
      fetchFn: fetchSpy().fn,
    });
    const stream = await client.openPinned("https://example.com/mcp", {
      createAgent: () => ({
        destroy: async () => {
          destroys++;
        },
      }),
    });
    await stream.dispose();
    await stream.dispose();
    assert.equal(destroys, 1);
  });

  test("a failing destroy does not reject dispose", async () => {
    const client = createPinnedEgressClient({
      mode: "test",
      lookup: fakeLookup(PUBLIC),
      fetchFn: fetchSpy().fn,
    });
    const stream = await client.openPinned("https://example.com/mcp", {
      createAgent: () => ({
        destroy: async () => {
          throw new Error("destroy failed");
        },
      }),
    });
    await stream.dispose();
  });
});

describe("per-domain trust isolation", () => {
  test("a host trusted by one client is rejected by another built without it", async () => {
    const lookup = fakeLookup([{ address: "10.0.0.5", family: 4 }]);
    const trustedSpy = fetchSpy();
    const untrustedSpy = fetchSpy();

    const trusted = createPinnedEgressClient({
      mode: "test",
      trustedHosts: ["internal.example"],
      httpAllowedHosts: ["internal.example"],
      lookup,
      fetchFn: trustedSpy.fn,
    });
    const untrusted = createPinnedEgressClient({
      mode: "test",
      lookup,
      fetchFn: untrustedSpy.fn,
    });

    const allowed = await trusted.fetch("https://internal.example/api");
    assert.equal(allowed.status, 200);
    assert.equal(trustedSpy.callCount, 1);

    await assert.rejects(
      untrusted.fetch("https://internal.example/api"),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "DNS_REBINDING",
    );
    assert.equal(untrustedSpy.callCount, 0);
  });
});
