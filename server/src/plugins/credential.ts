import { createHash } from "node:crypto";
import type { CredentialSpec } from "./types.ts";
import { isRecord } from "../util.ts";

/**
 * Per-request credential extraction & validation (Phase 1, Step 5).
 *
 * Credentials are USER-OWNED and transient: the client submits them per
 * request over HTTPS, the server uses them for a single outbound call, then
 * discards them. This module NEVER stores, caches, or pins credentials — the
 * in-memory pin mechanism is Phase 2's admitted-background-jobs feature and
 * explicitly out of scope here (docs/backend-langchain-plan.md line 64,
 * Phase 2 §211-218).
 *
 * BODY CONTRACT (standardized) — transport (Phase 3) and client (Phase 5)
 * speak this shape. Credentials ride the `credentials` request field, keyed by
 * plugin id so one request can carry keys for many plugins (the plan's wire
 * shape nests them per plugin):
 *
 *   {
 *     credentials: {
 *       "mealie":  { apiKey: "sk-..." },
 *       "vikunja": { apiKey: "tok-..." }
 *     }
 *   }
 *
 * `extractCredentialsFromBody` resolves the per-plugin object; the
 * `Authorization: Bearer` header (used for model-plugin keys) is parsed by the
 * transport's `requireApiKey`/`extractBearerToken` in `inference.ts`.
 *
 * Non-leak guardrails:
 *  - No credential value is ever logged, echoed, or included in error messages
 *    from this module.
 *  - `validateCredentials` returns the ONLY object callers may forward to an
 *    outbound call; it is discarded after that call.
 *  - `credentialFingerprint` exists so cache keys never touch raw values.
 */

/**
 * What a request can supply as a plugin's credentials. Values are short-lived
 * API keys/tokens; e.g. `{ apiKey: "sk-..." }`.
 */
export interface RequestCredentialInput {
  [reference: string]: string | undefined;
}

export type PluginCredentialErrorCode =
  | "MISSING_CREDENTIAL"
  | "INVALID_CREDENTIAL_FORMAT";

/** Raised when a request's supplied credentials do not satisfy a plugin's spec. */
export class PluginCredentialError extends Error {
  readonly code: PluginCredentialErrorCode;
  readonly pluginId: string;

  constructor(
    code: PluginCredentialErrorCode,
    pluginId: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginCredentialError";
    this.code = code;
    this.pluginId = pluginId;
  }
}

/**
 * The credential references a spec declares, in declaration order, empty when
 * `spec` is undefined or declares no fields. An empty spec means "this plugin
 * needs no credentials" — validation then always passes and returns `{}`.
 */
function specReferences(
  spec: CredentialSpec | undefined,
): Array<keyof CredentialSpec> {
  if (!spec) return [];
  return (Object.keys(spec) as Array<keyof CredentialSpec>).filter(
    (reference) => spec[reference] !== undefined,
  );
}

/**
 * All credential values are key material by definition (they are bearer tokens
 * the transport forwards to an outbound call), so every present value must be
 * free of control characters and whitespace: `\x00-\x1f` (C0 controls incl.
 * NUL, tab, CR/LF) and `\x7f` (DEL) could smuggle header/log-injection or
 * bypass line-based parsers, and `\s` also covers plain spaces/tabs that would
 * corrupt an HTTP header. Applicable to ANY credential field, not just
 * `apiKey`.
 */
const INVALID_KEY_MATERIAL = /[\x00-\x1f\x7f\s]/;

/**
 * Validate a request's supplied credentials against a plugin's spec.
 *
 * - No spec (or an empty spec) → valid, `{}` returned (no credentials needed).
 * - A required field that is missing or blank after trim → `MISSING_CREDENTIAL`.
 * - Optional fields may be absent; whitespace-only counts as absent.
 * - A present value containing control characters (`\x00-\x1f\x7f`) or
 *   whitespace (a header/log-injection hazard) → `INVALID_CREDENTIAL_FORMAT`.
 *   Applies to every credential field — all are key material.
 * - Values are trimmed; the returned object contains ONLY the fields the spec
 *   declares — unknown/extra input fields are never echoed.
 * - A MODEL plugin (`options.isModel`) may also carry `baseUrlEntry`, a ROUTING
 *   field (not a credential secret) that selects a base-URL instance from the
 *   plugin's allowlisted `baseUrls` (docs/backend-langchain-plan.md §329-335).
 *   It is passed through untrimmed-validated here — resolved against the
 *   allowlist only at model build time; a blank entry counts as absent, and it
 *   never receives the key-material check above.
 *
 * Callers pass the returned object to the single outbound call and discard it.
 */
