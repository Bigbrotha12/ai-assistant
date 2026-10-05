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

/** C0 controls + DEL EXCEPT `\n` (U+000A): valid only in a prose field. */
export const PUBLIC_PROSE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/;

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

/**
 * Validates a multi-line public prose field. Identical to {@link publicTextError}
 * with `identifier: false` EXCEPT U+000A (`\n`) is allowed; every other C0
 * control and DEL is still refused.
 *
 * Prose differs from other public fields (which stay control-free) because a
 * legitimate user-authored answer is routinely multi-line: the resume sheet's
 * answer input is explicitly multi-line (minLines 3 / maxLines 6), so pressing
 * Enter must not yield a bare 400. Only the line feed is admitted — a stray C0
 * control or DEL remains `invalid_request`. Returns `invalid_request` for a
 * non-string or all-whitespace value too, and `request_too_large` past
 * [maxBytes].
 */
export function publicProseTextError(
  value: unknown,
  maxBytes: number,
): PublicFieldError | null {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    PUBLIC_PROSE_CONTROL_CHARACTERS.test(value)
  ) {
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
