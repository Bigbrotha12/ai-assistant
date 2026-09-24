# AI Assistant Gateway (`server/`)

LangChain gateway for the AI Assistant Flutter app. It owns **authentication**
(better-auth at `/api/auth/*`) and **inference orchestration**: an OpenAI-compatible
`/v1/*` surface backed by a LangGraph agent graph (plugin model + tool execution,
budget, idempotency). It resolves model/tool plugins from the request body and calls
provider APIs itself — there is no upstream proxy. The gateway never sees audio.

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
`BETTER_AUTH_URL` for a local stack), installs dependencies,
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

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | yes | — | HMAC/verification secret, **≥ 32 chars**; generate with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | yes | — | Public base URL of the gateway, e.g. `http://localhost:17600`. |
| `PORT` | no | `17600` | Gateway port (the Flutter app derives this as its backend base). |
| `DB_PATH` | no | `./data/gateway.db` | SQLite file for better-auth (development default). |
| `CONFIG_DIR` | no | `/config` | Directory containing mounted skill, MCP, and agent-template catalogs; `.env.example` uses `./config` for local development. |
| `INFERENCE_RATE_LIMIT` | no | `60` | `/v1/chat/completions` sustained rate (requests/minute **per user**). |
| `INFERENCE_RATE_BURST` | no | `20` | `/v1/chat/completions` burst ceiling. |
| `BUDGET_MAX_CONCURRENT` | no | `2` | Per-user in-flight chat cap (sync streams and background jobs share the pool). |
| `BUDGET_QUEUE_MAX` | no | `3` | Per-user background queue depth before rejection (`503 busy` + `Retry-After`). |
| `BUDGET_MODEL_CALL_LIMIT` | no | `60` | Maximum model calls per owner within the configured window. |
| `BUDGET_MODEL_CALL_WINDOW_MS` | no | `60000` | Rolling per-owner model-call budget window in milliseconds. |
| `CONTEXT_TOKEN_LIMIT` | no | `32768` | Context/session token ceiling used by context and session-size management. |
| `AGENT_SKILL_BUDGET_TOKENS` | no | `6000` | Skill-injection token budget when composing an agent prompt. |
| `AGENT_SPEC_MAX_SYSTEM_PROMPT` | no | `8000` | Maximum custom-agent system-prompt size. |
| `AGENT_SPEC_MAX_SKILLS` | no | `50` | Maximum skill references in a custom-agent spec. |
| `AGENT_SPEC_MAX_MCPS` | no | `20` | Maximum MCP references in a custom-agent spec. |
| `AGENT_SPEC_MAX_TOOLS` | no | `100` | Maximum tool grants in a custom-agent spec. |
| `WARMUP_ENABLED` | no | `false` | Enables startup/request tool warmups. |
| `WARMUP_MAX_CONCURRENT` | no | `2` | Maximum concurrent warmup operations. |
| `WARMUP_TIMEOUT_MS` | no | `10000` | Per-warmup timeout in milliseconds. |
| `MODEL_CALL_TIMEOUT_MS` | no | `60000` | Outbound model-call timeout in milliseconds. |
| `TOOL_CALL_TIMEOUT_MS` | no | `60000` | Outbound plugin-tool-call timeout in milliseconds. |
| `MCP_CALL_TIMEOUT_MS` | no | `15000` | Per-call MCP JSON-RPC timeout in milliseconds. |
| `MAX_REQUEST_BODY_BYTES` | no | `10000000` | Maximum body size for non-establish chat requests. |
| `MAX_ESTABLISH_BODY_BYTES` | no | `25000000` | Maximum body size for session-establish requests. |
| `LEDGER_DB_PATH` | no | `./data/ledger.db` | **Dedicated** SQLite file for the task ledger (§ Task ledger below). |
| `LEDGER_STUCK_TIMEOUT_MS` | no | `10000` | Heartbeat silence that marks a task `stuck`; must be less than the lease timeout. |
| `LEDGER_LEASE_EXPIRY_MS` | no | `60000` | Worker lease expiry. |
| `LEDGER_RETENTION_MS` | no | `86400000` | Retention period for terminal ledger tasks and their steps/chain. |
| `LEDGER_SWEEP_INTERVAL_MS` | no | `3600000` | Interval between ledger retention sweeps. |
| `NOTIFY_STORE_KEY` | prod | *(dev default, warned)* | AES-256-GCM key for the notify store (ntfy topic and access token at rest); required when `NODE_ENV=production`. |
| `SMTP_HOST` | no | `""` | SMTP relay host; empty disables sending and logs the link in development. |
| `SMTP_PORT` | no | `587` | SMTP relay port. |
| `SMTP_USER` | no | `""` | SMTP relay username. |
| `SMTP_PASS` | no | `""` | SMTP relay password. |
| `SMTP_FROM` | no | `""` | From address for password-reset and email-verification mail. |
| `NOTIFY_BASE_URL` | no | `""` | ntfy base URL; empty disables push delivery while provisioning endpoints remain available. |
| `PLUGINS_STORE_PATH` | no | `./data/plugins.json` | JSON file persisting admin-installed tool-plugin manifests. |
| `PLUGINS_TRUSTED_HOSTS` | no | `""` | Comma-separated hostnames/IPs that bypass SSRF private-range rejection for plugin base URLs; scheme enforcement is not bypassed. |
| `MCP_TRUSTED_HOSTS` | no | `""` | Comma-separated admin-vouched MCP hostnames/IPs; internal MCP services may use HTTP in production. |
| `DEFAULT_MODEL_PROVIDER_BASE_URL` | no | `https://openrouter.ai/api/v1` | Provider-agnostic base URL for the built-in model plugin. |
| `DEFAULT_MODEL_PROVIDER_MODEL` | no | `openrouter/auto` | Default model name for the built-in model plugin. |
| `LOG_LEVEL` | no | `info` | Console log level: `error`, `warn`, `info`, or `debug`. |
| `NODE_ENV` | no | `development` | Runtime mode; `production` enables secure cookies and production validation. |

