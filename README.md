# ai-assistant

Flutter frontend to the self-hosted voice/LLM stack over Tailscale.

Planning docs live in the gitignored `docs/` directory (local only). Start
with `docs/PLAN.md` - backend surface map, architecture, and the
phase-by-phase build order.

## Local dev

One command provisions the backend gateway (`.env`, dependencies, migrations),
starts it in the background, and runs the Flutter app against a local backend —
then tears everything down on exit.

```sh
./dev.sh                                  # Linux desktop; host defaults to this machine's Tailscale IP
FLUTTER_DEVICE=33171FDH3000VP ./dev.sh    # run on Android over USB (backend via Tailscale)
./dev.sh -- --dart-define=...             # forward extra args to flutter run
```

The backend host/environment are supplied at **build time** via `--dart-define`
(`HOST_FQDN`, `PUBLIC_BACKEND_URL`). By default `./dev.sh` bakes in this
machine's **Tailscale IPv4** so the same build works on the Linux desktop
(local loopback) and on phones in the same tailnet (plain HTTP is allowed via
`usesCleartextTraffic`). Without Tailscale it falls back to `localhost`. The
onboarding flow persists those defaults when you press "Get started".

To run on a physical Android device: start `./dev.sh` targeting it with
`FLUTTER_DEVICE` (device id or name substring from `flutter devices`). The
gateway binds all interfaces and both devices must be on the same tailnet —
the phone reaches the PC at its Tailscale IP. If sign-up is rejected after a
host change, update `BETTER_AUTH_URL` in `server/.env` to match
(`http://<tailscale-ip>:17600`) and restart.

Persistent configuration lives in an optional `dev.env` (see
`dev.env.example`; gitignored). Values apply when the corresponding env var is
unset, so `FLUTTER_DEVICE=<id> ./dev.sh` overrides it for one run.

Requirements: Node >= 20 (for the gateway), Flutter (auto-detected at
`$HOME/Projects/mobile/flutter/bin/flutter`). Optionally set `FLUTTER` to point
at another SDK. `FLUTTER_ARGS` env is an alternative way to forward flutter
args.
