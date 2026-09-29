import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Regression guard for raw server-side egress (plan §5, task 2.7).
 *
 * The egress seam's exit criterion is "exactly one module performs server-side
 * egress" (SCOPED to HTTP(S) — SMTP via `email.ts` is a recorded carve-out, see
 * the plan). This test enforces the direction of that criterion for the ambient
 * global `fetch`: no module under `server/src` may reach it outside the facade.
 *
 * The check is AST-based (TypeScript compiler API), not a line regex, so it
 * cannot be evaded by the shapes a regex misses:
 *  - `globalThis["fetch"](u)`                      (computed access)
 *  - `const f = fetch; f(u)`                       (aliasing)
 *  - `(0, fetch)(u)`                               (comma/indirect call)
 *  - a call split across lines                     (line-scoped regex miss)
 *
 * It ALSO flags imports of the direct protocol clients (`node:http`,
 * `node:https`, `undici`, `node:net`, `node:tls`) outside the allowlist, since
 * `undici.request`, `http.request`, `net.connect` and `tls.connect` bypass the
 * facade just as surely as a raw `fetch`.
 *
 * What it deliberately does NOT flag:
 *  - injected seams (`fetchFn(...)`, `fetchImpl(...)`) — the identifier is a
 *    parameter, not the global;
 *  - member calls (`client.fetch(...)`, `stream.fetch(...)`);
 *  - property names/type members (`{ fetch: mcpFetch }`, `fetch(url): ...`)
 *    and type-only references (`typeof fetch`);
 *  - a raw `fetch(` that appears inside a `<script>` template region. With an
 *    AST this needs no allowlist at all: template-literal TEXT is not parsed as
 *    code, so the browser-side `fetch(` in the two server-rendered HTML pages
 *    is invisible to the detector. A genuine server-side `fetch(` added to those
 *    files — including inside a `${...}` substitution, which really does run at
 *    render time — IS parsed and caught. (The old regex guard scanned template
 *    text and therefore needed a whole-file allowlist; the AST removes both the
 *    false positive and the evasion hole a file-wide exemption would leave.)
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/**
 * Files permitted to reach the ambient `fetch`. Each entry is a path relative to
 * `server/src`, normalised to POSIX separators.
 *
 * The list is intentionally short and every entry is a *seam*, not a policy
 * escape hatch. Adding a file here is a deliberate admission that the module may
 * touch the ambient network stack, so it needs a reason.
 */
const FETCH_ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
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
];

/**
 * Files permitted to import a direct protocol client. Only the SSRF core and
 * the notify host classifier need these; neither opens a connection outside the
 * facade (`ssrf.ts` builds the pinned agent, `notify/hook.ts` only classifies an
 * address literal).
 */
const DEREFERENCE_IMPORT_ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [
  {
    file: "plugins/ssrf.ts",
    reason:
      "The SSRF core imports `Agent`/`buildConnector` from `undici` and " +
      "`isIP` from `node:net` to build the pinned connector. This IS the " +
      "enforcement.",
  },
  {
    file: "notify/hook.ts",
    reason:
      "Imports `isIP` from `node:net` only to classify a host literal during " +
      "config validation; it never opens a socket directly (egress goes through " +
      "the facade).",
  },
];

const DEREFERENCE_MODULES = new Set([
  "node:http",
  "node:https",
  "undici",
  "node:net",
  "node:tls",
]);

const FETCH_ALLOWLISTED = new Set(FETCH_ALLOWLIST.map((entry) => entry.file));
const IMPORT_ALLOWLISTED = new Set(DEREFERENCE_IMPORT_ALLOWLIST.map((entry) => entry.file));

type RawRef = { readonly line: number; readonly text: string };

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
}

function lineTextOf(source: string, line: number): string {
  return (source.split("\n")[line - 1] ?? "").trim();
}

function buildParentMap(sf: ts.SourceFile): Map<ts.Node, ts.Node> {
  const parents = new Map<ts.Node, ts.Node>();
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, (child) => {
      parents.set(child, node);
      visit(child);
    });
  };
  visit(sf);
  return parents;
}

function isGlobalObjectIdentifier(expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const name = expr.text;
  return name === "globalThis" || name === "global" || name === "window" || name === "self";
}

