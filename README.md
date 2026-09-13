# ai-assistant

A self-hosted, privacy-first voice assistant that runs entirely on your own
hardware — Flutter client, on-device speech, your own LLM backend, or a compatible
OpenAI API.

Speak to it like a person. Speech-to-text and text-to-speech run **on device**
(no audio ever leaves your phone), the conversation is streamed to your own
OpenAI-compatible LLM backend, and the assistant can call your tools — tasks,
recipes, games, calendar — through a plugin architecture.

## Highlights

- **On-device voice** — Whisper STT (sub-1s, 99 languages) + Supertonic 3 TTS,
  ~220 MB loaded, engine-agnostic so models can be swapped without code changes.
- **Streaming text chat** — SSE streaming against an OpenAI-compatible API,
  markdown rendering, tool-call chips, thinking-mode suppression for low
  latency.
- **Your data stays yours** — conversations and AI memory live in local SQLite;
  auth credentials and plugin keys live in the OS secure store.
- **Plugin architecture** — admin-curated tool plugins (Vikunja, Mealie,
  SpielIndexer, calendar) and model plugins. - Under-development
- **Extensible** — attachments/images, push notifications (ntfy), a task
  ledger, and a plan to move orchestration to LangChain for async agentic
  delegation.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  Flutter client          │  HTTPS │  Backend gateway (Node/Hono) │
│  ┌────────────────────┐  │  ─────▶│  · better-auth (email/pass)  │
│  │ Chat UI / SSE      │  │        │  · API-key minting           │
│  │ Voice (STT + TTS)  │  │  ◀─────│  · OpenAI-compatible /v1     │
│  │ Tool-call chips    │  │  SSE   │  · task ledger, rate limits  │
│  │ Local SQLite +     │  │        └────────────┬─────────────────┘
│  │ secure storage     │  │                     │
│  └────────────────────┘  │                     │ OpenAI-compatible
│                          │                     ▼
└──────────────────────────┘        ┌──────────────────────────────┐
                                    │  External LLM backend        │
                                    │  (e.g. LibreChat agents,     │
                                    │   llama.cpp, vLLM, OpenAI)   │
                                    └──────────────────────────────┘
```

- **Voice stays on-device.** Mic → Whisper STT → text → LLM (HTTP/SSE) →
  response text → Supertonic 3 TTS → speaker. No audio network hops, no
  LiveKit/room plumbing.

## Repository layout

```
lib/               Flutter client (app, core, features split into data/ + ui/)
  core/            config (dart-defines), backend settings/probe, SSE, network
  features/
    auth/          better-auth sign-up/sign-in + secure credential store
    chat/          streaming SSE client, conversation UI, tool-call rendering
    voice/         capture pipeline, VAD, STT/TTS engine registry, controller
    attachments/   picker, upload queue, files client + store + cache
    vision/        image understanding client + VRAM gate
    memory/        drift-backed AI memory (search/compact)
    notifications/ ntfy push client
    onboarding/    setup screen (host, auth, models)
    settings/      settings screen + preference stores
server/            Node.js gateway (Hono + better-auth)
  src/             auth, inference routes, rate limiting, task ledger
  test/            server unit tests
test/              Flutter unit tests
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

This section will need to be updated after migrating to LangChain. Current set-up uses
Librechat for agent orchestration.
Inference is routed via three build defines (`LLM_BASE_URL`, `LLM_MODEL`,
`LLM_API_KEY`) that point at any OpenAI-compatible API — set them in `dev.env`:

```
LLM_BASE_URL=https://<host>/api/agents/v1     # OpenAI-compatible base incl. /v1
LLM_MODEL=agent_<id>                          # model / agent id
LLM_API_KEY=sk-...                            # bearer key
```

A build without these fails loudly at chat-client creation rather than
silently falling back to a local proxy.

### Tests

```sh
cd server && npm test        # server unit tests (ledger)
cd server && npm run typecheck
flutter test                 # client unit tests
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

**In progress / planned**

- [ ] **LangChain plugin backend** — replace LibreChat with a LangChain.js
      orchestrator behind the same OpenAI-compatible endpoint:
      - Plugin architecture: admin-curated tool plugins (Vikunja, Mealie,
        SpielIndexer, calendar) and model plugins (user-owned LLM keys).
      - Server-side conversation state (LangGraph checkpoints, per-user
        scoping) so the client stops resending full history.
      - Async agentic delegation — the orchestrator answers immediately while
        background jobs update calendars/fetch data, with push-status delivery.
      - Idempotent turns, credential-free server (user keys flow per-request,
        never persisted), SSRF-hardened outbound calls, compaction + context
        management.
- [ ] **OpenAI-compatible transport hardening** — wire-spec-guaranteed SSE,
      per-user rate limiting + upstream budget.
- [ ] **Multi-device / cross-device conversations** via server-issued
      conversation ids and a list-conversations endpoint.
- [ ] **Background audio** — Android foreground service / iOS background
      entitlement for screen-off voice (currently foreground-only).

## Security model

- **No upstream secrets on the server.** User-owned API keys are submitted
  per-request over HTTPS and discarded; the client stores them in the OS
  secure storage.
- **Never log or persist credentials.** Tool outputs are redacted for
  secret-shaped data before checkpoint/cache writes.
- Full details are in the (local-only) planning docs under `docs/`.

## License

All rights reserved.
