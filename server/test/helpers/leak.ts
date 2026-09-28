import assert from "node:assert/strict";

/**
 * Shared JSON leak scanners for the transport contract tests.
 *
 * This is deliberately NOT a `*.test.ts` file: the test runner glob is
 * `test/*.test.ts test/**\/*.test.ts`, so a helper under `test/helpers/` is
 * imported but never executed as a suite of its own.
 *
 * These scanners were previously copy-pasted into `transport/contract.test.ts`,
 * `transport/models.test.ts` and `transport/agents_test.test.ts`, and had
 * already diverged on the security invariant — an http-only vs http(s) string
 * check, and differing forbidden-key sets. A URL could pass one copy and fail
 * another. There is now exactly one implementation.
 */

export type UrlLeakOptions = {
  /**
   * Object keys that must never appear anywhere in the payload. Defaults to
   * `["url", "endpoint"]`.
   */
  forbiddenKeys?: readonly string[];
  /**
   * Permit the redacted `baseUrls` container key (an array of `{id,label}`).
   * Defaults to `false`, which forbids `baseUrls` outright. When permitted its
   * values are still walked, so a URL hidden in a label is caught.
   */
  allowBaseUrlsContainer?: boolean;
};

/**
 * Depth-first walk over decoded JSON. `visit` is called for every value (leaves
 * included) with its path, and must not recurse itself.
 */
export function walkJson(
  node: unknown,
  path: string,
  visit: (node: unknown, path: string) => void,
): void {
  visit(node, path);
  if (Array.isArray(node)) {
    node.forEach((value, i) => walkJson(value, `${path}[${i}]`, visit));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      walkJson(value, `${path}.${key}`, visit);
    }
  }
}

/**
 * Assert a serialized payload never carries a provider URL (http OR https) nor
 * a forbidden key. Single source of truth for the plan §3.3 / guardrail
 * contract across the model, agent and plugin transports.
 */
export function assertNoUrlLeak(
  node: unknown,
  path: string,
  options: UrlLeakOptions = {},
): void {
  const forbiddenKeys = new Set<string>(options.forbiddenKeys ?? ["url", "endpoint"]);
  if (!options.allowBaseUrlsContainer) forbiddenKeys.add("baseUrls");

  walkJson(node, path, (current, currentPath) => {
    if (typeof current === "string") {
      assert.equal(
        /https?:\/\//i.test(current),
        false,
        `leaked URL at ${currentPath}: ${current}`,
      );
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const key of Object.keys(current)) {
      assert.equal(
        forbiddenKeys.has(key),
        false,
        `leaked '${key}' key at ${currentPath}.${key}`,
      );
    }
  });
}