/** `globalThis.fetch` or `globalThis["fetch"]` (any access expression). */
function isGlobalFetchAccess(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "fetch" && isGlobalObjectIdentifier(node.expression);
  }
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    return (
      isGlobalObjectIdentifier(node.expression) &&
      arg !== undefined &&
      ts.isStringLiteralLike(arg) &&
      arg.text === "fetch"
    );
  }
  return false;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/**
 * True when `expr` is the ambient `fetch` — directly, as a global access, as an
 * alias (`const f = fetch`), or as a comma/indirect expression (`(0, fetch)`).
 */
function isAmbientFetchExpression(
  expr: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) {
    return node.text === "fetch" || aliases.has(node.text);
  }
  if (isGlobalFetchAccess(node)) return true;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return isAmbientFetchExpression(node.right, aliases);
  }
  return false;
}

/**
 * Identifiers bound to the ambient `fetch` by a simple `const f = fetch`
 * declaration. Computed to a fixpoint so `const a = fetch; const b = a` is
 * caught too.
 */
function collectFetchAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (aliases.has(declaration.name.text)) continue;
      if (
        declaration.initializer !== undefined &&
        isAmbientFetchExpression(declaration.initializer, aliases)
      ) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

/** Name positions (declarations, property names) are not value references. */
function inNamePosition(node: ts.Node, parent: ts.Node | undefined): boolean {
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isEnumMember(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
  );
}

/** Type-only positions (`typeof fetch`, `fetch as T` at the type level). */
function inTypePosition(parent: ts.Node | undefined): boolean {
  return (
    parent !== undefined &&
    (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent))
  );
}

/**
 * Every raw ambient-`fetch` reference in one source string, with 1-based line
 * numbers. One entry per line (the pre-AST guard was line-scoped; keeping that
 * shape avoids duplicate entries for a call whose callee and identifier share a
 * line).
 */
