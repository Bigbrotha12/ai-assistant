/**
 * Credential resolver seam — Service Definition (plan §5 Phase 3, step 3.1).
 *
 * The plan's seam test is "a capability is a seam only if all three roles
 * exist": this module is the Contract, the providers are the Service, and
 * `transport/chat.ts` / `jobs/runner.ts` are the Consumers (steps 3.2, 3.3,
 * 3.5).
 *
 * ── Interface-gap settlement (step 3a) ──────────────────────────────────────
 * `CredentialRequest` is `{owner?, pluginId, kind, channel}` and is kept as the
 * per-call SELECTOR. The two providers it was designed for need per-request /
 * per-job context that a selector must not carry:
 *
 *   - the request-body provider needs the request's validated credential
 *     map(s);
 *   - the pin-store provider needs the admitted pin handle (and owner).
 *
 * Rather than widen the type — which would leak the map/handle into every call
 * site and make the selector channel-specific — each provider is CONSTRUCTED
 * WITH its context and closes over it, exactly like `ToolExecutor` and
 * `bindMcpServers` already do. `resolve({pluginId, kind, channel})` is
 * therefore the whole call surface.
 *
 * Two deviations from the frozen plan signature are deliberate and recorded:
 *
 *  1. `resolve` is SYNCHRONOUS. All three providers are in-memory lookups
 *     (request-body maps, the pin store, `process.env`), and both consumers are
 *     synchronous hook points (`bindTools`' `buildCall`, the runner's
 *     `assertDispatch`). A `Promise` would force either an unawaited call or an
 *     `await` in a synchronous hook; neither exists.
 *  2. The result is `ResolvedCredential` — the credentials PLUS the channel's
 *     own cache-key fingerprint derivation. The plain
 *     `Record<string, unknown> | undefined` could not express the pin store's
 *     precomputed `CredentialPin.fingerprint`, which the job channel must
 *     prefer over re-deriving it (plan §10.1). Returning it from the provider
 *     is what keeps each channel's derivation intact once the inline sourcing
 *     is gone.
 *
 * Security invariant (plan §5 Phase 3): credentials resolved through this seam
 * are never persisted, logged, or returned by a list/detail endpoint. The only
 * derived representation that may leave the seam is `credentialFingerprint`
 * (`plugins/credential.ts`); `plugins/store.ts`'s `assertNoCredentialValues` /
 * `assertCredentialsSpecOnly` continue to gate persistence. A provider returns
 * a reference to an already-held credential object and performs no caching,
 * copying, or logging of its own.
 */
export type CredentialRequest = {
  owner?: string;
  pluginId: string;
  kind: "model" | "tool";
  channel: "sync" | "job";
};

/** Credentials plus the channel's own cache-key fingerprint derivation. */
export type ResolvedCredential = {
  readonly credentials: Record<string, string>;
  readonly fingerprint: string;
};

export type CredentialResolver = {
  readonly name: string;
  /** Missing → `undefined` (a plugin with no credentials is valid). */
  resolve(req: CredentialRequest): ResolvedCredential | undefined;
};
