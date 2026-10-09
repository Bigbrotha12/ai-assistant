import { Hono } from "hono";
import { injectToken, loadPageTemplate, scriptStringLiteral } from "./page_template.ts";

/**
 * Self-contained HTML page for completing a password reset. better-auth's
 * default flow redirects through `/api/auth/reset-password/:token` with a
 * callbackURL; the companion app has no deep-link handling, so instead the
 * emailed link points at `GET /reset-password?token=…` (built in auth/index.ts).
 *
 * The markup lives in pages/reset-password.html; it posts `{ token, newPassword }`
 * to the better-auth wire route (`POST /api/auth/reset-password`) and owns the
 * whole user experience — no client assets, no framework. The token is injected
 * as a JS string literal via `injectToken` — never via `hono/html`, whose
 * escaping would corrupt the token in script-data state.
 */
const template = loadPageTemplate(new URL("./pages/reset-password.html", import.meta.url));

function renderPage(token: string): string {
  return injectToken(template, scriptStringLiteral(token));
}

/** Path of the reset page; the emailed link and this route must match. */
export const RESET_PASSWORD_PATH = "/reset-password";

export function createResetPasswordRoutes(): Hono {
  const app = new Hono();
  app.get(RESET_PASSWORD_PATH, (c) => {
    const token = c.req.query("token") ?? "";
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(renderPage(token));
  });
  return app;
}
