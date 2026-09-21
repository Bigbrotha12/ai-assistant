import { Hono } from "hono";

/**
 * Self-contained HTML page for completing a password reset. better-auth's
 * default flow redirects through `/api/auth/reset-password/:token` with a
 * callbackURL; the companion app has no deep-link handling, so instead the
 * emailed link points at `GET /reset-password?token=…` (built in auth.ts).
 *
 * The page posts `{ token, newPassword }` to the better-auth wire route
 * (`POST /api/auth/reset-password`) and is responsible for the whole user
 * experience — no client assets, no framework. The active token is injected
 * into the initial form from the query string.
 *
 * Built as a plain string rather than via `hono/html`: the template helper
 * HTML-escapes interpolations, which would corrupt the token inside the
 * <script> block (HTML entities are NOT decoded in script-data state).
 */
function renderPage(token: string): string {
  // JSON-encode then neutralize the < that could close the script element.
  // better-auth tokens are alphanumeric, so the replacement is belt-and-braces.
  const tokenLiteral = JSON.stringify(token).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reset password — AI Assistant</title>
    <style>
      body {
        margin: 0;
        padding: 0 24px;
        background: #f4f4f5;
        color: #18181b;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        background: #fff;
        border: 1px solid #e4e4e7;
        border-radius: 12px;
        padding: 32px;
        width: 100%;
        max-width: 380px;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
      }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { color: #52525b; font-size: 14px; margin: 0 0 20px; }
      label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
      input {
        box-sizing: border-box;
        width: 100%;
        padding: 10px 12px;
        font-size: 14px;
        border: 1px solid #d4d4d8;
        border-radius: 8px;
      }
      button {
        width: 100%;
        margin-top: 20px;
        padding: 11px;
        border: 0;
        border-radius: 8px;
        background: #18181b;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      .msg { margin-top: 16px; font-size: 14px; border-radius: 8px; padding: 10px 12px; display: none; }
      .msg.ok { display: block; background: #dcfce7; color: #166534; }
      .msg.err { display: block; background: #fee2e2; color: #991b1b; }
      .hint { margin-top: 12px; font-size: 12px; color: #71717a; }
    </style>
  </head>
  <body>
    <form id="form" class="card" novalidate>
      <h1>Reset your password</h1>
      <p>Enter a new password for your AI Assistant account.</p>
      <label for="pw">New password</label>
      <input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required />
      <label for="pw2">Confirm password</label>
      <input id="pw2" name="confirm" type="password" autocomplete="new-password" minlength="8" required />
      <button id="submit" type="submit">Update password</button>
      <div id="msg" class="msg"></div>
      <p class="hint">Passwords must be at least 8 characters. After resetting, sign in from the app with your new password.</p>
    </form>
    <script>
      const token = ${tokenLiteral};
      const form = document.getElementById("form");
      const msg = document.getElementById("msg");
      const submit = document.getElementById("submit");
      function show(outcome, text) {
        msg.className = "msg " + outcome;
        while (msg.firstChild) msg.removeChild(msg.firstChild);
        const p = document.createElement("p");
        p.textContent = text;
        msg.appendChild(p);
      }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pw = document.getElementById("pw").value;
        const pw2 = document.getElementById("pw2").value;
        if (pw.length < 8) return show("err", "Password must be at least 8 characters.");
        if (pw !== pw2) return show("err", "Passwords do not match.");
        submit.disabled = true;
        try {
          const res = await fetch("/api/auth/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, newPassword: pw }),
          });
          if (!res.ok) {
            let text = "Could not reset the password. The link may be invalid or expired.";
            try {
              const body = await res.json();
              if (body && body.message) text = body.message;
            } catch { /* non-JSON error body; keep default */ }
            submit.disabled = false;
            return show("err", text);
          }
          document.querySelectorAll("input").forEach((i) => (i.disabled = true));
          show("ok", "Password updated. You can now sign in from the app with your new password.");
        } catch {
          submit.disabled = false;
          show("err", "Network error. Please try again.");
        }
      });
    </script>
  </body>
</html>`;
}

export function createResetPasswordRoutes(): Hono {
  const app = new Hono();
  app.get("/reset-password", (c) => {
    const token = c.req.query("token") ?? "";
    return c.html(renderPage(token));
  });
  return app;
}