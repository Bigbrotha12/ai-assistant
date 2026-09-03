# ai-assistant

Flutter frontend to the self-hosted voice/LLM stack over Tailscale.

**Read [PLAN.md](PLAN.md) first** - backend surface map, architecture,
and the phase-by-phase build order.

## Local dev

One command provisions the backend gateway (`.env`, dependencies, migrations),
starts it in the background, and runs the Flutter app against a local backend —
then tears everything down on exit.

```sh
./dev.sh                        # backend = localhost, dev (http)
./dev.sh -- --dart-define=...   # forward extra args to flutter run
```

The backend host/environment are supplied at **build time** via `--dart-define`
(`HOST_FQDN`, `PUBLIC_BACKEND_URL`). `./dev.sh` passes `--dart-define=HOST_FQDN=localhost`
for a deterministic local build; the onboarding flow persists those defaults when
you press "Get started".

Requirements: Node >= 20 (for the gateway), Flutter (auto-detected at
`$HOME/Projects/mobile/flutter/bin/flutter`). Optionally set `FLUTTER` to point
at another SDK. `FLUTTER_ARGS` env is an alternative way to forward flutter
args.
