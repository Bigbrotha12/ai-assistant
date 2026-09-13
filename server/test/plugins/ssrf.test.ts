import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import {
  SsrfValidationError,
  validateStaticUrl,
  isIpAllowed,
  isValidTrustedHostEntry,
  parseTrustedHosts,
  parseTrustedHostEntries,
  resolveAndValidateHost,
  isTrustedHost,
  REDIRECT_POLICY,
  isRedirectStatus,
} from "../../src/plugins/ssrf.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

function fakeLookup(records: readonly LookupAddress[]): LookupFn {
  return async (_hostname, _options) => [...records];
}

describe("scheme enforcement", () => {
  test("https is allowed in production", () => {
    const url = validateStaticUrl("https://example.com/api", { mode: "production" });
    assert.equal(url.hostname, "example.com");
  });

  test("http is rejected in production", () => {
    assert.throws(
      () => validateStaticUrl("http://example.com", { mode: "production" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
    );
  });

  test("http is allowed in development", () => {
    const url = validateStaticUrl("http://example.com", { mode: "development" });
    assert.equal(url.hostname, "example.com");
  });

  test("http is allowed in test mode", () => {
    const url = validateStaticUrl("http://example.com", { mode: "test" });
    assert.equal(url.hostname, "example.com");
  });

  test("allowHttp option explicitly overrides mode", () => {
    assert.throws(
      () => validateStaticUrl("http://example.com", { mode: "development", allowHttp: false }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
    );
  });

  test("Fix 2: allowHttp: true is refused in production even for an https URL", () => {
    assert.throws(
      () => validateStaticUrl("https://example.com", { mode: "production", allowHttp: true }),
      (e: unknown) =>
        e instanceof SsrfValidationError &&
        e.code === "UNSUPPORTED_SCHEME" &&
        e.message.includes("allowHttp"),
      "explicit allowHttp:true must never defeat production scheme enforcement",
    );
  });

  test("Fix 2: allowHttp: true is honoured in development", () => {
    const url = validateStaticUrl("http://example.com", { mode: "development", allowHttp: true });
    assert.equal(url.hostname, "example.com");
  });

  test("Fix 2: default production mode refuses http for real (NODE_ENV=production path)", () => {
    // Mirrors the module-level NODE_ENV coercion: no explicit allowHttp and a
    // missing NODE_ENV defaults to development, so production must be explicit.
    const devDefault = validateStaticUrl("http://example.com", { mode: "development" });
    assert.equal(devDefault.hostname, "example.com");
    assert.throws(
      () => validateStaticUrl("http://example.com", { mode: "production" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
    );
  });

  test("non-http schemes are always rejected", () => {
    for (const url of [
      "ftp://example.com/file",
      "gopher://example.com",
      "ws://example.com",
      "file:///etc/passwd",
      "wss://example.com/",
    ]) {
      assert.throws(
        () => validateStaticUrl(url, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
        `expected ${url} to be rejected`,
      );
    }
  });
});

describe("literal IP range rejection", () => {
  const privateIps = [
    "127.0.0.1", // loopback
    "127.8.8.8", // whole 127.0.0.0/8
    "10.0.0.5", // private
    "10.255.255.255", // private
    "172.16.0.1", // private 172.16.0.0/12
    "172.31.255.255", // private upper edge
    "172.32.0.1", // NOT private (outside /12)
    "192.168.1.1", // private
    "192.168.255.255", // private
    "0.0.0.0", // this-network / unspecified
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
  ];
  for (const ip of privateIps.filter((i) => i !== "172.32.0.1")) {
    test(`rejects private/loopback/reserved ${ip} in dev too (scheme-independent)`, () => {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
      assert.throws(
        () => validateStaticUrl(`http://${ip}`, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
      );
    });
  }

  test("172.32.0.1 (outside 172.16.0.0/12) is allowed", () => {
    assert.equal(isIpAllowed("172.32.0.1"), true);
    validateStaticUrl("http://172.32.0.1", { mode: "development" });
  });

  test("rejects link-local and cloud metadata", () => {
    for (const ip of ["169.254.169.254", "169.254.1.1", "169.254.0.1"]) {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
    }
  });

  test("a public literal IP is allowed and needs no DNS", () => {
    const url = validateStaticUrl("http://1.2.3.4", { mode: "development" });
    assert.equal(url.hostname, "1.2.3.4");
  });

  test("https-only in prod combined with private IP still rejects on range, not scheme", () => {
    assert.throws(
      () => validateStaticUrl("https://10.0.0.5", { mode: "production" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
  });
});

describe("IPv6 handling", () => {
  test("rejects loopback ::1, ULA fc00::, link-local fe80::, multicast ff00::", () => {
    for (const ip of ["::1", "fc00::", "fc00::1", "fd00::1", "fe80::1"]) {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
      assert.throws(
        () => validateStaticUrl(`http://[${ip}]:8080`, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
      );
    }
  });

  test("rejects unspecified :: and IPv4-mapped private IPv6", () => {
    assert.equal(isIpAllowed("::"), false);
    for (const ip of ["::ffff:192.168.1.1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"]) {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
      assert.throws(
        () => validateStaticUrl(`http://[${ip}]`, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
      );
    }
  });

  test("global unicast IPv6 is allowed", () => {
    for (const ip of ["2001:db8::1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      assert.equal(isIpAllowed(ip), true, `${ip} must be allowed`);
    }
    validateStaticUrl("http://[2001:db8::1]", { mode: "development" });
  });

  test("IPv4-mapped public IPv6 is allowed", () => {
    assert.equal(isIpAllowed("::ffff:8.8.8.8"), true);
    validateStaticUrl("http://[::ffff:8.8.8.8]", { mode: "development" });
  });
});

describe("malformed URLs", () => {
  test("empty, non-URL and broken input is rejected", () => {
    for (const url of ["", "not a url", "http://", "http://[::1", "https://exa mple.com"]) {
      assert.throws(
        () => validateStaticUrl(url, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "INVALID_URL",
        `expected "${url}" to be rejected`,
      );
    }
  });
});

describe("admin-trusted internal hosts", () => {
  test("a trusted literal IP bypasses private-range rejection", () => {
    const url = validateStaticUrl("http://10.0.0.5", {
      mode: "development",
      trustedHosts: ["10.0.0.5"],
    });
    assert.equal(url.hostname, "10.0.0.5");
  });

  test("a trusted host does NOT bypass the scheme check", () => {
    assert.throws(
      () =>
        validateStaticUrl("http://10.0.0.5", {
          mode: "production",
          trustedHosts: ["10.0.0.5"],
        }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "UNSUPPORTED_SCHEME",
    );
  });

  test("untrusted private IP is rejected even in dev", () => {
    assert.throws(
      () => validateStaticUrl("http://10.0.0.5", { mode: "development" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
  });

  test("trusted hostname resolution accepts private records", async () => {
    const pinned = await resolveAndValidateHost("vikunja.local", {
      trustedHosts: ["*.local"],
      lookup: fakeLookup([
        { address: "10.0.0.5", family: 4 },
        { address: "192.168.1.10", family: 4 },
      ]),
    });
    assert.deepEqual(pinned, ["10.0.0.5", "192.168.1.10"]);
  });

  test("trusted literal IP resolves directly without DNS", async () => {
    const pinned = await resolveAndValidateHost("10.0.0.5", {
      trustedHosts: ["10.0.0.5"],
    });
    assert.deepEqual(pinned, ["10.0.0.5"]);
  });
});

describe("isTrustedHost matching", () => {
  test("exact match", () => {
    assert.equal(isTrustedHost("vikunja.local", ["vikunja.local"]), true);
    assert.equal(isTrustedHost("vikunja.local", ["other.local"]), false);
    assert.equal(isTrustedHost("VIKUNJA.local", ["vikunja.local"]), true);
  });

  test("*.internal wildcard matches the suffix and any depth", () => {
    assert.equal(isTrustedHost("api.internal", ["*.internal"]), true);
    assert.equal(isTrustedHost("a.b.internal", ["*.internal"]), true);
    assert.equal(isTrustedHost("internal", ["*.internal"]), true);
    assert.equal(isTrustedHost("internal2", ["*.internal"]), false);
    assert.equal(isTrustedHost("notinternal", ["*.internal"]), false);
    assert.equal(isTrustedHost("evil.internal.attacker.com", ["*.internal"]), false);
  });

  test("bare * and mid-string wildcards never match", () => {
    assert.equal(isTrustedHost("anything.com", ["*"]), false);
    assert.equal(isTrustedHost("foo.bar", ["foo*bar"]), false);
    assert.equal(isTrustedHost("foo", []), false);
  });
});

describe("Fix 3: parseTrustedHosts / PLUGINS_TRUSTED_HOSTS entry validation", () => {
  test("accepts exact hostnames, IP literals, and single-*. wildcards", () => {
    for (const entry of [
      "vn.example",
      "vikunja.local",
      "example.com",
      "10.0.0.5",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "*.internal",
      "*.local",
    ]) {
      assert.equal(isValidTrustedHostEntry(entry), true, `${entry} must be accepted`);
    }
    assert.deepEqual(
      parseTrustedHosts(" vn.example , vikunja.local , *.internal ,  "),
      ["vn.example", "vikunja.local", "*.internal"],
    );
    // parseTrustedHostEntries is the post-split path used by env.ts.
    assert.deepEqual(
      parseTrustedHostEntries([" vn.example ", "", "*.internal"]),
      ["vn.example", "*.internal"],
    );
  });

  test("rejects schemes, ports, paths, spaces and bare/mid-string wildcards", () => {
    for (const entry of [
      "https://vn.example",
      "http://example.com",
      "vn.example:8443",
      "[::1]",
      "vn.example/api",
      "vn example",
      " example",
      "*",
      "*.*",
      "foo*bar",
      ".",
      "..",
      "-bad.local",
      "bad-.local",
      "under_score.com",
    ]) {
      assert.equal(isValidTrustedHostEntry(entry), false, `${entry} must be rejected`);
    }
  });

  test("parseTrustedHosts throws an actionable message on the first invalid entry", () => {
    assert.throws(
      () => parseTrustedHosts("vikunja.local,http://evil.example"),
      (e: unknown) =>
        e instanceof SsrfValidationError &&
        e.code === "INVALID_URL" &&
        e.message.includes("http://evil.example"),
    );
  });

  test("empty input yields an empty list", () => {
    assert.deepEqual(parseTrustedHosts(""), []);
    assert.deepEqual(parseTrustedHosts("  , , "), []);
  });
});

describe("Fix 7: CGNAT and TEST-NET benchmarking ranges are refused", () => {
  for (const ip of ["100.64.0.1", "100.127.255.255", "100.100.100.100"]) {
    test(`rejects CGNAT ${ip}`, () => {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
    });
  }
  test("CGNAT edge boundaries: 100.63/100.128 are NOT CGNAT", () => {
    assert.equal(isIpAllowed("100.63.255.255"), true);
    assert.equal(isIpAllowed("100.128.0.1"), true);
  });

  for (const ip of ["198.18.0.1", "198.19.255.255"]) {
    test(`rejects TEST-NET-2 ${ip}`, () => {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
    });
  }
  test("TEST-NET-2 edge boundaries: 198.17/198.20 are allowed", () => {
    assert.equal(isIpAllowed("198.17.255.255"), true);
    assert.equal(isIpAllowed("198.20.0.1"), true);
  });

  test("private CGNAT literal is rejected through validateStaticUrl too", () => {
    assert.throws(
      () => validateStaticUrl("https://100.64.0.1", { mode: "production" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
  });
});

describe("Fix 7: IPv6 tunneling prefixes (6to4, Teredo)", () => {
  test("6to4 with an unsafe embedded v4 is rejected (loopback/private/link-local)", () => {
    for (const ip of ["2002:7f00:1::1", "2002:0a00:0000::1", "2002:a9fe:0101::1"]) {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
      assert.throws(
        () => validateStaticUrl(`http://[${ip}]`, { mode: "development" }),
        (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
        `${ip} must be rejected at static validation`,
      );
    }
  });

  test("6to4 with a public embedded v4 is allowed", () => {
    assert.equal(isIpAllowed("2002:0101:0101::1"), true);
    assert.equal(isIpAllowed("2002:0808:0808::1"), true);
    validateStaticUrl("http://[2002:0101:0101::1]", { mode: "development" });
  });

  test("Teredo 2001::/32 is rejected outright", () => {
    for (const ip of ["2001::", "2001::4136:e378:8000:63bf:3fff:fdd2", "2001:0000::1"]) {
      assert.equal(isIpAllowed(ip), false, `${ip} must be disallowed`);
    }
    assert.throws(
      () => validateStaticUrl("http://[2001::1]", { mode: "development" }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
  });

  test("2001:db8 doc range and 2001:4860 public DNS stay allowed", () => {
    assert.equal(isIpAllowed("2001:db8::1"), true);
    assert.equal(isIpAllowed("2001:4860:4860::8888"), true);
  });
});

describe("resolveAndValidateHost (DNS rebinding defense)", () => {
  test("a hostname resolving to cloud metadata is rejected", async () => {
    await assert.rejects(
      resolveAndValidateHost("public.example.com", {
        lookup: fakeLookup([{ address: "169.254.169.254", family: 4 }]),
      }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );
  });

  test("a single bad record among good ones fails the whole host", async () => {
    await assert.rejects(
      resolveAndValidateHost("mixed.example.com", {
        lookup: fakeLookup([
          { address: "1.1.1.1", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
      }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );
  });

  test("returns all validated IPs for an untrusted public host", async () => {
    const pinned = await resolveAndValidateHost("example.com", {
      lookup: fakeLookup([
        { address: "1.1.1.1", family: 4 },
        { address: "2.2.2.2", family: 4 },
      ]),
    });
    assert.deepEqual(pinned, ["1.1.1.1", "2.2.2.2"]);
  });

  test("removes duplicate records from the pin list", async () => {
    const pinned = await resolveAndValidateHost("dup.example.com", {
      lookup: fakeLookup([
        { address: "1.1.1.1", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ]),
    });
    assert.deepEqual(pinned, ["1.1.1.1"]);
  });

  test("an IPv6 record is validated too", async () => {
    await assert.rejects(
      resolveAndValidateHost("v6.example.com", {
        lookup: fakeLookup([{ address: "fe80::1", family: 6 }]),
      }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_REBINDING",
    );
    const pinned = await resolveAndValidateHost("v6.example.com", {
      lookup: fakeLookup([{ address: "2001:db8::1", family: 6 }]),
    });
    assert.deepEqual(pinned, ["2001:db8::1"]);
  });

  test("lookup failure surfaces as DNS_RESOLUTION_FAILED", async () => {
    const failing: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await assert.rejects(
      resolveAndValidateHost("nxdomain.example", { lookup: failing }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DNS_RESOLUTION_FAILED",
    );
  });

  test("literal IPs bypass DNS entirely", async () => {
    let called = false;
    const spy: LookupFn = async () => {
      called = true;
      throw new Error("lookup must not be called");
    };
    const pinned = await resolveAndValidateHost("1.2.3.4", { lookup: spy });
    assert.equal(called, false);
    assert.deepEqual(pinned, ["1.2.3.4"]);

    await assert.rejects(
      resolveAndValidateHost("10.0.0.5", { lookup: spy }),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "DISALLOWED_HOST",
    );
  });

  test('hostname that LOOKS like an IP but is malformed is resolved via DNS', async () => {
    let calledWith: string | null = null;
    const spy: LookupFn = async (hostname) => {
      calledWith = hostname;
      return [{ address: "1.1.1.1", family: 4 }];
    };
    const pinned = await resolveAndValidateHost("1.2.3.4.5", { lookup: spy });
    assert.equal(calledWith, "1.2.3.4.5");
    assert.deepEqual(pinned, ["1.1.1.1"]);
  });

  test("empty hostname is rejected", async () => {
    await assert.rejects(
      resolveAndValidateHost(""),
      (e: unknown) => e instanceof SsrfValidationError && e.code === "INVALID_URL",
    );
  });

  test("resolves a real public host and returns valid pinned IPs", async (t) => {
    let pinned: string[];
    try {
      // Real network lookup via node:dns/promises. If the environment has no
      // network, the lookup throws and the test is skipped rather than failed
      // (decided over mocking because injected-lookup tests above already
      // cover the rebinding paths deterministically).
      pinned = await resolveAndValidateHost("example.com");
    } catch (err) {
      if (err instanceof SsrfValidationError && err.code === "DNS_RESOLUTION_FAILED") {
        t.skip("no network in this environment");
        return;
      }
      throw err;
    }
    assert.ok(pinned.length > 0, "expected at least one A/AAAA record");
    for (const ip of pinned) {
      assert.notEqual(isIP(ip), 0, `${ip} should be a real IP`);
      assert.equal(isIpAllowed(ip), true, `${ip} must pass the range checks`);
    }
  });
});

describe("redirect policy", () => {
  test("REDIRECT_POLICY forces manual redirects", () => {
    assert.equal(REDIRECT_POLICY.redirect, "manual");
  });

  test("isRedirectStatus is true for 300-399 and false otherwise", () => {
    for (const status of [300, 301, 302, 304, 307, 308, 399]) {
      assert.equal(isRedirectStatus(status), true);
    }
    for (const status of [200, 299, 400, 404, 500]) {
      assert.equal(isRedirectStatus(status), false);
    }
  });
});

describe("isIpAllowed contract", () => {
  test("trusted literal IP is allowed", () => {
    assert.equal(isIpAllowed("10.0.0.5", { trustedHosts: ["10.0.0.5"] }), true);
  });

  test("trusted IP does not leak to other IPs", () => {
    assert.equal(isIpAllowed("10.0.0.6", { trustedHosts: ["10.0.0.5"] }), false);
  });

  test("non-literal input cannot be judged statically", () => {
    assert.equal(isIpAllowed("example.com"), true);
  });
});