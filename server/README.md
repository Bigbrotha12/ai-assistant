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

The primary dev workflow is a single command from the repo root:

```bash
./dev.sh
```

It creates `server/.env` (generating `BETTER_AUTH_SECRET` and defaulting
`BETTER_AUTH_URL`/`INFERENCE_URL` for a local stack), installs dependencies,
runs the migrations, starts the gateway in the background, and tears the whole
stack down on exit. See the root [README](../README.md).

To run the server standalone:

```bash
cd server
cp .env.example .env            # then edit the values (see env table below)
npm install
npm run migrate                 # creates the SQLite schema (better-auth CLI discovers src/auth.ts)
npm run dev                     # starts on PORT (default 17600)
```

Run `npm run migrate` **before** `npm start`/`npm run dev`: the server boots
fine without a schema, but every request that touches the database (auth
sign-up/sign-in, API-key mint) fails until the tables exist.

`npm run migrate` first runs the better-auth CLI (`auth`, the v1.7 CLI package — the old
`@better-auth/cli` is deprecated and only supports better-auth ≤ 1.6), then chained
`npm run migrate:ledger` (a small `tsx src/migrate-ledger.ts` script) which migrates the
ledger DB to the current schema via `PRAGMA user_version`. So one command covers both
databases. Equivalent manual invocation: `npx auth migrate`. It creates `DB_PATH` (default
`./data/gateway.db`) with the `user`, `session`, `account`, `verification`, and
`apikey` tables, and `LEDGER_DB_PATH` with the ledger tables (`ledger_task`,
`ledger_step`, `ledger_chain`). Use `npx auth migrate --yes` to skip the interactive
confirmation (e.g. in scripts/CI), and run `npm run migrate:ledger` on its own when only
the ledger needs migrating.

## Environment

| Variable            | Required | Default                | Description                                                                    |
| ------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`| yes      | —                      | HMAC/verification secret, **≥ 32 chars**. `openssl rand -base64 32`.           |
| `BETTER_AUTH_URL`   | yes      | —                      | Public base URL of the gateway, e.g. `http://localhost:17600`.                   |
| `INFERENCE_URL`     | yes      | `http://localhost:9090` | Base URL of the OpenAI-compatible engine (llama.cpp proxy; 9090 = Qwen3-14B, see `~/Documents/homelab/podman/queues`). Must NOT equal this gateway's port. Edit in `server/.env` to override. |
| `PORT`              | no       | `17600`                | Gateway port (the Flutter app derives this as its backend base).                |
| `DB_PATH`           | no       | `./data/gateway.db`    | SQLite file for better-auth (dev only).                          |
| `LEDGER_DB_PATH`    | no       | `./data/ledger.db`    | **Dedicated** SQLite file for the task ledger (§ Task ledger below). |
| `LEDGER_STUCK_TIMEOUT_MS`| no | `10000`               | Heartbeat silence that marks a task `stuck`. **Must be < lease.** |
| `LEDGER_LEASE_EXPIRY_MS`| no  | `60000`               | Worker lease expiry. Final tuning is Phase 4 (M5).               |
| `PLUGINS_STORE_PATH`    | no  | `./data/plugins.json` | JSON file persisting admin-installed tool-plugin manifests (Phase 1). Recreated empty on first boot. |
| `PLUGINS_TRUSTED_HOSTS` | no  | `""`                  | Comma-separated hostnames/IPs that bypass SSRF private-range rejection for plugin baseUrls (admin-trusted internal hosts, e.g. `vikunja.local`, `*.local`). Scheme enforcement (`https` in production) is never bypassed. |
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

## Task ledger (`/ledger/*`)

The gateway owns a durable, gateway-side task ledger (M1 of
`docs/production-grade-improvement-plan.md` §3.3). It records worker steps,
heartbeats/lease, a write-once hash chain, and owner binding.

**Dedicated DB (decision).** The ledger lives in its own SQLite file
(`LEDGER_DB_PATH`, default `./data/ledger.db`), *separate* from the better-auth
DB (`DB_PATH`). It is append-only, write-once, and versioned independently via
`PRAGMA user_version`; coupling it to the auth DB would entangle two schemas
with unrelated lifecycles and force auth migrations to know about ledger
tables. A dedicated file also lets ledger migrations evolve without touching
the auth admin surface (user/session/apikey).

