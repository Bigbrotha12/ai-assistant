import { CREDENTIAL_REDACTION } from "../plugins/credential.ts";

/**
 * Credential redaction (stateless-gateway, step 8). The SQLCipher checkpoint
 * store this module once wrapped is gone (plan §9) — no checkpoint DB is ever
 * opened — but `redactForCheckpoint` survives because every outbound path
 * (the ToolExecutor, the tool-result cache, the transports) still masks
 * credential-shaped material in tool results before they reach graph state or
 * the ledger.
 *
 * Masks `Authorization: <value>` headers (Bearer AND Basic/generic, value to
 * end-of-line), bare `Bearer <token>` occurrences, `sk-...` API keys,
 * `Api-Key`/`X-Api-Key` headers, and quoted JSON `api_key`/`token`/`secret`/
 * `authorization` fields with `CREDENTIAL_REDACTION` (`***`), reusing the
 * marker from `plugins/credential.ts`. Never logs anything itself.
 */

const AUTHORIZATION_BEARER = /Authorization\s*:\s*Bearer\s+\S+/gi;
// Generic `Authorization: <value>` — but never the Bearer form, which the
// previous pattern already handles (a bare `\S+` would swallow the word
// "Bearer" and double-mask it). Masks the WHOLE value to end-of-line: a Basic
// or generic token ("Basic dXNlcjpwYXNz") carries its credential in the first
// token AND potentially more on the same line, so a single `\S+` left the tail
// unmasked. `[^\n\r]*` (no `m` flag needed) never crosses into the next line.
const AUTHORIZATION_GENERIC = /Authorization\s*:\s*(?!Bearer\b)\S+[^\n\r]*/gi;
const BARE_BEARER = /Bearer\s+\S+/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]+/g;
// Non-Bearer credential header fields: `Api-Key: ...`, `X-Api-Key: ...`
// (any case). Masks the value to end-of-line, keeping the field name.
const API_KEY_HEADER = /(\b(?:x-)?api[-_]?key\s*:\s*)[^\n\r]*/gi;
// JSON-style credential fields: `"api_key": "abc123"`, `"apiKey": "..."`,
// `"x-api-key": "..."`, `"token": "..."`, `"secret": "..."`,
// `"authorization": "..."`. Only quoted values are masked (a numeric/bool
// literal is not key material); the closing quote keeps the mask from
// swallowing a following key/value on the same line.
const JSON_CREDENTIAL_FIELD =
  /("|')((?:x-)?api[-_]?key|token|secret|authorization)(?:"|')\s*:\s*("|')([^"'\n]*)\3/gi;

/**
 * Masks credential-shaped material in a string before it is persisted into
 * checkpoint rows (tool results routinely echo API keys/bearer tokens back
 * into message content). Masks `Authorization: <value>` headers (Bearer AND
 * Basic/generic, value to end-of-line), bare `Bearer <token>` occurrences,
 * `sk-...` API keys, `Api-Key`/`X-Api-Key` headers, and quoted JSON
 * `api_key`/`token`/`secret`/`authorization` fields with `CREDENTIAL_REDACTION`
 * (`***`), reusing the marker from `plugins/credential.ts`. The transport
 * (Wave C1 / Phase 3) applies this to message/tool-result content before the
 * graph writes it; the store keeps it here so the redaction discipline lives
 * next to the data it protects. Never logs anything itself.
 */
export function redactForCheckpoint(content: string): string {
  return content
    .replace(AUTHORIZATION_BEARER, `Authorization: Bearer ${CREDENTIAL_REDACTION}`)
    .replace(AUTHORIZATION_GENERIC, `Authorization: ${CREDENTIAL_REDACTION}`)
    .replace(BARE_BEARER, `Bearer ${CREDENTIAL_REDACTION}`)
    .replace(API_KEY_HEADER, `$1${CREDENTIAL_REDACTION}`)
    .replace(JSON_CREDENTIAL_FIELD, `$1$2$1: $3${CREDENTIAL_REDACTION}$3`)
    .replace(SK_KEY, `sk-${CREDENTIAL_REDACTION}`);
}