> **Single-replica contract (deliberate deployment choice).** The gateway runs
> as **exactly one gateway replica; no overlapping rolling deployments**.
> Process-local deletion tombstones/owner barriers, RAM-only managed sessions
> and per-process tool-cache, budget, and rate-limit state, runner registries,
> and the file-backed notify/ledger stores assume one writer. A second or
> overlapping replica can miss a tombstone, admit work that raced deletion, lose
> session coordination, or
> overwrite a stale notify snapshot. This is a deliberate operational boundary,
> not a temporary gap; multi-replica deletion coordination would be a separate
> distributed-coordination project. There is no in-process replica-count
> detection: an environment flag cannot assert the real replica count, so ops
> must enforce the Deployment and rollout settings.

The server refuses to start on invalid/missing env (fails fast). The `migrate`
script also reads these via dotenv, so `.env` must exist before migrating.

## API contract

Auth (better-auth standard endpoint + shape, all under the gateway base URL):

| Endpoint                                  | Auth            | Purpose                                        |
| ----------------------------------------- | --------------- | ---------------------------------------------- |
| `GET  /api/auth/ok`                       | none            | Health check → `{"status":"ok"}`. |
| `POST /api/auth/sign-up/email`            | none            | Body `{ name, email, password }`. Fresh signup gets `token: null` and **no session** until the email is verified. |
| `POST /api/auth/sign-in/email`            | none            | Body `{ email, password }` → response contains **`token`** (session token). Unverified accounts → `403 email_not_verified` (also triggers a verification resend). |
| `POST /api/auth/sign-out`                 | session         | Revokes current session.                       |
| `GET  /api/auth/get-session`              | session         | Current session (`Authorization: Bearer <token>` or session cookie). |
| `POST /api/auth/send-verification-email`  | none + rate     | Resend the verification mail; custom ≥60s per-address limiter fronts it. |
| `POST /api/auth/delete-user`              | session         | Account deletion (M12); password-confirmed body; cascades apiKeys + notify + ledger rows. |
| `GET  /verify-email?token=…`              | none            | Hono HTML page that runs better-auth's `GET /api/auth/verify-email` wire route (1h signed JWT; never echoed into the DOM). |

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

Keys expire after **90 days** by default (`keyExpiration.defaultExpiresIn` is
in **seconds**: `90*24*60*60`; applies at create — older keys keep their
original expiry until rotated; the app rotates silently after ~60d with a
valid session), revocable via `api-key/delete`. Creation
returns the full key **once** (top-level `key` in the response); the app should
store it immediately (e.g. `flutter_secure_storage`) — same flow as the
onboarding plan (§3.3).

Health (unauthenticated — k8s probes cannot auth):

| Endpoint     | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `GET /health` | `200 {"status":"ok",…}` when auth + ledger DB checks pass, else `503 {"status":"degraded"}`; includes `version`, `uptime`, per-check `ok\|error`. Probe spec: `deploy/k8s/health-probes.yaml` (applied by ops, not repo CI). |

Inference (OpenAI-compatible; `Authorization: Bearer <api-key>` — the **API key**,
not the session token):

