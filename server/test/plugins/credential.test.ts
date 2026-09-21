import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PluginCredentialError,
  credentialFingerprint,
  extractCredentialsFromBody,
  validateCredentials,
} from "../../src/plugins/credential.ts";
import type { CredentialSpec } from "../../src/plugins/types.ts";

const requiredSpec: CredentialSpec = {
  apiKey: { label: "API key", required: true },
};

const optionalSpec: CredentialSpec = {
  apiKey: { label: "API key", required: false },
};

describe("validateCredentials", () => {
  test("no spec means no credentials are needed and nothing is echoed", () => {
    assert.deepEqual(validateCredentials(undefined, {}, "p"), {});
    assert.deepEqual(validateCredentials(undefined, { apiKey: "sk-x" }, "p"), {});
  });

  test("required apiKey present → valid, trimmed, only spec fields echoed", () => {
    const out = validateCredentials(
      requiredSpec,
      { apiKey: "  sk-abc  ", other: "who-am-i" },
      "p",
    );
    assert.deepEqual(out, { apiKey: "sk-abc" });
  });

  test("required apiKey missing → MISSING_CREDENTIAL with the pluginId", () => {
    assert.throws(
      () => validateCredentials(requiredSpec, {}, "vikunja"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "MISSING_CREDENTIAL" &&
        e.pluginId === "vikunja",
    );
  });

  test("whitespace-only value counts as MISSING", () => {
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "   \t " }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError && e.code === "MISSING_CREDENTIAL",
    );
  });

  test("apiKey with internal whitespace/newlines → INVALID_CREDENTIAL_FORMAT", () => {
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "sk-1 2" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "sk-1\n2" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
  });

  test("Fix 8: C0 control chars and DEL are rejected as key material", () => {
    // NUL, SOH, and DEL pass .trim() unharmed but must be rejected — they can
    // smuggle header/log injection or break line-based parsers.
    for (const value of ["sk-\x00x", "sk-\x01x", "sk-\x1fx", "sk\x7fx"]) {
      assert.throws(
        () => validateCredentials(requiredSpec, { apiKey: value }, "p"),
        (e: unknown) =>
          e instanceof PluginCredentialError &&
          e.code === "INVALID_CREDENTIAL_FORMAT",
        `value containing ${JSON.stringify(value)} must be rejected`,
      );
    }
    // Tabs and bare CR are also covered (previously \s-only).
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "sk-\tx" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "sk-\rx" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
  });

  test("Fix 8: control-char rejection applies to a normal value too (no false negatives)", () => {
    const out = validateCredentials(requiredSpec, { apiKey: "sk-0a1B-cd" }, "p");
    assert.deepEqual(out, { apiKey: "sk-0a1B-cd" });
    // A value with an internal space is still rejected (existing contract).
    assert.throws(
      () => validateCredentials(requiredSpec, { apiKey: "sk-1 2" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
  });

  test("unknown input fields are dropped without error", () => {
    const out = validateCredentials(
      requiredSpec,
      { apiKey: "sk-a", extra: "x", nested: "y" },
      "p",
    );
    assert.deepEqual(out, { apiKey: "sk-a" });
  });

  test("model plugin passes baseUrlEntry through as a routing field", () => {
    const out = validateCredentials(
      requiredSpec,
      { apiKey: "sk-a", baseUrlEntry: "us-east" },
      "p",
      { isModel: true },
    );
    assert.deepEqual(out, { apiKey: "sk-a", baseUrlEntry: "us-east" });
  });

  test("model plugin with blank baseUrlEntry drops it (treated as absent)", () => {
    assert.deepEqual(
      validateCredentials(requiredSpec, { apiKey: "sk-a", baseUrlEntry: "   " }, "p", { isModel: true }),
      { apiKey: "sk-a" },
    );
    assert.deepEqual(
      validateCredentials(requiredSpec, { apiKey: "sk-a", baseUrlEntry: "" }, "p", { isModel: true }),
      { apiKey: "sk-a" },
    );
  });

  test("non-model plugin still drops baseUrlEntry", () => {
    const out = validateCredentials(
      requiredSpec,
      { apiKey: "sk-a", baseUrlEntry: "us-east" },
      "p",
    );
    assert.deepEqual(out, { apiKey: "sk-a" });
  });

  test("optional field absent is fine; present is trimmed", () => {
    assert.deepEqual(validateCredentials(optionalSpec, {}, "p"), {});
    assert.deepEqual(
      validateCredentials(optionalSpec, { apiKey: "  sk-o  " }, "p"),
      { apiKey: "sk-o" },
    );
    assert.deepEqual(validateCredentials(optionalSpec, { apiKey: "  " }, "p"), {});
  });

  test("optional apiKey that is present but malformed is still rejected", () => {
    assert.throws(
      () => validateCredentials(optionalSpec, { apiKey: "sk a" }, "p"),
      (e: unknown) =>
        e instanceof PluginCredentialError &&
        e.code === "INVALID_CREDENTIAL_FORMAT",
    );
  });

  test("input object is not mutated", () => {
    const input: Record<string, string | undefined> = {
      apiKey: "  sk-abc  ",
      other: "dropped",
    };
    const snapshot = { ...input };
    validateCredentials(requiredSpec, input, "p");
    assert.deepEqual(input, snapshot);
  });
});

describe("extractCredentialsFromBody", () => {
  test("pulls the nested per-plugin credentials object", () => {
    const body = {
      plugin: "mealie",
      credentials: { mealie: { apiKey: "sk-1" } },
    };
    const out = extractCredentialsFromBody(body, "mealie", requiredSpec);
    assert.deepEqual(out, { apiKey: "sk-1" });
  });

  test("non-object body or credentials field → empty input", () => {
    assert.deepEqual(extractCredentialsFromBody(undefined, "m", requiredSpec), {});
    assert.deepEqual(extractCredentialsFromBody("nope", "m", requiredSpec), {});
    assert.deepEqual(extractCredentialsFromBody([], "m", requiredSpec), {});
    assert.deepEqual(extractCredentialsFromBody({ credentials: "nope" }, "m", requiredSpec), {});
    assert.deepEqual(extractCredentialsFromBody({ credentials: 42 }, "m", requiredSpec), {});
  });

  test("non-object per-plugin entry → empty input", () => {
    assert.deepEqual(
      extractCredentialsFromBody({ credentials: { m: "sk-1" } }, "m", requiredSpec),
      {},
    );
    assert.deepEqual(
      extractCredentialsFromBody({ credentials: { m: [1, 2] } }, "m", requiredSpec),
      {},
    );
  });

  test("drops non-string values", () => {
    const body = {
      credentials: { m: { apiKey: "sk-1", count: 3, flag: true, arr: [1] } },
    };
    assert.deepEqual(extractCredentialsFromBody(body, "m", requiredSpec), {
      apiKey: "sk-1",
    });
  });

  test("leaves other plugins' credentials alone", () => {
    const body = {
      credentials: {
        mealie: { apiKey: "sk-m" },
        vikunja: { apiKey: "sk-v" },
      },
    };
    assert.deepEqual(extractCredentialsFromBody(body, "mealie", requiredSpec), {
      apiKey: "sk-m",
    });
  });

  test("spec-scoped extraction drops references the spec does not define", () => {
    const body = {
      credentials: { m: { apiKey: "sk-1", futureField: "sneaky" } },
    };
    assert.deepEqual(extractCredentialsFromBody(body, "m", requiredSpec), {
      apiKey: "sk-1",
    });
  });

  test("model plugin passes baseUrlEntry through extraction (routing field)", () => {
    const body = {
      credentials: { m: { apiKey: "sk-1", baseUrlEntry: "us-east", other: "x" } },
    };
    assert.deepEqual(
      extractCredentialsFromBody(body, "m", requiredSpec, { isModel: true }),
      { apiKey: "sk-1", baseUrlEntry: "us-east" },
    );
  });

  test("tool plugin keeps dropping baseUrlEntry at extraction", () => {
    const body = {
      credentials: { m: { apiKey: "sk-1", baseUrlEntry: "us-east" } },
    };
    assert.deepEqual(extractCredentialsFromBody(body, "m", requiredSpec), {
      apiKey: "sk-1",
    });
  });

  test("without a spec extraction returns every string value (validation decides)", () => {
    const body = { credentials: { m: { apiKey: "sk-1", token: "t" } } };
    assert.deepEqual(extractCredentialsFromBody(body, "m"), {
      apiKey: "sk-1",
      token: "t",
    });
  });
});

describe("credentialFingerprint", () => {
  test("is stable regardless of key order", () => {
    assert.equal(
      credentialFingerprint({ a: "x", b: "y", c: "z" }),
      credentialFingerprint({ c: "z", a: "x", b: "y" }),
    );
  });

  test("differs when values differ", () => {
    assert.notEqual(
      credentialFingerprint({ apiKey: "sk-one" }),
      credentialFingerprint({ apiKey: "sk-two" }),
    );
  });

  test("is the deterministic sha256 hex over sorted key=value pairs", () => {
    const expected = createHash("sha256")
      .update("apiKey=sk-a|b=c", "utf8")
      .digest("hex");
    assert.equal(credentialFingerprint({ b: "c", apiKey: "sk-a" }), expected);
    // deterministic: same input, same digest
    assert.equal(
      credentialFingerprint({ b: "c", apiKey: "sk-a" }),
      credentialFingerprint({ b: "c", apiKey: "sk-a" }),
    );
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  test("empty credentials still produce a fingerprint", () => {
    assert.equal(typeof credentialFingerprint({}), "string");
    assert.equal(credentialFingerprint({}), credentialFingerprint({}));
  });
});