import { randomUUID } from "node:crypto";
import { credentialFingerprint } from "../plugins/credential.ts";

export const DEFAULT_PIN_MAX_LIFETIME_MS = 15 * 60 * 1000;

export type CredentialPinHandle = string;

export interface CredentialPin {
  readonly handle: CredentialPinHandle;
  pluginId: string;
  credentials: Record<string, string>;
  fingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

export type CredentialPinErrorCode = "credentials_expired" | "pin_not_found";

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
  maxLifetimeMs?: number;
  now?: () => number;
};

export class CredentialPinStore {
  private readonly maxLifetimeMs: number;
  private readonly now: () => number;
  private readonly pins = new Map<string, Map<CredentialPinHandle, CredentialPin>>();

  constructor(opts: CredentialPinStoreOptions = {}) {
    const maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_PIN_MAX_LIFETIME_MS;
    if (!Number.isFinite(maxLifetimeMs) || !(maxLifetimeMs > 0)) {
      throw new Error(
        `CredentialPinStore: maxLifetimeMs must be a positive finite number, got ${maxLifetimeMs}`,
      );
    }
    this.maxLifetimeMs = maxLifetimeMs;
    this.now = opts.now ?? Date.now;
  }

  pin(
    owner: string,
    pluginId: string,
    credentials: Record<string, string>,
  ): CredentialPin {
    const issuedAt = this.now();
    const pin: CredentialPin = Object.freeze({
      handle: randomUUID(),
      pluginId,
      credentials: Object.freeze({ ...credentials }),
      fingerprint: credentialFingerprint(credentials),
      issuedAt,
      expiresAt: issuedAt + this.maxLifetimeMs,
    });
    let byHandle = this.pins.get(owner);
    if (!byHandle) {
      byHandle = new Map();
      this.pins.set(owner, byHandle);
    }
    byHandle.set(pin.handle, pin);
    return snapshot(pin);
  }

  private find(
    owner: string,
    pluginId: string,
    handle?: CredentialPinHandle,
  ): CredentialPin | undefined {
    const byHandle = this.pins.get(owner);
    if (handle !== undefined) {
      const pin = byHandle?.get(handle);
      return pin?.pluginId === pluginId ? pin : undefined;
    }
    let latest: CredentialPin | undefined;
    for (const pin of byHandle?.values() ?? []) {
      if (pin.pluginId === pluginId) latest = pin;
    }
    return latest;
  }

  get(owner: string, pluginId: string, handle?: CredentialPinHandle): CredentialPin {
    const pin = this.find(owner, pluginId, handle);
    if (!pin) {
      throw new CredentialPinError(
        "pin_not_found",
        pluginId,
        owner,
        `no credential pin for plugin '${pluginId}' (owner ${owner})`,
      );
    }
    if (this.now() >= pin.expiresAt) {
      this.release(owner, pluginId, pin.handle);
      throw new CredentialPinError(
        "credentials_expired",
        pluginId,
        owner,
        `credential pin for plugin '${pluginId}' (owner ${owner}) expired`,
      );
    }
    return snapshot(pin);
  }

  refresh(owner: string, pluginId: string, handle?: CredentialPinHandle): CredentialPin {
    return this.get(owner, pluginId, handle);
  }

  release(owner: string, pluginId: string, handle?: CredentialPinHandle): void {
    const pin = this.find(owner, pluginId, handle);
    if (!pin) return;
    const byHandle = this.pins.get(owner);
    byHandle?.delete(pin.handle);
    if (byHandle?.size === 0) this.pins.delete(owner);
  }

  sweep(now?: number): number {
    const t = now ?? this.now();
    let removed = 0;
    for (const [owner, byHandle] of this.pins) {
      for (const [handle, pin] of byHandle) {
        if (t >= pin.expiresAt) {
          byHandle.delete(handle);
          removed++;
        }
      }
      if (byHandle.size === 0) this.pins.delete(owner);
    }
    return removed;
  }
}

function snapshot(pin: CredentialPin): CredentialPin {
  return Object.freeze({ ...pin, credentials: Object.freeze({ ...pin.credentials }) });
}