export function findRawFetchRefs(source: string): RawRef[] {
  const sf = parse(source);
  const aliases = collectFetchAliases(sf);
  const parents = buildParentMap(sf);
  const byLine = new Map<number, RawRef>();

  const record = (node: ts.Node): void => {
    const start = node.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    if (!byLine.has(line)) byLine.set(line, { line, text: lineTextOf(source, line) });
  };

  const visit = (node: ts.Node): void => {
    const parent = parents.get(node);
    if (
      ts.isIdentifier(node) &&
      node.text === "fetch" &&
      !inNamePosition(node, parent) &&
      !inTypePosition(parent)
    ) {
      record(node);
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isGlobalFetchAccess(node) &&
      !inNamePosition(node, parent) &&
      !inTypePosition(parent)
    ) {
      record(node);
    }
    if (ts.isCallExpression(node) && isAmbientFetchExpression(node.expression, aliases)) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Every direct-protocol import/require/dynamic-import in one source string. */
export function findDereferenceImportRefs(source: string): RawRef[] {
  const sf = parse(source);
  const byLine = new Map<number, RawRef>();

  const record = (node: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (!byLine.has(line)) byLine.set(line, { line, text: lineTextOf(source, line) });
  };

  const isProtocolSpecifier = (expression: ts.Expression | undefined): boolean =>
    expression !== undefined &&
    ts.isStringLiteralLike(expression) &&
    DEREFERENCE_MODULES.has(expression.text);

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      DEREFERENCE_MODULES.has(node.moduleSpecifier.text)
    ) {
      record(node);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (
        ts.isExternalModuleReference(ref) &&
        ref.expression !== undefined &&
        ts.isStringLiteralLike(ref.expression) &&
        DEREFERENCE_MODULES.has(ref.expression.text)
      ) {
        record(node);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && isProtocolSpecifier(node.arguments[0])) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...byLine.values()].sort((a, b) => a.line - b.line);
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

type Violation = RawRef & { readonly file: string; readonly kind: "fetch" | "import" };

/** Every raw-egress reference in a non-allowlisted `server/src` module. */
function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    if (!FETCH_ALLOWLISTED.has(file)) {
      for (const ref of findRawFetchRefs(source)) {
        violations.push({ file, kind: "fetch", ...ref });
      }
    }
    if (!IMPORT_ALLOWLISTED.has(file)) {
      for (const ref of findDereferenceImportRefs(source)) {
        violations.push({ file, kind: "import", ...ref });
      }
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

  test("the detector catches computed access, aliasing, comma calls, and multi-line calls", () => {
    // M3 evasion cases: each of these defeats a line-scoped `fetch(` regex.
    assert.deepEqual(findRawFetchRefs('await globalThis["fetch"](u);'), [
      { line: 1, text: 'await globalThis["fetch"](u);' },
    ]);
    assert.deepEqual(findRawFetchRefs("const f = fetch; f(u);"), [
      { line: 1, text: "const f = fetch; f(u);" },
    ]);
    assert.deepEqual(findRawFetchRefs("const f = fetch;\nawait f(u);"), [
      { line: 1, text: "const f = fetch;" },
      { line: 2, text: "await f(u);" },
    ]);
    assert.deepEqual(findRawFetchRefs("(0, fetch)(u);"), [
      { line: 1, text: "(0, fetch)(u);" },
    ]);
    assert.deepEqual(findRawFetchRefs("await fetch(\n  url,\n  init,\n);"), [
      { line: 1, text: "await fetch(" },
    ]);
    // Transitive alias.
    assert.deepEqual(findRawFetchRefs("const a = fetch; const b = a;\nb(u);"), [
      { line: 1, text: "const a = fetch; const b = a;" },
      { line: 2, text: "b(u);" },
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
    assert.deepEqual(findRawFetchRefs("const fn: typeof fetch = makeFn();"), []);
    assert.deepEqual(findRawFetchRefs("// call fetch(url) here"), []);
    assert.deepEqual(findRawFetchRefs("/* fetch(url) */"), []);
    // A block comment's newlines are preserved so later line numbers stay true.
    assert.deepEqual(findRawFetchRefs("/* a\n fetch(url)\n b */\nawait fetch(url);"), [
      { line: 4, text: "await fetch(url);" },
    ]);
  });

  test("template text is not code, but server-side fetch in the same file is flagged", () => {
    // The browser-side fetch lives in template TEXT, which the AST never parses,
    // so no allowlist is needed for the server-rendered HTML pages.
    const page = "const html = `<script>await fetch('/x');</script>`;\n";
    assert.deepEqual(findRawFetchRefs(page), []);
    // A genuine server-side fetch in the SAME file is still caught — this is
    // exactly what the old whole-file allowlist let pass silently.
    const mixed = page + "await fetch('/server');\n";
    assert.deepEqual(findRawFetchRefs(mixed), [
      { line: 2, text: "await fetch('/server');" },
    ]);
    // A fetch inside a `${...}` substitution runs at render time: flag it.
    const substituted = "const html = `<script>${fetch('/at-render')}</script>`;\n";
    assert.deepEqual(findRawFetchRefs(substituted), [
      { line: 1, text: "const html = `<script>${fetch('/at-render')}</script>`;" },
    ]);
  });

  test("the detector flags direct protocol imports but not facade importers", () => {
    assert.deepEqual(findDereferenceImportRefs('import { request } from "node:https";'), [
      { line: 1, text: 'import { request } from "node:https";' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('import { Agent } from "undici";'), [
      { line: 1, text: 'import { Agent } from "undici";' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('import { connect } from "node:net";'), [
      { line: 1, text: 'import { connect } from "node:net";' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('import { connect } from "node:tls";'), [
      { line: 1, text: 'import { connect } from "node:tls";' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('import { createServer } from "node:http";'), [
      { line: 1, text: 'import { createServer } from "node:http";' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('const net = require("node:net");'), [
      { line: 1, text: 'const net = require("node:net");' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('await import("undici");'), [
      { line: 1, text: 'await import("undici");' },
    ]);
    assert.deepEqual(findDereferenceImportRefs('import { fetch } from "./egress/client.ts";'), []);
    assert.deepEqual(findDereferenceImportRefs('import { lookup } from "node:dns/promises";'), []);
  });

  test("every server/src module routes egress through the facade", () => {
    const violations = findViolations();
    assert.deepEqual(
      violations,
      [],
      violations.length === 0
        ? "no raw egress references"
        : `raw server-side egress outside the allowlist:\n${violations
            .map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`)
            .join("\n")}\nUse EgressClient (server/src/egress/client.ts) instead, ` +
            "or add a justified entry to the appropriate allowlist if this is a " +
            "browser-side or implementation-site false positive.",
    );
  });

  test("the allowlist rationale is non-empty for every entry", () => {
    for (const entry of FETCH_ALLOWLIST) {
      assert.ok(entry.reason.trim().length > 0, `${entry.file} needs a reason`);
    }
    for (const entry of DEREFERENCE_IMPORT_ALLOWLIST) {
      assert.ok(entry.reason.trim().length > 0, `${entry.file} needs a reason`);
    }
  });
});
