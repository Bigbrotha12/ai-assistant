# Project notes

## Inference routing (LangChain gateway)

All inference — chat, voice, and vision — routes **exclusively** through the
LangChain gateway (Hono server, `host:17600`) at its `/v1/chat/completions`
endpoint. The gateway resolves the model plugin and its credentials from the
request body, runs a LangChain agent graph (tool execution, budget, idempotency
checks), and streams the result back via SSE. Plugin model endpoints (the
external LLM APIs) are called by the gateway — never by the client directly.

- The `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` dart-defines and the client-side
  tool loop are gone, and the legacy `ChatClient` client surface was deleted in
  full — there is no fallback or toggle (rollback is a git revert). The managed
  client surface is the sole inference path: the UI drives
  `ManagedConversationService` (`sendTurn`/`retryTurn`/`abandonTurn`/
  `submitBackground`/`reconcileFromServer`) via the account-scoped
  `managedChatAdapterProvider`
  (`lib/features/plugins/data/managed_chat_providers.dart`). Voice routes
  through the same per-send construction (`sendVoiceTurn`); background jobs use
  the foreground-gated `LedgerPoller`. Error codes live in `ManagedErrorCodes`
  (`lib/features/plugins/data/managed_error_codes.dart`) and map to phrases via
  `statusPhraseForError` (`lib/features/chat/data/status_tracker.dart`).
- The app authenticates to the gateway via a stored API key (better-auth
  session). Plugin credentials (the provider API keys per model/tool plugin)
  are sent in the request body alongside the gateway key in the
  `Authorization` header. The gateway never exposes raw plugin keys back to
  the client on list/model endpoints.
- Vision uses the same `/v1/chat/completions` endpoint with multi-modal
  messages (text + base64-encoded inline image). The gateway resolves a
  vision-capable plugin model and streams the description.
- The probe's inference/vision checks target the gateway directly, using the
  stored gateway API key. A gateway 401 surfaces as `ProbeStatus.unauthorized`
  (the re-auth affordance), not a build-time error.
- Runtime LLM overrides in app settings remain absent — model selection and
  plugin configuration live in the plugin credentials store
  (`plugin_credentials_providers.dart`) and are set through the plugins UI.