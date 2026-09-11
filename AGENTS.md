# Project notes

## Inference routing (no gateway fallback)

All inference — chat, voice, and vision — routes **exclusively** through the
external OpenAI-compatible API configured at build time via the `LLM_BASE_URL`,
`LLM_MODEL`, and `LLM_API_KEY` dart-defines (see `dev.env` / `dev.sh`; the
target is a LibreChat agents endpoint, `.../api/agents/v1`).

- The app **must not** fall back to the on-prem gateway for inference,
  regardless of any stored settings or a missing/blank define. A build lacking
  `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` fails loudly (`StateError`) at chat
  client creation rather than silently routing to a local proxy.
- `BackendConfig.stripV1Suffix` normalises an `LLM_BASE_URL` that ends in `/v1`
  for clients (vision) that append their own `/v1/...` path.
- The gateway (Hono + better-auth) remains only for account services: the auth
  base is `host:17600` under `/api/auth`, and the diagnostics probe's auth
  check requests a key from the gateway. The probe's inference/vision checks
  target the external `LLM_*` API directly.
- There are no runtime LLM overrides in app settings (`BackendSettings` has no
  LLM fields).