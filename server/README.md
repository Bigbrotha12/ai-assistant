# AI Assistant Gateway (`server/`)

Thin, text-only gateway for the AI Assistant Flutter app. It owns **authentication**
(better-auth at `/api/auth/*`) and **text inference** (an OpenAI-compatible proxy at
`/v1/*` that authenticates and forwards to the engine configured via `INFERENCE_URL`).
The gateway never sees audio.

- Runtime: Node 20+ (Hono + TypeScript, executed with `tsx`)
- Auth: better-auth (`emailAndPassword`), `apiKey` plugin from `@better-auth/api-key`,
  `bearer` plugin from `better-auth/plugins`, and the built-in `rateLimit` option
  (a core better-auth option since v1.7 — no longer a plugin)
- Database: SQLite via `better-sqlite3` for dev (Postgres swap documented below)

## Setup

```bash
cd server
cp .env.example .env            # then edit the values (see env table below)
npm install
npm run migrate                 # creates the SQLite schema (better-auth CLI discovers src/auth.ts)
npm run dev                     # starts on PORT (default 9091)
```

Run `npm run migrate` **before** `npm start`/`npm run dev`: the server boots
fine without a schema, but every request that touches the database (auth
sign-up/sign-in, API-key mint) fails until the tables exist.

`npm run migrate` runs the better-auth CLI (`auth`, the v1.7 CLI package — the old
`@better-auth/cli` is deprecated and only supports better-auth ≤ 1.6). Equivalent
manual invocation: `npx auth migrate`. It creates `DB_PATH` (default
`./data/gateway.db`) with the `user`, `session`, `account`, `verification`, and
`apikey` tables. Use `npx auth migrate --yes` to skip the interactive confirmation
(e.g. in scripts/CI).

## Environment

| Variable            | Required | Default                | Description                                                                    |
| ------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`| yes      | —                      | HMAC/verification secret, **≥ 32 chars**. `openssl rand -base64 32`.           |
| `BETTER_AUTH_URL`   | yes      | —                      | Public base URL of the gateway, e.g. `http://localhost:9091`.                   |
| `INFERENCE_URL`     | yes      | —                      | Base URL of the OpenAI-compatible engine. Must NOT equal this gateway's port.   |
| `PORT`              | no       | `9091`                 | Gateway port (the Flutter app derives this as its backend base).                |
| `DB_PATH`           | no       | `./data/gateway.db`    | SQLite file (dev only).                                                         |
| `INFERENCE_RATE_LIMIT`| no     | `60`                   | `/v1/chat/completions` sustained rate (requests/minute per API key).             |
| `INFERENCE_RATE_BURST`| no     | `20`                   | `/v1/chat/completions` burst ceiling (consecutive requests allowed at once).     |
| `NODE_ENV`          | no       | `development`          | `production` switches on secure cookies.                                        |

The server refuses to start on invalid/missing env (fails fast). The `migrate`
script also reads these via dotenv, so `.env` must exist before migrating.

## API contract

Auth (better-auth standard endpoint + shape, all under the gateway base URL):

| Endpoint                                  | Auth            | Purpose                                        |
| ----------------------------------------- | --------------- | ---------------------------------------------- |
| `GET  /api/auth/ok`                       | none            | Health check → `{"status":"ok"}`. |
| `POST /api/auth/sign-up/email`            | none            | Body `{ name, email, password }`.              |
| `POST /api/auth/sign-in/email`            | none            | Body `{ email, password }` → response contains **`token`** (session token). |
| `POST /api/auth/sign-out`                 | session         | Revokes current session.                       |
| `GET  /api/auth/get-session`              | session         | Current session (`Authorization: Bearer <token>` or session cookie). |

> **Note:** better-auth 1.7's own `/api/auth/ok` returns `{"ok":true}`. This gateway
> shadows that route with an explicit Hono handler that returns the documented
> `{"status":"ok"}` shape.

API key mint/list (better-auth `apiKey` plugin default endpoints; session auth
= session cookie **or** `Authorization: Bearer <session-token>`):

