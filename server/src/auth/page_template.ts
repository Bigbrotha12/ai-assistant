import { readFileSync } from "node:fs";

/** Placeholder in a page template, replaced by the token's JS string literal. */
const TOKEN_PLACEHOLDER = "/*__TOKEN__*/";

/**
 * Reads a co-located HTML page template once at import time. Throws when the
 * token placeholder is absent so a malformed template fails at boot instead of
 * silently rendering a page with no token.
 */
export function loadPageTemplate(url: URL): string {
  const template = readFileSync(url, "utf8");
  if (!template.includes(TOKEN_PLACEHOLDER)) {
    throw new Error(`auth page template is missing ${TOKEN_PLACEHOLDER}: ${url.pathname}`);
  }
  return template;
}

/**
 * Serializes a value as a JS string literal that is safe inside a `<script>`
 * block. `JSON.stringify` handles quoting/escaping; `<` is neutralized so a
 * value can never close the script element. (HTML entities are NOT decoded in
 * script-data state, so this cannot be done with `hono/html` interpolation.)
 */
export function scriptStringLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Substitutes the token literal into a pre-loaded template. The replacer is a
 * function so `$`-sequences in the literal are never interpreted as special
 * replacement patterns.
 */
export function injectToken(template: string, literal: string): string {
  return template.replace(TOKEN_PLACEHOLDER, () => literal);
}
