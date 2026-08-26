# AI Assistant — Flutter Frontend Plan

Flutter app for the self-hosted voice/LLM stack (repo:
`~/Projects/ai/voicebox`). Runs on phones joined to the host's Tailscale
mesh; all backend services are reachable directly over the tailnet - no
public internet exposure, no relay infrastructure.

## Backend surface (as deployed today)

| Capability         | Endpoint (host = tailnet IP / MagicDNS name)                                   | Auth                                                     |
|--------------------|--------------------------------------------------------------------------------|----------------------------------------------------------|
| Room tokens        | `POST http://host:17602/token`                                                 | `Authorization: Bearer $TOKEN_MINT_SHARED_SECRET`        |
| Voice conversation | `ws://host:7880` (LiveKit data channel only; media on-device)                   | short-lived JWT from token-mint                          |
| Text LLM chat      | `POST http://host:9091/v1/chat/completions` (OpenAI-compatible, SSE streaming) | none (LAN-trusted by design)                             |
| Tool calling       | same chat endpoint (`tools` param); MCP bridge at `:17601`                     | `Bearer $VOICE_MCP_AUTH_TOKEN`                           |
| TTS/STT REST       | `:17600`                                                                       | loopback-only - **not** reachable from mesh (deliberate) |

Notes:
- LiveKit is host-networked and advertises every interface, so ICE
  candidates include the tailnet IP - WebRTC works device-to-host with no
  extra config.
- Android emulators are not on the mesh; test on physical devices.
- **On-device voice pipeline**: the app runs STT/TTS locally to avoid
  network hops for audio processing. LiveKit is used only as a data
  transport (text messages), not for media. The existing server-side
  bot pipeline (STT→LLM→TTS in `voicebot-room`) remains intact for
  web clients and other callers.

### On-device voice architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Mobile Device                                               │
│                                                              │
│  Mic → `record` pkg (PCM) → Whisper tiny (on-device STT)    │
│    → transcribed text                                        │
│                                                              │
│  transcribed text ──→ LiveKit data channel ──→ LLM server    │
│                                                              │
│  response text ←── LiveKit data channel ←── LLM server       │
│                                                              │
│  response text → Kokoro 82M (on-device TTS) → speaker        │
└──────────────────────────────────────────────────────────────┘
```

- **STT**: Whisper tiny (~75 MB) via `whisper_kit` (whisper.cpp).
  Sub-1s transcription on mid-range phones, 99 languages.
- **TTS**: Kokoro 82M (~82 MB) via ONNX Runtime. Same model as the
  server-side pipeline; Apache-2.0 licensed.
- **Turn detection**: client-side silence/VAD. When the user pauses
  long enough, the final transcript is sent to the LLM.
- **Transport**: LiveKit data channel carries text only. No audio
  tracks are published to the room.
- **Memory budget**: ~157 MB for both models loaded simultaneously.
  First load takes ~1-2s; model files are cached on disk after
  initial download.

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
- **Voice**: livekit_client (phase 4) for the data channel only.
  Audio capture via `record` (PCM to Whisper), playback via on-device
  Kokoro TTS. Model inference via `whisper_kit` (STT) and ONNX
  Runtime (TTS); see "On-device voice architecture" above.
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
- [x] **Phase 1 - connectivity & settings**: host + secret entry persisted
      to secure_storage; probe token-mint `/healthz` + `/token` (secret
      validation), LiveKit signaling, LLM proxy; show backend status on
      the settings home screen.
- [ ] **Phase 2 - text chat**: streaming SSE conversation against the
      queues proxy; markdown-lite rendering; render tool calls as chips
      ("used voices()"); conversation history in memory + local cache.
- [ ] **Phase 3 - attachments**: requires backend gap #2. Picker ->
      upload -> reference in prompt; receive-side: bot-generated files
      listed from the files service.
- [ ] **Phase 4 - voice**: on-device voice conversation:
      independent mic capture (`record` pkg) → Whisper tiny STT
      (~75 MB) → text over LiveKit data channel → LLM response
      text over data channel → Kokoro 82M TTS (~82 MB) → speaker.
      Client-side turn detection (silence/VAD); model preload + cache
      on disk after first download; device capability check (fall back
      to text chat if models won't run). LiveKit join uses minted
      tokens; no audio tracks published. Optional image share into
      room via data channel later.
- [ ] **Phase 5 - polish**: push notifications (ntfy/shouarr self-hosted),
      background audio, widget shortcuts, error/retry ergonomics.

## Voice gotchas (phase 4/5)

1. **Audio focus / interruptions** - incoming GSM call, alarms, or other
   audio apps must not leave the bot talking over them. Handle
   focus/audio-session loss: pause bot playback + mute mic on loss,
   reacquire on return. (Android `AudioFocusRequest`; iOS AVAudioSession
   interruption notifications - livekit_client surfaces some of this, test
   the rest.)
2. **Background limits** - voice only works foreground/screen-on unless:
   iOS background-audio entitlement (Xcode capability), Android foreground
   service with `microphone` type + manifest permission. Without these,
   screen-off or backgrounded calls drop. Phase 4 can ship foreground-only;
   background is phase 5 polish.
3. **Shared room semantics** - the bot converses with whoever is in
   `voicebot-room`. Phone + web client joined together = two humans fighting
   one agent; there is no per-participant isolation yet. Acceptable for now;
   per-call rooms arrive later via SIP dispatch (telephony plan, Track A).
4. **On-device model budget** - Whisper tiny + Kokoro 82M ≈ 157 MB in RAM
   and ~157 MB on disk. Model download (~157 MB over Tailscale) happens
   once, cached after. First load ~1-2s (decompress + warm-up); do it in
   a background isolate so the UI doesn't jank. Check device capability
   (RAM, CPU, thermal) before offering voice; fall back to text chat.
5. **Whisper latency vs quality** - tiny is sub-1s but less accurate on
   noisy audio or accents. If WER is too high in practice, drop-in
   upgrade to `whisper-base` (~145 MB) without code changes (same
   whisper.cpp runtime). Monitor and tune; don't over-engineer up front.
6. **Turn detection tuning** - silence threshold + min-turn length are
   user-visible; too aggressive cuts words, too lenient feels laggy.
   Expose in settings (phase 5 polish) if needed; start with
   conservative defaults.

## Non-goals

- No public-internet exposure; tailscale-only.
- No on-device LLM - the Qwen3-8B stays server-side; only STT/TTS
  run locally to avoid audio network hops.
- No multi-account/auth system - the shared secret plus tailnet membership
  IS the auth boundary for this homelab.
