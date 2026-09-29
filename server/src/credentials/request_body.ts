import { credentialFingerprint } from "../plugins/credential.ts";
import type {
  CredentialRequest,
  CredentialResolver,
  ResolvedCredential,
} from "./resolver.ts";

/**
 * Request-body credential provider (plan §5 Phase 3, step 3.2).
 *
 * Wraps the sync channels' inline request-body substitution:
 *
 *   - `agents/orchestrator.ts` (`bindPluginTools`) built `ToolCall.credentials`
 *     from `credentialsByPlugin?.[pluginId]` and its fingerprint from
 *     `credentialFingerprint(credentials ?? {})`;
 *   - `transport/chat.ts` passes the request's validated TOOL map, and the
 *     selected MODEL plugin's validated credentials that also ride the body.
 *
 * The per-request map(s) are captured at CONSTRUCTION (the request is the
 * scope), so `resolve({pluginId, kind, channel})` is the whole call surface and
 * the selector never carries a credential value. A plugin the request carried
 * no credentials for yields `undefined`, byte-for-byte the `?.`/`??` semantics
 * the inline chain had.
 *
 * The fingerprint is derived HERE with `credentialFingerprint`, the same
 * derivation the sync channel used inline (plan §10.1 — deliberately NOT
 * unified with the job channel's pin fingerprint). It returns the SAME
 * credential object reference the request already holds; it never copies,
 * persists, or logs it, and it performs no outbound read of its own.
 */
export type RequestBodyCredentialContext = {
  /** Validated per-tool-plugin credentials from `body.credentials` (H2). */
  readonly toolCredentialsByPlugin: Record<string, Record<string, string>>;
  /** The selected model plugin and its validated request-body credentials. */
  readonly model?: {
    readonly pluginId: string;
    readonly credentials: Record<string, string>;
  };
};

export class RequestBodyCredentialResolver implements CredentialResolver {
  readonly name = "request-body";
  private readonly toolCredentialsByPlugin: Record<string, Record<string, string>>;
  private readonly model:
    | { readonly pluginId: string; readonly credentials: Record<string, string> }
    | undefined;

  constructor(context: RequestBodyCredentialContext) {
    this.toolCredentialsByPlugin = context.toolCredentialsByPlugin;
    this.model = context.model;
  }

  resolve(req: CredentialRequest): ResolvedCredential | undefined {
    if (req.kind === "model") {
      if (this.model === undefined || req.pluginId !== this.model.pluginId) {
        return undefined;
      }
      return {
        credentials: this.model.credentials,
        fingerprint: credentialFingerprint(this.model.credentials),
      };
    }
    const credentials = this.toolCredentialsByPlugin[req.pluginId];
    if (credentials === undefined) return undefined;
    return {
      credentials,
      fingerprint: credentialFingerprint(credentials),
    };
  }
}
