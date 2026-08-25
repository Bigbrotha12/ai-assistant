# AI Assistant — Flutter Frontend Plan

Flutter app for the self-hosted voice/LLM stack (repo:
`~/Projects/ai/voicebox`). Runs on phones joined to the host's Tailscale
mesh; all backend services are reachable directly over the tailnet - no
public internet exposure, no relay infrastructure.

## Backend surface (as deployed today)

| Capability | Endpoint (host = tailnet IP / MagicDNS name) | Auth |
|---|---|---|
| Room tokens | `POST http://host:17602/token` | `Authorization: Bearer $TOKEN_MINT_SHARED_SECRET` |
| Voice conversation | `ws://host:7880` + UDP media (LiveKit room `voicebot-room`) | short-lived JWT from token-mint |
| Text LLM chat | `POST http://host:9091/v1/chat/completions` (OpenAI-compatible, SSE streaming) | none (LAN-trusted by design) |
| Tool calling | same chat endpoint (`tools` param); MCP bridge at `:17601` | `Bearer $VOICE_MCP_AUTH_TOKEN` |
| TTS/STT REST | `:17600` | loopback-only - **not** reachable from mesh (deliberate) |

Notes:
- LiveKit is host-networked and advertises every interface, so ICE
  candidates include the tailnet IP - WebRTC works device-to-host with no
  extra config.
- Android emulators are not on the mesh; test on physical devices.
- The in-call bot pipeline (STT -> Qwen3-8B via queues worker -> kokoro)
  already handles voice turns end-to-end; the app mostly joins a room.

## Gaps to close before certain phases (backend work)

1. **Image understanding** - resident model (Qwen3-8B) is text-only. Options,
   cheapest first: (a) add a vision GGUF (e.g. Qwen2.5-VL class) as a new
   llama service + proxy route (`model.vl`, port 19092-style), route image
   chats there; (b) images stored + OCR/captioned async; (c) defer feature.
2. **File/image storage** - no upload endpoint exists today. Proposal: small
   bearer-gated `files` service (upload/list/fetch, ~100 lines, same shape
   as token-mint) storing under the voicebox output volume; MCP filesystem
   server is the alternative if tool-driven access is preferred.
3. **Optional**: expose STT/TTS REST beyond loopback for standalone voice
   notes without joining a LiveKit room.

## App architecture

- **State**: flutter_riverpod; one `ApiClient` per backend surface.
- **Networking**: dio (+ manual SSE line parser for streaming completions;
  no official OpenAI dart SDK worth pinning).
- **Voice**: livekit_client (phase 4) - join flow identical to
  `test-client.html`: mint token -> connect -> publish mic, subscribe bot.
- **Config**: all endpoints via `--dart-define` (`lib/core/config.dart`);
  secrets never committed - shared secret entered at runtime and kept in
  flutter_secure_storage once settings UI exists.
- **Layout**:
  ```
  lib/
    core/         config.dart, api clients, sse.dart, theme
    features/
      chat/       conversation UI, message stream, tool-call rendering
      voice/      room join, audio controls (phase 4)
      attachments/ picker + upload queue (needs gap #2)
      settings/   host address, secret entry, connectivity probe
  ```

## Phases

- [x] **Phase 0 - scaffold** (this commit): project created
      (android/ios/web), config + placeholder screen, plan documented.
- [ ] **Phase 1 - connectivity & settings**: host + secret entry persisted
      to secure_storage; probe token-mint `/healthz`; show backend status.
- [ ] **Phase 2 - text chat**: streaming SSE conversation against the
      queues proxy; markdown-lite rendering; render tool calls as chips
      ("used voices()"); conversation history in memory + local cache.
- [ ] **Phase 3 - attachments**: requires backend gap #2. Picker ->
      upload -> reference in prompt; receive-side: bot-generated files
      listed from the files service.
- [ ] **Phase 4 - voice**: LiveKit join/mute/disconnect using minted
      tokens; reuse bot's existing turn-taking; optional image share into
      room via data channel later.
- [ ] **Phase 5 - polish**: push notifications (ntfy/shouarr self-hosted),
      background audio, widget shortcuts, error/retry ergonomics.

## Non-goals

- No public-internet exposure; tailscale-only.
- No embedded STT/TTS models on-device (server does inference).
- No multi-account/auth system - the shared secret plus tailnet membership
  IS the auth boundary for this homelab.
