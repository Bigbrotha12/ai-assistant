# ai-assistant

A self-hosted, privacy-first voice assistant that runs entirely on your own
hardware — Flutter client, on-device speech, plugin model credentials (your own
LLM provider keys), and a LangChain orchestrator that runs the agent graph.

Speak to it like a person. Speech-to-text and text-to-speech run **on device**
(no audio ever leaves your phone), the conversation is streamed through the
LangChain gateway, which resolves model and tool plugins and runs tools in the
agent graph. The gateway is stateless: the client owns conversation history and
sends it with each turn.

## Highlights

- **On-device voice** — Whisper STT (sub-1s, 99 languages) + Supertonic 3 TTS,
  ~220 MB loaded, engine-agnostic so models can be swapped without code changes.
- **Streaming text chat** — SSE streaming through the LangChain gateway,
  markdown rendering, tool-call chips, server-managed tool execution.
- **Your data stays yours** — conversations and AI memory live in local SQLite;
  auth credentials and plugin keys live in the OS secure store.
- **Plugin architecture** — admin-curated tool plugins (Vikunja, Mealie,
  SpielIndexer, calendar) and model plugins with user-owned provider keys.
- **LangChain agent graph** — server-side orchestration with tool execution,
  budget, and idempotency; the gateway is stateless.
- **Push notifications** — ntfy-based provisioning for async job status.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────────────┐
│  Flutter client          │  HTTPS │  LangChain gateway (Node/Hono)      │
│  (clients/mobile/)       │  ─────▶│  (server/)                          │
│  ┌────────────────────┐  │        │  · better-auth (email/pass)          │
│  │ Chat UI / SSE      │  │        │  · LangChain agent graph            │
│  │ Voice (STT + TTS)  │  │        │  · Tool execution + budget          │
│  │ Plugin credentials  │  │  ◀─────│  · Request-scoped execution        │
│  │ Local SQLite +      │  │  SSE   │  · Task ledger + idempotency       │
│  │ secure storage      │  │        │  · ntfy notification hook          │
│  └────────────────────┘  │        └─────────┬──────────────────────┬─────┘
│                          │                   │                      │
└──────────────────────────┘        ┌──────────▼────┐    ┌───────────▼──────┐
                                    │ Plugin model  │    │  Plugin tools     │
                                    │ APIs (OpenAI, │    │  Vikunja, Mealie, │
                                    │ OpenRouter,   │    │  SpielIndexer,    │
                                    │ llama.cpp)    │    │  calendar, ...    │
                                    └───────────────┘    └──────────────────┘
```

- **Voice stays on-device.** Mic → Whisper STT → text → gateway (HTTP/SSE) →
  response text → Supertonic 3 TTS → speaker. No audio network hops.
- **Tools run server-side.** The LangChain agent graph executes tool plugins and
  returns the final response — the client never dispatches tools itself.

## Repository layout

```
clients/mobile/      Flutter client
  lib/               app, core, features split into data/ + ui/
    core/            config, backend settings/probe, SSE, network
    features/
      auth/          better-auth sign-up/sign-in + secure credential store
      chat/          streaming SSE client, conversation UI, tool-call rendering
      voice/         capture pipeline, VAD, STT/TTS engine registry, controller
      attachments/   picker, upload queue, files client + store + cache
      plugins/       plugin system — registry client, credential store,
      |              staged inference adapters, managed conversation service
      vision/        image understanding client + VRAM gate
      memory/        drift-backed AI memory (search/compact)
      notifications/ ntfy push client
      onboarding/    setup screen (host, auth, models)
      settings/      settings screen + preference stores
  test/              Flutter unit tests (700+)
server/              Node.js gateway (Hono + better-auth)
  src/
    auth/            better-auth server configuration
    managers/        resource managers (budget, cache, rate limit, warmup)
    plugins/         plugin types, registry, store, SSRF validation
    transport/       LangChain agent graph, OpenAI-compatible /v1/chat/completions
    sessions/        ephemeral, owner-scoped conversation mirror
    notify/          encrypted ntfy notification provisioning + push hook
    ledger/          task ledger with idempotency and lease management
  test/              server unit tests (567+, node:test)
test/fixtures/       shared test fixtures (used by both server and client)
docs/                planning and reference documentation (gitignored)
deploy/              deployment configuration (k8s, Docker)
scripts/             automation scripts (APK install, etc.)
```

## Getting started

### Prerequisites

- **Node.js >= 20** (for the gateway)
- **Flutter** — auto-detected at `$HOME/Projects/mobile/flutter/bin/flutter`;
  set `FLUTTER` to point at another SDK

### Run

One command provisions the backend gateway (`.env`, dependencies,
migrations), starts it in the background, and runs the Flutter app against it —
tearing everything down on exit.

```sh
./dev.sh                                  # Linux desktop; host defaults to this machine's Tailscale IP
FLUTTER_DEVICE=${DEVICE_ID} ./dev.sh      # run on Android over USB (backend via Tailscale)
./dev.sh -- --dart-define=...             # forward extra args to flutter run
```

The backend host and environment are baked in at **build time** via
`--dart-define` (`HOST_FQDN`, `PUBLIC_BACKEND_URL`).

Persistent configuration lives in an optional `dev.env` (see
`dev.env.example`; gitignored). Values apply only when the corresponding env
var is unset, so `FLUTTER_DEVICE=<id> ./dev.sh` overrides for a single run.

## Running the gateway standalone

```sh
cd server
cp .env.example .env
npm install
npm run migrate
npm run dev                       # starts on :17600
```

See `server/README.md` for the full environment reference.

## Tests

```sh
cd server && npm test             # server unit tests (567+)
cd server && npm run typecheck    # static analysis
cd clients/mobile && flutter test # client unit tests (700+)
```

## Security model

- **No upstream secrets stored on the server.** User-owned provider API keys
  flow per-request in the request body over HTTPS and are never persisted.
  The client stores them in the OS secure storage.
- **Encrypted ntfy tokens.** Notification credentials are AES-256-GCM
  encrypted at rest, keyed by `NOTIFY_STORE_KEY`, and never logged.
- **SSRF-hardened outbound calls.** Plugin endpoints — and ntfy push delivery —
  are validated against an admin-curated allowlist; DNS-rebinding pinning
  prevents host-name reuse attacks; redirects are not followed.
- **Budget and rate limiting.** Per-user budget gates prevent runaway spending;
  per-owner rate limiters prevent abuse of the inference endpoint.
- Full details are in the (local-only) planning docs under `docs/`; the
  outstanding-work list lives in `docs/open-gaps.md`.

## License

All rights reserved.