| Endpoint                                        | Purpose                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/auth/api-key/create`                 | Mint a key. Response `key` is the full prefixed key (returned once, cannot be retrieved later). |
| `GET  /api/auth/api-key/list`                   | List keys (only `start`, `prefix`, `name`, `expiresAt`… — never the raw key). |
| `GET  /api/auth/api-key/get`                    | Get a single key by id.                                                 |
| `POST /api/auth/api-key/update`                 | Update name/enabled/expiry.                                             |
| `POST /api/auth/api-key/delete`                 | Revoke a key.                                                           |
| `POST /api/auth/api-key/delete-all-expired-api-keys` | Housekeeping.                                                      |

`POST /api/auth/api-key/verify` is **not** on the wire — the `@better-auth/api-key`
plugin registers it server-only, so the app must call `auth.api.verifyApiKey`
internally (as the inference routes do); an HTTP request to it returns 404.
The same applies to `delete-all-expired-api-keys`.

Keys are long-lived (1 year expiry), revocable via `api-key/delete`. Creation
returns the full key **once** (top-level `key` in the response); the app should
store it immediately (e.g. `flutter_secure_storage`) — same flow as the
onboarding plan (§3.3).

Inference (OpenAI-compatible; `Authorization: Bearer <api-key>` — the **API key**,
not the session token):

| Endpoint                  | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `GET  /v1/auth/check`     | API-key validity check (no upstream call). `200 {"status":"ok"}` with a valid key, else `401 {"error":"unauthorized"}`. |
| `POST /v1/chat/completions` | Forwarded to `${INFERENCE_URL}/v1/chat/completions`. SSE passthrough. |
| `GET  /v1/models`         | Forwarded to `${INFERENCE_URL}/v1/models`.                           |

Invalid or missing key → `401 {"error":"unauthorized"}`. Upstream unreachable →
`502 {"error":"inference_unavailable"}`. `POST /v1/chat/completions` is
rate-limited per API key with an in-memory token bucket
(`INFERENCE_RATE_LIMIT` sustained requests/minute, `INFERENCE_RATE_BURST`
burst ceiling); exceeding it → `429 {"error":"rate_limited"}`. No CORS headers
are set (this is a desktop/mobile client, not a browser).

### Streaming (SSE)

`POST /v1/chat/completions` forwards the original JSON body verbatim (so
`"stream": true` reaches the engine) and returns the **raw upstream response**
`ReadableStream`, status, and `content-type` (`text/event-stream`) without
buffering. The Flutter client consumes the SSE events (`data: {…}` lines, `[DONE]`
terminator) directly; nothing is re-encoded or accumulated.

## Typical app flow

1. Sign up or sign in → keep `token` (and the session cookie).
2. Mint a per-user API key: `POST /api/auth/api-key/create` with
   `Authorization: Bearer <token>`; persist the response's top-level `key`.
3. All inference calls: `POST /v1/chat/completions` with
   `Authorization: Bearer <api-key>`.
4. On `401`, re-sign-in and rotate the key (revoke the old one via `api-key/delete`).

## Production notes

- **Postgres**: swap the SQLite adapter in `src/auth.ts` for a `pg` Pool
  (`import { Pool } from "pg"; database: new Pool({ connectionString: … })`).
  Run `npx auth generate` against a Postgres config, or
  `npx auth migrate` with `DATABASE_URL`/`PG*` env set —
  then delete the SQLite file. better-auth's built-in Kysely adapter handles
  both; no other code changes are required.
- **Cookies/host**: `BETTER_AUTH_URL` must be the public HTTPS origin; set
  `NODE_ENV=production` so `advanced.useSecureCookies` is on.
- **Secrets**: `BETTER_AUTH_SECRET` from a secret manager; never commit `.env`.
- **Rate limiting**: the built-in `rateLimit` option (window 60s / 100 requests).
  It is enabled even in development (`enabled: true`) and uses in-memory storage by
  default. Behind a proxy, better-auth falls back to a single shared per-path bucket
  unless it can resolve a client IP — set `advanced.ipAddress.ipAddressHeaders` /
  `advanced.ipAddress.trustedProxies` in `src/auth.ts`. For multi-instance
  deployments use `storage: "database"` or `"secondary-storage"` (Redis) instead of
  the default `"memory"`.
- **Inference rate limiting**: `/v1/chat/completions` uses an in-memory
  per-API-key token bucket (`INFERENCE_RATE_LIMIT` / `INFERENCE_RATE_BURST`). It
  is per-process and not shared across instances — acceptable for a single
  gateway; scale out needs a shared limiter (e.g. Redis) instead.
- **API keys**: the `@better-auth/api-key` plugin (separate package since better-auth
  1.7). The gateway configures `defaultPrefix: "sk"`, `defaultKeyLength: 32`,
  `keyExpiration.defaultExpiresIn` (1 year, in **milliseconds**), and
  `rateLimit: { enabled: false }` — the plugin's default per-key cap (10
  verifications/24h) is disabled so the gateway's own per-key inference limiter
  (`INFERENCE_RATE_LIMIT`/`INFERENCE_RATE_BURST`) is the effective throttle.
  Note the option names changed from the pre-1.7 plugin
  (`prefix`/`length`/`expiresIn`).
- **Key handling**: API keys are stored SHA-256-hashed by better-auth; verify
  happens per-request through `auth.api.verifyApiKey`.