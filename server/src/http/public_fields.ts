import type { Context } from "hono";

/**
 * Shared validation for user-supplied public request fields (N3 DRY).
 *
 * Both the ledger route surface (`ledger.routes.ts`) and the goal route
 * surface (`goals/routes.ts`) validate public text/JSON fields identically:
 * non-empty, control-character-free, byte-bounded strings, plus the
 * "is a plain JSON object" predicate their bodies need. Keeping one copy here
 * means a bound or predicate change cannot drift between the two surfaces.
 *
 * The behavior is deliberately bit-identical to the two former local copies:
 * trimming decides emptiness but the FULL (untrimmed) value is byte-counted,
 * and `identifier` additionally rejects the `.`/`..` path sentinels.
 */

/** C0 controls + DEL: never valid in a public text field. */
export const PUBLIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The §5.1 flat error envelope a rejected public field maps to. */
export type PublicFieldError = "invalid_request" | "request_too_large";

/** UTF-8 byte length of [value] exceeds [maxBytes]. */
export function exceedsByteLimit(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") > maxBytes;
}

/**
 * Validates a public text field: `invalid_request` for a non-string, an
 * all-whitespace value, a control character, or a `.`/`..` identifier;
 * `request_too_large` when its UTF-8 length exceeds [maxBytes]; else `null`.
 */
export function publicTextError(
  value: unknown,
  maxBytes: number,
  identifier: boolean,
): PublicFieldError | null {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    PUBLIC_CONTROL_CHARACTERS.test(value)
  ) {
    return "invalid_request";
  }
  if (identifier && (value === "." || value === "..")) {
    return "invalid_request";
  }
  return exceedsByteLimit(value, maxBytes) ? "request_too_large" : null;
}

/** Maps a {@link PublicFieldError} to its HTTP response (400 / 413). */
export function publicFieldError(c: Context, error: PublicFieldError): Response {
  return error === "request_too_large"
    ? c.json({ error }, 413)
    : c.json({ error }, 400);
}

/** True for a non-null, non-array object value. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Alias for {@link isRecord}: the ledger surface historically named the same
 * predicate `isJsonObject`. Both names are exported so neither caller needs a
 * local wrapper.
 */
export const isJsonObject = isRecord;
