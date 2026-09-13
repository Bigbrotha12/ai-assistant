import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
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