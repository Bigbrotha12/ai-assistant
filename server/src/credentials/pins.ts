import { credentialFingerprint } from "../plugins/credential.ts";

/**
 * Credential pins — Phase 2, Wave B: admitted background jobs only.
 *
 * Synchronous turns pass credentials straight through the request and cache
 * nothing (credential.ts); this store exists ONLY for the async path. A job
 * that has been *admitted* (accepted) may need its user's plugin credentials
 * for the duration of the job, so the gateway pins them in memory for a
 * bounded window.
 *
 * LIFETIME (absolute cap, non-extendable): a pin is born with `expiresAt =
 * issuedAt + maxLifetimeMs` (default 15 min). `refresh` re-checks liveness
 * only — it NEVER extends `expiresAt`. A job that outlives its pin fails with
 * `credentials_expired` rather than continuing to use keys past their cap.
 *
 * THREAT MODEL (plan §217-218): the parent heap holds only *active* pins,
 * keyed by (owner, pluginId) in a single in-process Map — the gateway is
 * single-process (plan line 76), so no cross-process sharing is required. A
 * worker/job NEVER receives a handle to the store; at dispatch time it is
 * handed a single-invocation COPY of the pin's credentials (`pin`/`get`
 * return snapshots, never internal objects), so a runaway job cannot read or
 * mutate another job's pins. Error messages carry `pluginId`/`owner` only —
 * never credential values and never the fingerprint (which is derived from
 * them).
 *
 * The store does NOT validate credentials: callers must hand it the validated
 * output of `validateCredentials` (spec-scoped, trimmed). Unvalidated values
 * must never reach a pin.
 */

/** Default absolute pin lifetime: 15 minutes, refresh-cannot-extend. */
export const DEFAULT_PIN_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** A live credential pin for one (owner, pluginId) admission. */
export interface CredentialPin {
  pluginId: string;
  /** Validated (spec-scoped, trimmed) credentials — the ONLY copy-forward. */
  credentials: Record<string, string>;
  /** credentialFingerprint() of `credentials`; an opaque dedupe/cache key. */
  fingerprint: string;
  /** Monotonic clock (injectable) time the pin was minted. */
  issuedAt: number;
  /** issuedAt + maxLifetimeMs. REFRESH CANNOT EXTEND this. */
  expiresAt: number;
}

export type CredentialPinErrorCode = "credentials_expired" | "pin_not_found";

/** Raised by pin lookups. Carries pluginId/owner only — never key values. */
export class CredentialPinError extends Error {
  readonly code: CredentialPinErrorCode;
  readonly pluginId: string;
  readonly owner: string;

  constructor(
    code: CredentialPinErrorCode,
    pluginId: string,
    owner: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialPinError";
    this.code = code;
    this.pluginId = pluginId;
    this.owner = owner;
  }
}

export type CredentialPinStoreOptions = {
  /** Absolute lifetime cap; default 15 min. `refresh` cannot extend it. */
  maxLifetimeMs?: number;
  /** Injectable clock (monotonic); defaults to Date.now. */
  now?: () => number;
};

/**
 * In-memory pin store, one pin per (owner, pluginId). Single-instance only —
 * the gateway is single-process, and the parent heap holding only *active*
 * pins IS the boundary the threat model relies on.
 */
export class CredentialPinStore {
  private readonly maxLifetimeMs: number;
  private readonly now: () => number;
  private readonly pins = new Map<string, Map<string, CredentialPin>>();

  constructor(opts: CredentialPinStoreOptions = {}) {
    const maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_PIN_MAX_LIFETIME_MS;
    if (!(maxLifetimeMs > 0)) {
      throw new Error(
        `CredentialPinStore: maxLifetimeMs must be a positive number, got ${maxLifetimeMs}`,
      );
    }
    this.maxLifetimeMs = maxLifetimeMs;
    this.now = opts.now ?? Date.now;
  }

  private pinsFor(owner: string): Map<string, CredentialPin> {
    let byPlugin = this.pins.get(owner);
    if (!byPlugin) {
      byPlugin = new Map();
      this.pins.set(owner, byPlugin);
    }
    return byPlugin;
  }

  /**
   * Pin already-validated credentials for a plugin + owner. Never validates —
   * callers pass `validateCredentials` output. Returns a snapshot (the store
   * and the caller hold independent copies).
   */
  pin(
    owner: string,
    pluginId: string,
    credentials: Record<string, string>,
  ): CredentialPin {
    const issuedAt = this.now();
    const pin: CredentialPin = {
      pluginId,
      credentials: { ...credentials },
      fingerprint: credentialFingerprint(credentials),
      issuedAt,
      expiresAt: issuedAt + this.maxLifetimeMs,
    };
    this.pinsFor(owner).set(pluginId, pin);
    return snapshot(pin);
  }

  /** The pin is alive only while `now() < expiresAt`; at/after the cap it is dead. */
  private assertAlive(owner: string, pluginId: string, pin: CredentialPin): void {
    if (this.now() >= pin.expiresAt) {
      // Drop the expired pin now so a later sweep/read is a clean miss.
      this.pins.get(owner)?.delete(pluginId);
      throw new CredentialPinError(
        "credentials_expired",
        pluginId,
        owner,
        `credential pin for plugin '${pluginId}' (owner ${owner}) expired; ` +
          "the background job must fail with credentials_expired",
      );
    }
  }

  /**
   * Fetch + validate a pin is still alive. Throws `credentials_expired` at/after
   * `expiresAt`, `pin_not_found` for an unknown (owner, pluginId). Returns a
   * snapshot — the caller gets a single-invocation copy, never a store handle.
   */
  get(owner: string, pluginId: string): CredentialPin {
    const pin = this.pins.get(owner)?.get(pluginId);
    if (!pin) {
      throw new CredentialPinError(
        "pin_not_found",
        pluginId,
        owner,
        `no credential pin for plugin '${pluginId}' (owner ${owner}); ` +
          "re-pin before admitting a background job",
      );
    }
    this.assertAlive(owner, pluginId, pin);
    return snapshot(pin);
  }

  /**
   * Re-checks a pin is still alive — the absolute lifetime cap means this
   * NEVER extends `expiresAt`. A job calling `refresh` past the cap gets
   * `credentials_expired`.
   */
  refresh(owner: string, pluginId: string): CredentialPin {
    return this.get(owner, pluginId);
  }

  /** Drops the pin for (owner, pluginId) — called when a job finishes/rejects. */
  release(owner: string, pluginId: string): void {
    const byPlugin = this.pins.get(owner);
    byPlugin?.delete(pluginId);
    if (byPlugin?.size === 0) this.pins.delete(owner);
  }

  /**
   * GC: drops every expired pin and returns how many were removed. The job
   * runner calls this periodically; it is also safe to call on every
   * pin/get. Defaults to the injected clock; accepts an explicit [now] for
   * deterministic tests.
   */
  sweep(now?: number): number {
    const t = now ?? this.now();
    let removed = 0;
    for (const [owner, byPlugin] of this.pins) {
      for (const [pluginId, pin] of byPlugin) {
        if (t >= pin.expiresAt) {
          byPlugin.delete(pluginId);
          removed++;
        }
      }
      if (byPlugin.size === 0) this.pins.delete(owner);
    }
    return removed;
  }
}

/** Independent copy so callers never hold a mutable handle into the store. */
function snapshot(pin: CredentialPin): CredentialPin {
  return { ...pin, credentials: { ...pin.credentials } };
}