| Endpoint                  | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `GET  /v1/auth/check`     | API-key validity check (no upstream call). `200 {"status":"ok"}` with a valid key, else `401 {"error":"unauthorized"}` — or `403 email_not_verified` for an unverified owner (probe surfaces "verify your email"). |
| `POST /v1/chat/completions` | LangGraph agent run streamed as OpenAI-compatible SSE (see `docs/wire-spec.md`). |
| `GET  /v1/models`         | Lists installed MODEL plugins (id + capability flags incl. `visionCapable`); never leaks provider endpoints. |
| `GET  /v1/agents`         | Redacted agent-template summaries (no systemPrompt/skill content/mcp url). |
| `GET  /v1/skills`         | Redacted skill catalog (`id`, `title` only — content never serialized). |
| `GET  /v1/mcps`           | Redacted MCP catalog (`name` only — url/headers never serialized).    |

Invalid or missing key → `401 {"error":"unauthorized"}`. An account deletion
tombstone or owner barrier rejects authenticated API-key and admission paths →
`403 {"error":"account_deleted"}` (distinct from an unverified owner's `403
{"error":"email_not_verified"}`). Upstream unreachable → `502
{"error":"inference_unavailable"}`. `POST /v1/chat/completions` is rate-limited
per owner with an in-memory token bucket (`INFERENCE_RATE_LIMIT` sustained
requests/minute, `INFERENCE_RATE_BURST` burst ceiling); exceeding it → `429
{"error":"rate_limited"}`. No CORS headers are set (this is a desktop/mobile
client, not a browser).

### Streaming (SSE)

`POST /v1/chat/completions` runs the LangGraph agent graph and translates its
events into OpenAI-compatible SSE frames (`server/src/transport/openai.ts`),
emitting a single terminal `data: [DONE]`. The byte-level contract lives in
`docs/wire-spec.md`; the Flutter client parses those frames directly.

## Typical app flow

1. Sign up or sign in → keep `token` (and the session cookie).
2. Mint a per-user API key: `POST /api/auth/api-key/create` with
   `Authorization: Bearer <token>`; persist the response's top-level `key`.
3. All inference calls: `POST /v1/chat/completions` with
   `Authorization: Bearer <api-key>`.
4. On `401`, re-sign-in and rotate the key (revoke the old one via `api-key/delete`).

## Task ledger (`/ledger/*`)

The gateway owns a gateway-side task ledger (M1 of
`docs/archive/production-grade-improvement-plan.md` §3.3). It records worker steps,
heartbeats/lease, a write-once hash chain, and owner binding. Since the stateless
cutover it is a **transient journal**: terminal tasks (and their steps/chain rows)
are swept after the retention window (`LEDGER_RETENTION_MS`, default 24h); it is
not a durable audit log.

**Single-replica contract.** The ledger's SQLite file, its process-local
heartbeat/worker coordination, and deletion admission barriers require
**exactly one gateway replica; no overlapping rolling deployments**. A second
or overlapping process can miss a deletion tombstone or contend for work that
was admitted before deletion. This is a deliberate deployment choice, not a
temporary gap; multi-replica deletion coordination would be a separate
distributed-coordination project.

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
- `intentKey` is stored raw with a **`(owner, intent_key)` unique constraint**
  (migration v4, with dedupe + golden tests); canonicalization was dropped.

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
stuck<lease ordering, hash-chain
verification + tamper detection, owner binding, and migration (fresh + upgrade
+ idempotency). `npm run typecheck` covers `src/` and `test/`.

## Plugin store (`/v1/plugins`, Phase 1)

Phase 1 of the backend LangChain plan (`docs/archive/backend-langchain-plan.md`)
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

## Managed conversations (`/v1/sessions`, stateless gateway)

Conversations run through the stateless-gateway path (plan `docs/archive/stateless-gateway-plan.md`). The client owns the conversation history and sends it on
`POST /v1/chat/completions` with `conversation_mode: "managed"` + a
client-generated `session_id`; the gateway holds only an in-memory, evictable
mirror (`src/sessions/store.ts`, no encryption, no durability, no disk) used
for exactly-once `messageId` dedupe and reply read-back.

**Single-replica contract.** The RAM-only session mirror, its mutexes and
eviction tombstones, and the per-process tool cache, budget, and rate-limit
state require the supported contract:
**exactly one gateway replica; no overlapping rolling deployments**. A second or
overlapping replica can miss the session tombstone and route a turn to a
process that does not hold the caller's state; the client can recover with a
same-`session_id` re-establish, but that is not shared-session coordination.
This is a deliberate deployment choice, not a temporary gap.

- **Establish vs delta** is classified by body shape: a full-history body
  (more than one message) is an establish — the server seeds/replaces the
  session's `messages` under `session_id` (this is also the client's §6
  compaction re-base) and streams `x-conversation-state: seeded`. A
  single-message body against a live session is a delta append
  (`x-conversation-state: resumed`); against a missing, non-tombstoned session
  it is a fresh conversation's first turn and establishes.
- **Session miss:** a delta against a missing/evicted session returns
  `409 { error: "session_missing", reason: "evicted" | "restart" }`; the client
  re-establishes under the SAME `session_id`.
- **Conversation surface:**

| Endpoint                       | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `GET    /v1/sessions/:id`      | Read back the caller's accumulated messages (owner-scoped; cross-owner → `404`, absent → `409 session_missing`). |
| `DELETE /v1/sessions/:id`      | Owner-scoped hard delete; `404 {"error":"not_found"}` if absent. |

The legacy checkpoint surface (`/v1/threads`, `compileGraphWithCheckpointer`,
`checkpointThreadId`) was removed with the sync-path cutover (plan §9); the
client no longer routes through `thread_id`.

## Notify store

The ntfy topic and access token are encrypted at rest by `NotifyStore` in
`./data/notify.json` (or the configured store path) and are provisioned through
`/api/notify`. `NOTIFY_STORE_KEY` supplies the encryption key; `NOTIFY_BASE_URL`
is the optional ntfy base URL, with an empty value disabling push delivery.
The file is atomically replaced with `0600` permissions, and the store keeps a
cached in-process snapshot behind a mutation mutex.

**Single-replica contract.** The notify file, cached snapshot, and mutex require
**exactly one gateway replica; no overlapping rolling deployments**. A second
or overlapping process can write a stale snapshot over a newer credential set
because the file-level coordination is process-local. This is a deliberate
deployment choice, not a temporary gap; multi-replica deletion coordination
would be a separate distributed-coordination project. An environment flag cannot
assert the real replica count, so ops must enforce this in the k3s Deployment
and rollout strategy.

## Production notes

- **Single-replica deployment contract (deliberate, not temporary).** The gateway
  is deployed under the supported contract:
  **exactly one gateway replica; no overlapping rolling deployments**. This
  covers process-local deletion tombstones/owner barriers,
  RAM-only managed sessions and per-process tool-cache, budget, and rate-limit
  state, runner pin/controller registries, and the file-backed notify/ledger
  stores. A second or overlapping process can miss a tombstone, admit work that
  raced deletion, lose session
  coordination, or overwrite a stale notify snapshot. There is no in-process
  way to detect the real replica count: an environment flag cannot assert it, so
  ops must enforce `spec.replicas: 1` and a non-overlapping rollout. Multi-replica
  deletion coordination would be a separate distributed-coordination project.
  Clients recover from a missing managed session with `409 session_missing` and a
  same-`session_id` re-establish, but that is recovery, not shared-session
  coordination.
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
  **per-user** token bucket (`INFERENCE_RATE_LIMIT` / `INFERENCE_RATE_BURST`)
  built by `createPerOwnerRateLimiter` (`src/middleware/rate_limit.ts`): the
  bucket key is the authenticated user id, so a user with many API keys cannot
  rotate keys to bypass a rejection. A rejection returns
  `429 { error: "rate_limited" }` + `Retry-After`. It is per-process and not
  shared across instances — acceptable for a single gateway; scale out needs a
  shared limiter (e.g. Redis) instead.
- **Concurrency budget**: the same route also applies a per-user budget
  (`src/middleware/budget.ts`, `BUDGET_MAX_CONCURRENT`/`BUDGET_QUEUE_MAX`) that
  caps in-flight operations — sync streams and background jobs share one
  per-user pool. Sync with a full pool returns `429 { error: "busy" }` +
  `Retry-After`; an async admission queues on the owner's bounded FIFO (depth
  `BUDGET_QUEUE_MAX`, wait bounded by the budget's `waitMs`) and a full queue
  returns `503 { error: "busy" }` + `Retry-After`. Idempotent replay of the
  same message is NOT blocked here — the task ledger's `(owner, messageId)`
  dedupe handles that.
- **API keys**: the `@better-auth/api-key` plugin (separate package since better-auth
  1.7). The gateway configures `defaultPrefix: "sk"`, `defaultKeyLength: 32`,
  `keyExpiration.defaultExpiresIn` (`90*24*60*60` — **90 days, in seconds**;
  better-auth's unit for this option is seconds, not milliseconds), and
  `rateLimit: { enabled: false }` — the plugin's default per-key cap (10
  verifications/24h) is disabled so the gateway's own per-user inference limiter
  (`INFERENCE_RATE_LIMIT`/`INFERENCE_RATE_BURST`) is the effective throttle.
  Note the option names changed from the pre-1.7 plugin
  (`prefix`/`length`/`expiresIn`).
- **Key handling**: API keys are stored SHA-256-hashed by better-auth; verify
  happens per-request through `auth.api.verifyApiKey`.