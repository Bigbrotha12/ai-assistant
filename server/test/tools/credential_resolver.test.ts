import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RequestBodyCredentialResolver,
} from "../../src/credentials/request_body.ts";
import {
  PinStoreCredentialResolver,
} from "../../src/credentials/pin_store.ts";
import {
  CredentialPinError,
  CredentialPinStore,
} from "../../src/credentials/pins.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";
import { JobError } from "../../src/jobs/errors.ts";

/**
 * Phase 3.2/3.3 provider tests (plan §8: "each resolver independently").
 *
 * These pin the two behaviours the inline branches had before the seam:
 *   - request-body: missing → `undefined`, same `credentialFingerprint`
 *     derivation the sync channel used inline;
 *   - pin-store: handle-addressed reads, the `credentials_expired` throw, the
 *     dispatch assertion before every read, and the pin's precomputed
 *     fingerprint (never re-derived).
 */

describe("RequestBodyCredentialResolver", () => {
  test("tool hit returns the request's credential object and its sync fingerprint", () => {
    const credentials = { apiKey: "tok-abc" };
    const resolver = new RequestBodyCredentialResolver({
      toolCredentialsByPlugin: { vikunja: credentials },
    });
    const resolved = resolver.resolve({
      owner: "user-1",
      pluginId: "vikunja",
      kind: "tool",
      channel: "sync",
    });
    assert.equal(resolver.name, "request-body");
    assert.equal(resolved?.credentials, credentials, "same object, no copy");
    assert.equal(resolved?.fingerprint, credentialFingerprint(credentials));
  });

  test("a tool plugin absent from the request map resolves to undefined (not {})", () => {
    const resolver = new RequestBodyCredentialResolver({
      toolCredentialsByPlugin: {},
    });
    assert.equal(
      resolver.resolve({ pluginId: "vikunja", kind: "tool", channel: "sync" }),
      undefined,
    );
  });

  test("model kind resolves the selected model plugin's request-body credentials", () => {
    const modelCredentials = { apiKey: "sk-model", baseUrlEntry: "alt" };
    const resolver = new RequestBodyCredentialResolver({
      toolCredentialsByPlugin: {},
      model: { pluginId: "openrouter", credentials: modelCredentials },
    });
    const resolved = resolver.resolve({
      pluginId: "openrouter",
      kind: "model",
      channel: "sync",
    });
    assert.equal(resolved?.credentials, modelCredentials);
    assert.equal(resolved?.fingerprint, credentialFingerprint(modelCredentials));
    assert.equal(
      resolver.resolve({ pluginId: "other", kind: "model", channel: "sync" }),
      undefined,
      "a different model plugin is not this resolver's",
    );
  });

  test("with no model context, model kind resolves to undefined", () => {
    const resolver = new RequestBodyCredentialResolver({
      toolCredentialsByPlugin: { vikunja: { apiKey: "tok" } },
    });
    assert.equal(
      resolver.resolve({ pluginId: "openrouter", kind: "model", channel: "sync" }),
      undefined,
    );
  });
});

describe("PinStoreCredentialResolver", () => {
  test("reads the handle-addressed pin and returns its precomputed fingerprint", () => {
    const pins = new CredentialPinStore();
    const pinned = pins.pin("user-1", "vikunja", { apiKey: "tok-mine" });
    const resolver = new PinStoreCredentialResolver({
      pins,
      owner: "user-1",
      pinHandles: { vikunja: pinned.handle },
      assertActive: () => {},
    });
    const resolved = resolver.resolve({
      owner: "user-1",
      pluginId: "vikunja",
      kind: "tool",
      channel: "job",
    });
    assert.equal(resolver.name, "pin-store");
    assert.deepEqual(resolved?.credentials, { apiKey: "tok-mine" });
    assert.equal(resolved?.fingerprint, pinned.fingerprint);
  });

  test("a plugin with no admitted handle throws credentials_expired", () => {
    const pins = new CredentialPinStore();
    const resolver = new PinStoreCredentialResolver({
      pins,
      owner: "user-1",
      pinHandles: {},
      assertActive: () => {},
    });
    assert.throws(
      () =>
        resolver.resolve({
          owner: "user-1",
          pluginId: "vikunja",
          kind: "tool",
          channel: "job",
        }),
      (e: unknown) =>
        e instanceof JobError &&
        e.code === "credentials_expired" &&
        /no admitted credential pin for plugin 'vikunja'/.test(e.message),
    );
  });

  test("assertActive runs before the read and an expired pin surfaces as credentials_expired", () => {
    let now = 1_000_000;
    const pins = new CredentialPinStore({ maxLifetimeMs: 1000, now: () => now });
    const pinned = pins.pin("user-1", "vikunja", { apiKey: "tok" });
    const calls: string[] = [];
    const resolver = new PinStoreCredentialResolver({
      pins,
      owner: "user-1",
      pinHandles: { vikunja: pinned.handle },
      assertActive: () => calls.push("assert"),
    });
    now += 2000;
    assert.throws(
      () =>
        resolver.resolve({
          owner: "user-1",
          pluginId: "vikunja",
          kind: "tool",
          channel: "job",
        }),
      (e: unknown) => e instanceof CredentialPinError && e.code === "credentials_expired",
    );
    assert.deepEqual(calls, ["assert"], "the fence guard ran before the read");
  });
});