export function validateCredentials(
  spec: CredentialSpec | undefined,
  input: RequestCredentialInput,
  pluginId: string,
  options?: { isModel?: boolean },
): Record<string, string> {
  const validated: Record<string, string> = {};
  const references = specReferences(spec);
  if (references.length > 0) {
    for (const reference of references) {
      const descriptor = spec![reference]!;
      const trimmed = input[reference]?.trim() ?? "";

      if (trimmed === "") {
        if (descriptor.required) {
          throw new PluginCredentialError(
            "MISSING_CREDENTIAL",
            pluginId,
            `plugin '${pluginId}' requires credential '${reference}'; none was supplied`,
          );
        }
        continue; // optional field absent (whitespace-only counts as absent)
      }

      if (INVALID_KEY_MATERIAL.test(trimmed)) {
        throw new PluginCredentialError(
          "INVALID_CREDENTIAL_FORMAT",
          pluginId,
          `credential '${reference}' for plugin '${pluginId}' must not contain ` +
            "control characters, whitespace or newlines; refusing to forward a " +
            "header/log-injection hazard",
        );
      }

      validated[reference] = trimmed;
    }
  }

  // Routing pass-through for model plugins: `baseUrlEntry` is not key
  // material, so no `INVALID_KEY_MATERIAL` gate — the plugin's `baseUrls`
  // allowlist is the authority, applied at model build time (transport/model.ts).
  if (options?.isModel && typeof input["baseUrlEntry"] === "string") {
    const baseUrlEntry = input["baseUrlEntry"].trim();
    if (baseUrlEntry !== "") validated["baseUrlEntry"] = baseUrlEntry;
  }
  return validated;
}

/**
 * Pull the per-plugin credential input out of a request body (see the module
 * doc for the standardized `credentials` field). Returns only string values,
 * drops non-strings; a missing/non-object body, credentials field, or
 * per-plugin entry yields `{}` — validation then decides. When `spec` is
 * provided, references the spec does not define are dropped at the source
 * (the server only consumes shapes it knows). Raw values are NOT trimmed or
 * validated here; `validateCredentials` does that.
 *
 * One exception: a MODEL plugin (`options.isModel`) also lets the non-secret
 * `baseUrlEntry` routing field through wholesale (it is never in the
 * credential spec — it selects a base-URL instance from the plugin's
 * allowlisted `baseUrls`). Tool plugins always drop it. Resolution happens at
 * model build time, so no validation or trimming happens here beyond the
 * existing string check.
 */
export function extractCredentialsFromBody(
  body: unknown,
  pluginId: string,
  spec?: CredentialSpec,
  options?: { isModel?: boolean },
): RequestCredentialInput {
  if (!isRecord(body)) return {};
  const credentialsField = body["credentials"];
  if (!isRecord(credentialsField)) return {};
  const perPlugin = credentialsField[pluginId];
  if (!isRecord(perPlugin)) return {};

  const references = specReferences(spec);
  const out: RequestCredentialInput = {};
  for (const [reference, value] of Object.entries(perPlugin)) {
    if (typeof value !== "string") continue;
    const typedReference = reference as keyof CredentialSpec;
    if (references.length > 0 && !references.includes(typedReference)) {
      // `baseUrlEntry` is a routing field, not a credential secret: keep it
      // for model plugins (validation lets it through and resolution happens
      // at model build), drop it for tool plugins.
      if (!(options?.isModel && reference === "baseUrlEntry")) continue;
    }
    out[reference] = value;
  }
  return out;
}

/**
 * Stable, non-reversible sha256 over sorted `key=value` pairs of a validated
 * credential set (Phase 4's tool-result cache key:
 * `(userId, pluginId, pluginVersion, credentialFingerprint, tool, argsHash)`).
 * A hash, never a store of the values: NEVER log this alongside (or instead
 * of) its source credentials, and never use it to look values back up.
 */
export function credentialFingerprint(creds: Record<string, string>): string {
  const joined = Object.keys(creds)
    .sort()
    .map((reference) => `${reference}=${creds[reference]}`)
    .join("|");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/** Marker substituted for credential values in logs/errors — never the value. */
export const CREDENTIAL_REDACTION = "***";