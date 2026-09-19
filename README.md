# ai-assistant

A self-hosted, privacy-first voice assistant that runs entirely on your own
hardware — Flutter client, on-device speech, plugin model credentials (your own
LLM provider keys), and a LangChain orchestrator that runs the agent graph.

Speak to it like a person. Speech-to-text and text-to-speech run **on device**
(no audio ever leaves your phone), the conversation is streamed through the
LangChain gateway, which resolves model and tool plugins, runs tools in the
agent graph, and manages conversation state on the server.

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
  budget, idempotency, and checkpoint management.
- **Push notifications** — ntfy-based provisioning for async job status.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────────────┐
│  Flutter client          │  HTTPS │  LangChain gateway (Node/Hono)      │
│  ┌────────────────────┐  │  ─────▶│  · better-auth (email/pass)          │
│  │ Chat UI / SSE      │  │        │  · LangChain agent graph            │
│  │ Voice (STT + TTS)  │  │        │  · Tool execution + budget          │
│  │ Plugin credentials  │  │  ◀─────│  · Conversation checkpoints        │
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
lib/               Flutter client (app, core, features split into data/ + ui/)
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
server/            Node.js gateway (Hono + better-auth)
  src/
    auth/          better-auth server configuration
    plugins/       plugin types, registry, store, SSRF validation
    transport/     LangChain agent graph, OpenAI-compatible /v1/chat/completions
    checkpoints/   conversation state (thread + checkpoint store)
    notify/        encrypted ntfy notification provisioning + push hook
    ledger/        task ledger with idempotency and lease management
  test/            server unit tests (567+, node:test)
test/              Flutter unit tests (700+)
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

### Connecting an Android phone

1. Start `./dev.sh` targeting the device with `FLUTTER_DEVICE` (id or name
   substring from `flutter devices`).
2. Both devices must be on the same network.
3. If sign-up is rejected after a host change, update `BETTER_AUTH_URL` in
   `server/.env` to match (`http://<backend-ip>:17600`) and restart.

### Configuring inference

Inference routes through the LangChain gateway. After signing in, install and
configure model and tool plugins through the **Plugins** screen in the app:

- Select a model plugin (e.g. OpenRouter) and enter your provider API key.
- Enable tool plugins (Vikunja, Mealie, calendar, etc.) with their credentials.
- The gateway uses these credentials per-request — they flow in the request
  body and are never persisted server-side.

The inference endpoint (`LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` dart-defines)
has been removed: the gateway is the sole inference path. The `main` branch
retains LibreChat as a fallback.

### Tests

```sh
cd server && npm test        # server unit tests (567+)
cd server && npm run typecheck
flutter test                 # client unit tests (700+)
```

## Roadmap

**Done**

- [x] **Phase 0 — Scaffold** — project structure, config, plan.
- [x] **Phase 1 — Connectivity & settings** — host + credentials persisted to
      secure storage; backend probe (auth/inference/vision); status UI.
- [x] **Phase 2 — Text chat** — streaming SSE conversation, markdown, tool-call
      chips, conversation history in SQLite, client-side context budget.
- [x] **Phase 3 — Attachments** — picker → upload → reference in prompt;
      bot-generated files.
- [x] **Phase 4 — Voice** — on-device STT/TTS conversation, turn detection,
      model download + cache, device capability fallback.
- [x] **Phase 5 — Polish** — image understanding, file storage, ntfy push,
      launcher shortcuts, error/retry ergonomics.
- [x] **Phase 6 — LangChain cutover** — plugin architecture (model + tool
      plugins), managed conversation service, server-side agent graph with tool
      execution, checkpoint store, encrypted ntfy provisioning, conversation
      identity state machine (seeded/resumed/recreated/reseed_required), async
      alerting, cross-device conversation ids, server-side tools and budget.
      Inference now routes through the LangChain gateway; the old `LLM_*`
      dart-define path has been retired.

**In progress / planned**

- [ ] **Multi-device / cross-device conversations** via server-issued
      conversation ids and a list-conversations endpoint.
- [ ] **Background audio** — Android foreground service / iOS background
      entitlement for screen-off voice (currently foreground-only).

## Security model

- **No upstream secrets stored on the server.** User-owned provider API keys
  flow per-request in the request body over HTTPS and are never persisted.
  The client stores them in the OS secure storage.
- **Encrypted ntfy tokens.** Notification credentials are AES-256-GCM
  encrypted at rest, derived from the checkpoint DB key, and never logged.
- **SSRF-hardened outbound calls.** Plugin endpoints are validated against an
  admin-curated allowlist; DNS-rebinding pinning prevents host-name reuse
  attacks; redirects are not followed.
- **Budget and rate limiting.** Per-user budget gates prevent runaway spending;
  per-owner rate limiters prevent abuse of the inference endpoint.
- Full details are in the (local-only) planning docs under `docs/`.

## License

All rights reserved.