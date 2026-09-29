/**
 * Credential resolver seam — Service Definition (plan §5 Phase 3, step 3.1).
 *
 * The plan's seam test is "a capability is a seam only if all three roles
 * exist": this module is the Contract. The providers (request-body transport
 * substitution, the credential pin store, and the `${VAR}` env-reference
 * resolver) and the per-channel wiring in `index.ts` are later steps (3.2–3.5).
 * They are deliberately NOT defined here so the contract can be adopted without
 * changing any call site.
 *
 * Security invariant (plan §5 Phase 3): credentials resolved through this seam
 * are never persisted, logged, or returned by a list/detail endpoint. The only
 * derived representation that may leave the seam is `credentialFingerprint`
 * (`plugins/credential.ts`); `plugins/store.ts` continues to gate persistence.
 */
export type CredentialRequest = {
  owner?: string;
  pluginId: string;
  kind: "model" | "tool";
  channel: "sync" | "job";
};

export type CredentialResolver = {
  readonly name: string;
  resolve(req: CredentialRequest): Promise<Record<string, unknown> | undefined>;
};
