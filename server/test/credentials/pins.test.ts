import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CredentialPinError,
  CredentialPinStore,
  DEFAULT_PIN_MAX_LIFETIME_MS,
} from "../../src/credentials/pins.ts";
import { credentialFingerprint } from "../../src/plugins/credential.ts";

/**
 * A store with a deterministic, injectable clock so lifetime/expiry behavior
 * is exercised without waiting on real time.
 */
function makeStore(opts: { maxLifetimeMs?: number } = {}) {
  let now = 1_000_000;
  const store = new CredentialPinStore({
    maxLifetimeMs: opts.maxLifetimeMs ?? 900_000,
    now: () => now,
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
    current: () => now,
  };
}

function isExpired(e: unknown): boolean {
  return e instanceof CredentialPinError && e.code === "credentials_expired";
}

function isNotFound(e: unknown): boolean {
  return e instanceof CredentialPinError && e.code === "pin_not_found";
}

describe("credential pin store", () => {
  test("pin -> get returns the same validated credentials, fingerprint and lifetime", () => {
    const { store } = makeStore();
    const pin = store.pin("user-1", "vikunja", { apiKey: "tok-abc" });
    assert.equal(pin.pluginId, "vikunja");
    assert.deepEqual(pin.credentials, { apiKey: "tok-abc" });
    assert.equal(pin.fingerprint, credentialFingerprint({ apiKey: "tok-abc" }));
    assert.equal(pin.issuedAt, 1_000_000);
    assert.equal(pin.expiresAt, 1_000_000 + 900_000);

    const got = store.get("user-1", "vikunja");
    assert.deepEqual(got.credentials, { apiKey: "tok-abc" });
    assert.equal(got.fingerprint, pin.fingerprint);
    assert.equal(got.expiresAt, pin.expiresAt);
  });

  test("the default max lifetime is 15 minutes", () => {
    assert.equal(DEFAULT_PIN_MAX_LIFETIME_MS, 15 * 60 * 1000);
    const store = new CredentialPinStore();
    const pin = store.pin("u", "p", { apiKey: "k" });
    assert.equal(pin.expiresAt - pin.issuedAt, 15 * 60 * 1000);
  });

  test("refresh re-checks liveness but NEVER extends expiresAt (absolute cap)", () => {
    const { store, advance } = makeStore();
    store.pin("user-1", "mealie", { apiKey: "tok-x" });
    const before = store.get("user-1", "mealie");

    advance(300_000); // 5 min in
    const after = store.refresh("user-1", "mealie");
    assert.equal(after.expiresAt, before.expiresAt, "refresh must not extend the cap");
    assert.equal(after.issuedAt, before.issuedAt);

    // Still alive at 14:59 (just before the 15:00 cap) despite many refreshes.
    advance(599_999);
    const near = store.refresh("user-1", "mealie");
    assert.equal(near.expiresAt, before.expiresAt);
  });

  test("an expired pin fails with credentials_expired on get AND refresh", () => {
    // get past the cap
    {
      const { store, advance } = makeStore();
      store.pin("user-1", "vikunja", { apiKey: "tok-abc" });
      advance(900_001); // 1ms past the 15 min cap
      assert.throws(() => store.get("user-1", "vikunja"), isExpired);
      assert.throws(
        () => store.get("user-1", "vikunja"),
        isNotFound,
        "a failed get drops the expired pin, so a re-read is a clean miss",
      );
    }
    // refresh past the cap
    {
      const { store, advance } = makeStore();
      store.pin("user-1", "vikunja", { apiKey: "tok-abc" });
      advance(900_001);
      assert.throws(() => store.refresh("user-1", "vikunja"), isExpired);
    }
  });

  test("sweep removes only expired pins and returns the count", () => {
    const { store, advance } = makeStore();
    store.pin("user-1", "old", { apiKey: "a" });
    advance(600_000); // old pin has 5 min left
    store.pin("user-1", "new", { apiKey: "b" });
    advance(301_000); // old (15 min cap) now expired; new still has ~9 min

    assert.equal(store.sweep(), 1);
    assert.equal(store.get("user-1", "new").pluginId, "new", "live pin survives");
    assert.throws(
      () => store.get("user-1", "old"),
      isNotFound,
      "swept pin is a clean miss",
    );
  });

  test("sweep is idempotent (second pass finds nothing to remove)", () => {
    const { store, advance } = makeStore();
    store.pin("user-1", "old", { apiKey: "a" });
    advance(900_001);
    assert.equal(store.sweep(), 1);
    assert.equal(store.sweep(), 0);
  });

  test("release drops the pin", () => {
    const { store } = makeStore();
    store.pin("user-1", "vikunja", { apiKey: "tok" });
    store.release("user-1", "vikunja");
    assert.throws(() => store.get("user-1", "vikunja"), isNotFound);
  });

  test("get for an unknown (owner, pluginId) -> pin_not_found", () => {
    const { store } = makeStore();
    store.pin("user-1", "vikunja", { apiKey: "tok" });
    assert.throws(() => store.get("user-1", "ghost"), isNotFound);
    assert.throws(() => store.get("user-2", "vikunja"), isNotFound);
  });

  test("error messages never contain credential values (or value fragments)", () => {
    const secret = "sk-SUPER-SECRET-VALUE-42";
    const { store, advance } = makeStore();
    store.pin("user-1", "openrouter", { apiKey: secret });
    advance(900_001);

    assert.throws(
      () => store.get("user-1", "openrouter"),
      (e: unknown) => {
        assert.ok(e instanceof CredentialPinError);
        assert.equal(e.code, "credentials_expired");
        assert.ok(!e.message.includes(secret), "message must not leak the value");
        assert.ok(!e.message.includes("SUPER"), "message must not leak value fragments");
        assert.equal(e.pluginId, "openrouter");
        assert.equal(e.owner, "user-1");
        return true;
      },
    );

    // The pin_not_found path stays clean too.
    assert.throws(
      () => store.get("user-1", "openrouter"),
      (e: unknown) => {
        assert.ok(e instanceof CredentialPinError);
        assert.ok(!e.message.includes(secret));
        return true;
      },
    );
  });

  test("pin/get return copies — a caller mutating a returned pin cannot corrupt the store", () => {
    const { store } = makeStore();
    const pin = store.pin("u", "p", { apiKey: "orig" });
    assert.throws(
      () => {
        pin.credentials.apiKey = "tampered";
      },
      "the returned snapshot is frozen in place",
    );
    assert.throws(
      () => {
        pin.expiresAt = 0;
      },
      "every snapshot field is frozen",
    );

    const got = store.get("u", "p");
    assert.deepEqual(got.credentials, { apiKey: "orig" });
    assert.ok(got.expiresAt > 0, "store's pin must be unaffected");
  });

  test("two admissions for the same (owner, pluginId) get distinct immutable handles and neither release kills the other", () => {
    const { store } = makeStore();
    const first = store.pin("user-1", "vikunja", { apiKey: "tok-a" });
    const second = store.pin("user-1", "vikunja", { apiKey: "tok-b" });
    assert.notEqual(first.handle, second.handle);

    assert.equal(store.get("user-1", "vikunja", first.handle).credentials.apiKey, "tok-a");
    assert.equal(store.get("user-1", "vikunja", second.handle).credentials.apiKey, "tok-b");

    store.release("user-1", "vikunja", first.handle);
    assert.throws(
      () => store.get("user-1", "vikunja", first.handle),
      isNotFound,
      "the released handle is gone",
    );
    assert.equal(
      store.get("user-1", "vikunja", second.handle).credentials.apiKey,
      "tok-b",
      "the sibling admission's pin survives the other's release",
    );
    assert.equal(
      store.get("user-1", "vikunja").credentials.apiKey,
      "tok-b",
      "a handleless get resolves the surviving admission",
    );

    store.release("user-1", "vikunja", second.handle);
    assert.throws(() => store.get("user-1", "vikunja"), isNotFound);
  });

  test("a handle is bound to its pluginId — a foreign pluginId + handle pair is a clean miss", () => {
    const { store } = makeStore();
    const pin = store.pin("user-1", "vikunja", { apiKey: "tok" });
    store.pin("user-1", "mealie", { apiKey: "other" });
    assert.throws(
      () => store.get("user-1", "mealie", pin.handle),
      isNotFound,
      "a handle must never unlock another plugin's pin",
    );
  });

  test("handleless release drops only the latest admission; earlier handles keep working", () => {
    const { store } = makeStore();
    const first = store.pin("user-1", "vikunja", { apiKey: "tok-a" });
    store.pin("user-1", "vikunja", { apiKey: "tok-b" });
    store.release("user-1", "vikunja");
    assert.equal(store.get("user-1", "vikunja", first.handle).credentials.apiKey, "tok-a");
  });

  test("expiry is re-checked per handle at dispatch: one admission expiring does not kill the other", () => {
    const { store, advance } = makeStore();
    const first = store.pin("user-1", "vikunja", { apiKey: "tok-a" });
    advance(600_000);
    const second = store.pin("user-1", "vikunja", { apiKey: "tok-b" });
    advance(600_000); // first is past the 15 min cap, second has 5 min left

    assert.throws(() => store.get("user-1", "vikunja", first.handle), isExpired);
    assert.equal(
      store.get("user-1", "vikunja", second.handle).credentials.apiKey,
      "tok-b",
      "the younger admission is still dispatchable",
    );
  });

  test("a returned pin cannot be mutated into unlocking tampered credentials", () => {
    const { store } = makeStore();
    const pin = store.pin("user-1", "vikunja", { apiKey: "real" });
    assert.throws(
      () => {
        pin.credentials = { apiKey: "tampered" };
      },
      "the snapshot itself is frozen",
    );
    assert.equal(store.get("user-1", "vikunja", pin.handle).credentials.apiKey, "real");
  });
});