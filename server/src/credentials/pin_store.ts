import { JobError } from "../jobs/errors.ts";
import type { CredentialPinHandle, CredentialPinStore } from "./pins.ts";
import type {
  CredentialRequest,
  CredentialResolver,
  ResolvedCredential,
} from "./resolver.ts";

/**
 * Credential pin-store provider (plan §5 Phase 3, step 3.3).
 *
 * Wraps the job runner's inline `getCredentials` closure verbatim:
 *
 *   - the job's running-fence guard (`assertActive`) runs before every read;
 *   - a plugin with no admitted handle fails `JobError("credentials_expired")`
 *     with the identical message text;
 *   - the read is `pins.get(owner, pluginId, handle)` — HANDLE-addressed, so a
 *     sibling admission that re-pins the same (owner, pluginId) cannot swap the
 *     running job's key (runner.test.ts "tool credential reads go through the
 *     handle at dispatch").
 *
 * Owner and handles are per-JOB context, captured at construction; the
 * selector never carries them. `kind` is accepted for the shared contract but
 * does not change the lookup: the admitted handle map is the authority, exactly
 * as the closed-over `descriptor.pinHandles?.[pluginId]` was (the model plugin
 * rides the same map).
 *
 * The fingerprint is the pin's precomputed `CredentialPin.fingerprint` — the
 * job channel's own derivation, preferred as-is over re-deriving (plan §10.1).
 * That is why this provider needs the richer `ResolvedCredential` result and
 * could not return a bare credential map without changing the cache key's
 * fingerprint source.
 *
 * Security: returns the pin's already-held credential object (a frozen copy
 * held by the in-memory store); never copies, persists, or logs it.
 */
export type PinStoreCredentialContext = {
  readonly pins: CredentialPinStore;
  readonly owner: string;
  /**
   * The handles admitted for this job, keyed by plugin id (tool and model
   * alike). A plugin absent from the map fails `credentials_expired`.
   */
  readonly pinHandles: Readonly<Record<string, CredentialPinHandle>>;
  /** The job's running-fence guard; runs before every credential read. */
  readonly assertActive: () => void;
};

export class PinStoreCredentialResolver implements CredentialResolver {
  readonly name = "pin-store";
  private readonly pins: CredentialPinStore;
  private readonly owner: string;
  private readonly pinHandles: Readonly<Record<string, CredentialPinHandle>>;
  private readonly assertActive: () => void;

  constructor(context: PinStoreCredentialContext) {
    this.pins = context.pins;
    this.owner = context.owner;
    this.pinHandles = context.pinHandles;
    this.assertActive = context.assertActive;
  }

  resolve(req: CredentialRequest): ResolvedCredential | undefined {
    this.assertActive();
    const handle = this.pinHandles[req.pluginId];
    if (handle === undefined) {
      throw new JobError(
        "credentials_expired",
        `no admitted credential pin for plugin '${req.pluginId}'`,
      );
    }
    const pin = this.pins.get(this.owner, req.pluginId, handle);
    return { credentials: pin.credentials, fingerprint: pin.fingerprint };
  }
}
