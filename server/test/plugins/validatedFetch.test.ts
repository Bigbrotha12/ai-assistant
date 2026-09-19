import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import tls from "node:tls";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import {
  SsrfValidationError,
  validatedFetch,
} from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

/**
 * The one sanctioned outbound-call assembly point (Fix 1): validate → resolve →
 * validate every record → connect in the same call, with redirects refused.
 * Every test stubs BOTH the DNS resolver (`lookup`) and the network caller
 * (`fetchFn`) so nothing touches the real network.
 */
function fakeLookup(records: readonly LookupAddress[]): LookupFn {
  return async (_hostname, _options) => [...records];
}

/** Records nothing about the URL/IP it is handed — just returns a 200. */
function okFetch(): typeof fetch {
  return async (_input, _init) => new Response("ok", { status: 200 });
}

function fetchSpy(): { callCount: number; lastInit?: RequestInit; lastUrl?: string; fn: typeof fetch } {
  const spy: { callCount: number; lastInit?: RequestInit; lastUrl?: string; fn: typeof fetch } = {
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

const PUBLIC = [{ address: "1.1.1.1", family: 4 }];

describe("validatedFetch", () => {
  test("pins the connector lookup without changing the URL, TLS hostname or SNI", async (t) => {
    const records = [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    let resolutions = 0;
    let connections = 0;
    const stopped = new Error("fake connector complete");
    t.mock.method(tls, "connect", (options: tls.ConnectionOptions & { lookup: LookupFunction }) => {
      connections++;
      assert.equal(options.host, "example.com");
      assert.equal(options.servername, "example.com");
      assert.equal(options.rejectUnauthorized, true);
      options.lookup("example.com", { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, records);
      });
      options.lookup("example.com", { family: 6 }, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, records[1]!.address);
        assert.equal(family, 6);
      });
      options.lookup("example.com", { all: true, family: 4 }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [records[0]]);
      });
      options.lookup("example.com", {}, (error, address) => {
        assert.equal(error, null);
        assert.equal(address, records[0]!.address);
      });
      options.lookup("other.example", {}, (error) => {
        assert.ok(error instanceof SsrfValidationError);
      });
      assert.equal(options.checkServerIdentity, undefined);
      throw stopped;
    });
    const response = await validatedFetch("https://example.com/api", {}, {
      mode: "test",
      lookup: async () => {
        resolutions++;
        return records.map((record) => ({ ...record }));
      },
      fetchFn: async (url, init) => {
        assert.equal(url, "https://example.com/api");
        const dispatcher = (init as RequestInit & { dispatcher: Agent }).dispatcher;
        assert.ok(dispatcher instanceof Agent);
        await assert.rejects(dispatcher.request({
          origin: "https://example.com",
          path: "/api",
          method: "GET",
        }), stopped);
        return new Response("ok");
      },
    });
    assert.equal(await response.text(), "ok");
    assert.equal(resolutions, 1);
    assert.equal(connections, 1);
  });

  test("the default fetch uses the pinned dispatcher and preserves connection errors", async (t) => {
    const stopped = new Error("fake TLS failure");
    let calls = 0;
    t.mock.method(tls, "connect", (options: tls.ConnectionOptions & { lookup: LookupFunction }) => {
      calls++;
      options.lookup("example.com", { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, PUBLIC);
      });
      throw stopped;
    });
    await assert.rejects(validatedFetch("https://example.com/api", {}, {
      lookup: fakeLookup(PUBLIC),
      mode: "test",
    }), (error: unknown) => error instanceof TypeError && error.cause === stopped);
    assert.equal(calls, 1);
  });

  test("overrides a supplied dispatcher and redirect policy while preserving streaming and signals", async (t) => {
    const controller = new AbortController();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const expected = new Response(new ReadableStream<Uint8Array>({
      start(value) { stream = value; },
    }));
    let closed = false;
    const response = await validatedFetch("https://example.com/api", {
      redirect: "follow",
      signal: controller.signal,
      method: "POST",
      body: "request",
      dispatcher: {} as RequestInit["dispatcher"],
    }, {
      lookup: fakeLookup(PUBLIC),
      fetchFn: async (_url, init) => {
        assert.equal(init?.redirect, "manual");
        assert.equal(init?.signal, controller.signal);
        assert.equal(init?.body, "request");
        assert.equal(init?.method, "POST");
        const dispatcher = (init as unknown as { dispatcher: Agent }).dispatcher;
        assert.ok(dispatcher instanceof Agent);
        t.mock.method(dispatcher, "close", async () => { closed = true; });
        t.mock.method(dispatcher, "destroy", async () => { assert.fail("must not destroy active response"); });
        return expected;
      },
    });
    assert.equal(response, expected);
    assert.equal(closed, true);
    stream.enqueue(new TextEncoder().encode("data: hello\n\n"));
    stream.close();
    assert.equal(await response.text(), "data: hello\n\n");
  });

  test("destroys the dispatcher on fetch failure and cancels redirect bodies", async (t) => {
    for (const redirect of [false, true]) {
      let destroyed = false;
      let cancelled = false;
      const failure = new Error("fake failure");
      await assert.rejects(validatedFetch("https://example.com", {}, {
        lookup: fakeLookup(PUBLIC),
        fetchFn: async (_url, init) => {
          const dispatcher = (init as unknown as { dispatcher: Agent }).dispatcher;
          t.mock.method(dispatcher, "destroy", async () => { destroyed = true; });
          if (!redirect) throw failure;
          return new Response(new ReadableStream({
            cancel() { cancelled = true; },
          }), { status: 302 });
        },
      }), (error: unknown) => redirect
        ? error instanceof SsrfValidationError && error.code === "REDIRECT_REFUSED"
        : error === failure);
      assert.equal(destroyed, true);
      assert.equal(cancelled, redirect);
    }
  });

  test("pins trusted hosts and handles IPv4 and IPv6 literals without DNS", async (t) => {
    for (const entry of [
      { url: "https://service.internal:8443/api", hostname: "service.internal", address: "10.0.0.5", family: 4 },
      { url: "https://1.1.1.1/api", hostname: "1.1.1.1", address: "1.1.1.1", family: 4 },
      { url: "https://[2606:4700:4700::1111]/api", hostname: "2606:4700:4700::1111", address: "2606:4700:4700::1111", family: 6 },
    ]) {
      const stopped = new Error("fake connection complete");
      const literal = entry.hostname === entry.address;
      let resolutions = 0;
      const mock = t.mock.method(tls, "connect", (options: tls.ConnectionOptions & { lookup: LookupFunction }) => {
        assert.equal(options.host, entry.hostname);
        assert.equal(options.servername, literal ? null : entry.hostname);
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.port, literal ? 443 : "8443");
        options.lookup(entry.hostname, { all: true }, (error, addresses) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [{ address: entry.address, family: entry.family }]);
        });
        options.lookup(entry.hostname, { family: entry.family === 4 ? 6 : 4 }, (error) => {
          assert.ok(error instanceof SsrfValidationError);
        });
        throw stopped;
      });
      await assert.rejects(validatedFetch(entry.url, {}, {
        mode: "test",
        trustedHosts: ["*.internal"],
        lookup: async () => {
          resolutions++;
          return [{ address: entry.address, family: entry.family }];
        },
      }), (error: unknown) => error instanceof TypeError && error.cause === stopped);
      assert.equal(resolutions, literal ? 0 : 1);
      mock.mock.restore();
    }
  });

  test("rejects empty or malformed DNS answers even for trusted hosts", async () => {
    for (const records of [[], [{ address: "not-an-ip", family: 4 }], [{ address: "1.1.1.1", family: 6 }]]) {
      await assert.rejects(validatedFetch("https://example.com", {}, {
        trustedHosts: ["example.com"],
        lookup: fakeLookup(records),
        fetchFn: async () => { assert.fail("must not fetch"); },
      }), (error: unknown) => error instanceof SsrfValidationError && error.code === "DNS_RESOLUTION_FAILED");
    }
  });

  test("returns the response for a valid public host", async () => {
    const spy = fetchSpy();
    const res = await validatedFetch(
      "https://example.com/api",
      {},
      { mode: "test", lookup: fakeLookup(PUBLIC), fetchFn: spy.fn as unknown as typeof fetch },
    );
    assert.equal(res.status, 200);
    assert.equal(spy.callCount, 1);
    assert.equal(spy.lastUrl, "https://example.com/api");
  });

  test("always requests redirect: manual (REDIRECT_POLICY)", async () => {
    const spy = fetchSpy();
    const res = await validatedFetch(
      "https://example.com/api",
      { headers: { accept: "application/json" } },
      { mode: "test", lookup: fakeLookup(PUBLIC), fetchFn: spy.fn as unknown as typeof fetch },
    );
    assert.equal(res.status, 200);
    assert.equal(spy.lastInit?.redirect, "manual");
    // Caller-supplied options (headers) are preserved.
    assert.deepEqual(spy.lastInit?.headers, { accept: "application/json" });
  });

  test("resolves and validates EVERY DNS record before connecting", async () => {
    const spy = fetchSpy();
    await validatedFetch(
      "https://example.com/api",
      {},
      {
        mode: "test",
        lookup: fakeLookup([
          { address: "1.1.1.1", family: 4 },
          { address: "2.2.2.2", family: 4 },
        ]),
        fetchFn: spy.fn as unknown as typeof fetch,
      },
    );
    assert.equal(spy.callCount, 1, "connect happens only after every record validated");
  });

  test("Fix 1: a 3xx redirect is refused (REDIRECT_REFUSED), never followed", async () => {
    const redirectFetch: typeof fetch = async (input, init) => {
      void input;
      void init;
      return new Response(null, { status: 302, headers: { location: "https://evil.internal/steal" } });
    };
    await assert.rejects(
      validatedFetch(
        "https://example.com/api",
        {},
        { mode: "test", lookup: fakeLookup(PUBLIC), fetchFn: redirectFetch },
      ),
      (e: unknown) =>
        e instanceof SsrfValidationError &&
        e.code === "REDIRECT_REFUSED" &&
        e.message.includes("example.com"),
    );
  });

  test("Fix 1: a URL resolving to a private IP aborts before connecting (fail-closed)", async () => {
    const spy = fetchSpy();
    await assert.rejects(
      validatedFetch(
        "https://public.example.com",
        {},
        {
          mode: "test",
          lookup: fakeLookup([{ address: "10.0.0.5", family: 4 }]),
          fetchFn: spy.fn as unknown as typeof fetch,
        },
      ),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );
    assert.equal(spy.callCount, 0, "fetch must never run when any record is disallowed");
  });

  test("a single disallowed record among public ones fails the whole call", async () => {
    await assert.rejects(
      validatedFetch(
        "https://mixed.example.com",
        {},
        {
          mode: "test",
          lookup: fakeLookup([
            { address: "1.1.1.1", family: 4 },
            { address: "169.254.169.254", family: 4 },
          ]),
          fetchFn: okFetch() as unknown as typeof fetch,
        },
      ),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );
  });

  test("Fix 1: http in production is refused before any DNS/fetch", async () => {
    const spy = fetchSpy();
    await assert.rejects(
      validatedFetch(
        "http://example.com",
        {},
        { mode: "production", lookup: fakeLookup(PUBLIC), fetchFn: spy.fn as unknown as typeof fetch },
      ),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
    );
    assert.equal(spy.callCount, 0);
  });

  test("Fix 2: allowHttp:true + production throws (fail-closed), even for https", async () => {
    const spy = fetchSpy();
    await assert.rejects(
      validatedFetch(
        "https://example.com",
        {},
        { mode: "production", allowHttp: true, fetchFn: spy.fn as unknown as typeof fetch },
      ),
      (e: unknown) =>
        e instanceof SsrfValidationError &&
        e.code === "UNSUPPORTED_SCHEME" &&
        e.message.includes("allowHttp"),
    );
    assert.equal(spy.callCount, 0);
  });

  test("Fix 2: allowHttp:true + development connects over http", async () => {
    const spy = fetchSpy();
    const res = await validatedFetch(
      "http://example.com",
      {},
      {
        mode: "development",
        allowHttp: true,
        lookup: fakeLookup(PUBLIC),
        fetchFn: spy.fn as unknown as typeof fetch,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(spy.callCount, 1);
    assert.equal(spy.lastUrl, "http://example.com");
  });

  test("trustedHosts allow an internal host to resolve privately and still connect", async () => {
    const spy = fetchSpy();
    const res = await validatedFetch(
      "https://vikunja.local/api",
      {},
      {
        mode: "test",
        trustedHosts: ["vikunja.local"],
        lookup: fakeLookup([{ address: "10.0.0.5", family: 4 }]),
        fetchFn: spy.fn as unknown as typeof fetch,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(spy.callCount, 1);
  });

  test("a private literal IP is refused statically (no DNS)", async () => {
    const spy = fetchSpy();
    await assert.rejects(
      validatedFetch(
        "https://10.0.0.5",
        {},
        { mode: "test", fetchFn: spy.fn as unknown as typeof fetch },
      ),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
    assert.equal(spy.callCount, 0);
  });

  test("lookup failure surfaces as DNS_RESOLUTION_FAILED and never connects", async () => {
    const spy = fetchSpy();
    const failing: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await assert.rejects(
      validatedFetch(
        "https://nxdomain.example",
        {},
        { mode: "test", lookup: failing, fetchFn: spy.fn as unknown as typeof fetch },
      ),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_RESOLUTION_FAILED",
    );
    assert.equal(spy.callCount, 0);
  });
});