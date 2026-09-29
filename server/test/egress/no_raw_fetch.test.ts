import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

/**
 * Regression guard for raw server-side egress (plan §5, task 2.7).
 *
 * The egress seam's exit criterion is "exactly one module performs server-side
 * egress". This test enforces the *direction* of that criterion for the ambient
 * global `fetch`: no module under `server/src` may call it outside the facade.
 * It is deliberately scoped, because a naive `fetch(` grep has real false
 * positives (see ALLOWLIST below).
 *
 * What it catches: a bare `fetch(...)` call or a `globalThis.fetch` reference in
 * a `server/src` module that is not on the allowlist. Both are how a module
 * reaches the ambient network stack directly and bypasses SSRF validation,
 * DNS pinning and the redirect policy.
 *
 * What it deliberately does NOT flag:
 *  - injected seams `fetchFn(...)` / `fetchImpl(...)` / `activeFetch(...)` — the
 *    identifier is a parameter, not the global; the identifier-boundary
 *    lookbehind excludes them (`fetch` is not matched inside `fetchFn`);
 *  - member calls `client.fetch(...)`, `this.egress.fetch(...)`,
 *    `stream.fetch(...)` — excluded by the "not preceded by `.`" lookbehind;
 *  - object-literal properties `{ fetch: mcpFetch }` and type members
 *    `fetch(url: string): ...` — neither is a `fetch(` call site preceded by a
 *    boundary in the matched form (the `:` separates them).
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/**
 * Files permitted to reference the ambient `fetch`. Each entry is a path
 * relative to `server/src`, normalised to POSIX separators.
 *
 * The list is intentionally short and every entry is a *seam*, not a policy
 * escape hatch. Adding a file here is a deliberate admission that the module is
 * allowed to touch the ambient network stack, so it needs a reason.
 */
const ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: "egress/client.ts",
    reason:
      "The facade itself. It owns the `fetchFn` plumbing and the " +
      "`globalThis.fetch` fallback for `openPinned`'s stream. This is the one " +
      "module the criterion names as the allowed egress surface.",
  },
  {
    file: "plugins/ssrf.ts",
    reason:
      "The facade's implementation. `fetchWithPinnedAddresses` performs the " +
      "pinned request via `opts.fetchFn ?? globalThis.fetch`; it is the other " +
      "half of the seam and is itself the SSRF enforcement.",
  },
  {
    file: "verify_email.ts",
    reason:
      "False positive: the `fetch(` lives inside a `<script>` in the " +
      "server-rendered HTML string, i.e. it runs in the USER'S BROWSER to call " +
      "better-auth's own /api/auth/verify-email route. It is not Node egress.",
  },
  {
    file: "reset_password.ts",
    reason:
      "False positive: same shape as verify_email.ts — browser-side `fetch(` " +
      "inside the reset-password page's `<script>`, calling " +
      "/api/auth/reset-password from the page, not from the server.",
  },
];

const ALLOWLISTED = new Set(ALLOWLIST.map((entry) => entry.file));

/**
 * Remove line comments and block comments while preserving line breaks, so a
 * comment that merely mentions `fetch(...)` cannot trip the guard and line
 * numbers in reported violations still point at real source lines.
 *
 * String literals are copied verbatim (the guard wants to see `fetch(` in an
 * HTML template); the two template-literal false positives are handled by the
 * file allowlist above rather than by fragile string heuristics.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      out += char;
      i += 1;
      while (i < n) {
        const inner = source[i]!;
        out += inner;
        i += 1;
        if (inner === "\\") {
          if (i < n) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

// A `fetch(` that is NOT part of a larger identifier (`fetchFn`, `activeFetch`)
// and NOT a member access (`client.fetch`). The `$` in the lookbehind guards a
// hypothetical `$fetch(` helper.
const RAW_FETCH_CALL = /(?<![\w.$])fetch\s*\(/;
const RAW_GLOBAL_FETCH = /\bglobalThis\s*\.\s*fetch\b/;

type RawFetchRef = { readonly line: number; readonly text: string };

/** All raw-fetch references in one source string, with 1-based line numbers. */
function findRawFetchRefs(source: string): RawFetchRef[] {
  const code = stripComments(source);
  const refs: RawFetchRef[] = [];
  code.split("\n").forEach((line, index) => {
    if (RAW_FETCH_CALL.test(line) || RAW_GLOBAL_FETCH.test(line)) {
      refs.push({ line: index + 1, text: line.trim() });
    }
  });
  return refs;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(toPosix(relative(SRC_DIR, full)));
    }
  }
  return files;
}

type Violation = RawFetchRef & { readonly file: string };

/** Every raw-fetch reference in a non-allowlisted `server/src` module. */
function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    if (ALLOWLISTED.has(file)) continue;
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    for (const ref of findRawFetchRefs(source)) {
      violations.push({ file, ...ref });
    }
  }
  return violations;
}

describe("no raw server-side fetch outside the egress facade (plan 2.7)", () => {
  test("the detector flags a bare fetch call and a globalThis.fetch reference", () => {
    assert.deepEqual(findRawFetchRefs('const r = await fetch("https://x");'), [
      { line: 1, text: 'const r = await fetch("https://x");' },
    ]);
    assert.deepEqual(findRawFetchRefs("const f = globalThis.fetch;"), [
      { line: 1, text: "const f = globalThis.fetch;" },
    ]);
    assert.deepEqual(findRawFetchRefs("const r = await fetch(url, init);"), [
      { line: 1, text: "const r = await fetch(url, init);" },
    ]);
  });

  test("the detector ignores injected seams, member calls, and comments", () => {
    assert.deepEqual(findRawFetchRefs("await fetchFn(url);"), []);
    assert.deepEqual(findRawFetchRefs("await fetchImpl(url);"), []);
    assert.deepEqual(findRawFetchRefs("const active = streamOpts.fetchFn ?? fetchFn;"), []);
    assert.deepEqual(findRawFetchRefs("await this.egress.fetch(url);"), []);
    assert.deepEqual(findRawFetchRefs("await client.fetch(url);"), []);
    assert.deepEqual(findRawFetchRefs("await stream.fetch(url);"), []);
    assert.deepEqual(findRawFetchRefs("{ fetch: mcpFetch }"), []);
    // Comments are stripped so prose mentions cannot trip the guard.
    assert.deepEqual(findRawFetchRefs("// call fetch(url) here"), []);
    assert.deepEqual(findRawFetchRefs("/* fetch(url) */"), []);
    // A block comment's newlines are preserved so later line numbers stay true.
    assert.deepEqual(findRawFetchRefs("/* a\n fetch(url)\n b */\nawait fetch(url);"), [
      { line: 4, text: "await fetch(url);" },
    ]);
  });

  test("every server/src module routes egress through the facade", () => {
    const violations = findViolations();
    assert.deepEqual(
      violations,
      [],
      violations.length === 0
        ? "no raw fetch references"
        : `raw server-side egress outside the allowlist:\n${violations
            .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
            .join("\n")}\nUse EgressClient (server/src/egress/client.ts) instead, ` +
            "or add a justified entry to ALLOWLIST if this is a browser-side or " +
            "implementation-site false positive.",
    );
  });

  test("the allowlist rationale is non-empty for every entry", () => {
    for (const entry of ALLOWLIST) {
      assert.ok(entry.reason.trim().length > 0, `${entry.file} needs a reason`);
    }
  });
});
