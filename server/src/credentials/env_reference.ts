import { MCP_HEADER_REFERENCE_PATTERN } from "../plugins/types.ts";

/**
 * Shared core of the `${VAR}` MCP-header resolvers (plan §5 Phase 3, step 3.4).
 *
 * It owns exactly one thing: turn a `${VAR}` reference into `process.env[VAR]`,
 * rejecting an undefined variable and rejecting CRLF / control characters in
 * the resolved value. The three call sites keep their OWN policy on top and
 * must not be merged:
 *
 *   - `catalog/mcp.ts` (`resolveHeaderValue`) is STRICT — the value must be a
 *     reference, and each failure reason throws `SsrfValidationError` with its
 *     own message. Runs at catalog load.
 *   - `agents/mcp.ts` (`resolveMcpRequestHeaders`) is PERMISSIVE — literals pass
 *     through untouched and references resolve; any failure throws the same
 *     `McpError("MCP_POLICY_DENIED", "INVALID_URL")`. Runs at connect time.
 *   - `jobs/runner.ts` (`parsePersistedJobSpec`) re-resolves references from
 *     `process.env` on resume and treats any failure as an invalid spec (`null`).
 *
 * `serializeJobSpec` deliberately does NOT call this core. It classifies values
 * by SHAPE (`isMcpHeaderReference`), not by whether the variable currently
 * resolves, so a reference to a not-yet-set variable is still persisted to be
 * re-resolved on resume. Delegating that classification here would drop the
 * reference and be a behaviour change.
 */

/**
 * `\r`, `\n`, and every C0 control (`\u0000`–`\u001f`). All three historical
 * call sites used exactly this class, so it is simultaneously the strictest and
 * the only check applied to a resolved header value in the codebase.
 * (`plugins/credential.ts` additionally rejects `\u007f` for API-key payloads,
 * but widening this class would be a behaviour change for these callers.)
 */
const CONTROL_CHARACTER_PATTERN = /[\r\n\u0000-\u001f]/;

export type EnvReferenceFailure =
  | "not-a-reference"
  | "undefined"
  | "control-characters";

export type EnvReferenceResolution =
  | { readonly ok: true; readonly variable: string; readonly value: string }
  | {
      readonly ok: false;
      readonly variable: string;
      readonly reason: EnvReferenceFailure;
    };

/**
 * Resolve a `${VAR}` reference. Callers that accept literals must first test
 * `isMcpHeaderReference`; callers that require a reference may map
 * `"not-a-reference"` to their own grammar error. `variable` is `""` when the
 * input is not a reference.
 */
export function resolveEnvReference(
  reference: string,
): EnvReferenceResolution {
  if (!MCP_HEADER_REFERENCE_PATTERN.test(reference)) {
    return { ok: false, variable: "", reason: "not-a-reference" };
  }
  const variable = reference.slice(2, -1);
  const value = process.env[variable];
  if (value === undefined) {
    return { ok: false, variable, reason: "undefined" };
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return { ok: false, variable, reason: "control-characters" };
  }
  return { ok: true, variable, value };
}
