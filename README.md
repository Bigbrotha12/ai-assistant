# ai-assistant

Flutter frontend to the self-hosted voice/LLM stack over Tailscale.

**Read [PLAN.md](PLAN.md) first** - backend surface map, architecture,
and the phase-by-phase build order.

```sh
export PATH="$HOME/Projects/mobile/flutter/bin:$PATH"   # flutter SDK lives here
flutter run -d <device> --dart-define=HOST_FQDN=<tailnet-host> \
  --dart-define=TOKEN_MINT_SHARED_SECRET=<from voicebox .env>
```