**Design notes.**
- `status` ∈ `queued | running | succeeded | failed | cancelled | stuck |
  awaiting_review`. Transitions are validated (`assertTransition`):
  `queued → running` (claim); `running → succeeded|failed|cancelled|stuck|
  awaiting_review`; `stuck/awaiting_review → running` (resume).
- **Threshold ordering is FIXED**: `LEDGER_STUCK_TIMEOUT_MS <
  LEDGER_LEASE_EXPIRY_MS` (default stuck 10s < lease 60s), enforced in the
  `Ledger` constructor (throws `INVALID_CONFIG` otherwise). Final tuning is
  Phase 4 (M5).
- **Append-only**: `ledger_step` and `ledger_chain` have `BEFORE UPDATE/DELETE`
  triggers that reject mutation; `ledger_task` is the only mutable table.
- **Hash chain**: each `ledger_chain` record is `sha256(prev_digest +
  canonical step content + gateway ts)`, committed atomically with the step
  append. First record's `prev_digest` is a per-task genesis. `verifyChain`
  recomputes the chain and returns `false` on any tampering.
- **Clock discipline**: step `ts` and heartbeats are stamped by the gateway
  (`Date.now()`), never by the worker.
- **Owner binding**: `createTask` sets `owner` (the API-key user id, via
  `requireApiKey`); `appendStep`/`heartbeat`/`resumeTask` re-validate ownership
  and reject non-owners (`FORBIDDEN`).
- `intentKey` is stored raw with **no unique constraint** — canonicalization
  and the unique constraint land in Phase 6 (M12).

Endpoints (all require `Authorization: Bearer <api-key>`; owner is the key's
user id):

| Endpoint                        | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `POST /ledger/tasks`            | Create a task (`intentKey` required; `spec`, `worker` optional). |
| `GET  /ledger/tasks`            | List tasks.                                                    |
| `GET  /ledger/tasks/:id`        | Get a task with its steps + chain.                             |
| `POST /ledger/tasks/:id/claim`  | Take the lease; `queued → running`.                            |
| `POST /ledger/tasks/:id/steps`  | Append a step + chain record (task must be `running`).         |
| `POST /ledger/tasks/:id/heartbeat` | Renew the lease (owner must hold it).                       |
| `POST /ledger/tasks/:id/resume` | Resume a `stuck`/`awaiting_review` task (owner only).          |
| `POST /ledger/tasks/:id/complete` | Set a terminal status (`succeeded|failed|cancelled|awaiting_review`). |

**Tests.** `npm test` runs the suite with Node's built-in runner via `tsx`
(`tsx --test test/**/*.test.ts`). It covers lifecycle transitions,
stuck<lease ordering, sequence-aware loop detection (`findLoop`), hash-chain
verification + tamper detection, owner binding, and migration (fresh + upgrade
+ idempotency). `npm run typecheck` covers `src/` and `test/`.

## Plugin store (`/v1/plugins`, Phase 1)

Phase 1 of the backend LangChain plan (`docs/backend-langchain-plan.md`)
introduces a plugin system foundation under `server/src/plugins/`:

- `types.ts` — zod-validated `PluginDefinition` (tool + model) + store schema.
- `ssrf.ts` — SSRF allowlist validation (scheme, private/loopback/metadata
  ranges, DNS-rebinding defense, `redirect: "manual"`).
- `store.ts` — `PluginStore`: persists which **tool-plugin manifests** are
  installed as JSON (`PLUGINS_STORE_PATH`). Missing file → empty store written
  with `schemaVersion` (fail-fast on mismatch). `install`/`uninstall` operate
  **on manifests only** — builtins ship in the build, are always available and
  can never be uninstalled (no disabling toggle in Phase 1). Every allowlisted
  baseUrl is SSRF-validated on install; admin-trusted internal hosts are
  listed in `PLUGINS_TRUSTED_HOSTS`. Saves are atomic (temp file + rename) at
  `0600`, and credentials are persisted spec-only (label/required flags) —
  credential **values** are never written.
- `registry.ts` — `PluginRegistry` (lifecycle view): redacted public list
  (`baseUrls` id+label only; model `endpoint` omitted) vs. auth-gated details
  (full URLs), `requirePlugin` with actionable `PLUGIN_NOT_FOUND`/
  `PLUGIN_DISABLED` errors, `hotReload()` + a debounced `fs.watch` on the store
  file that never fights the store's own saves.
- `index.ts` — composition root wiring env + bundled builtins +
  `availableToolManifests` (both owned by the build artifact).

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