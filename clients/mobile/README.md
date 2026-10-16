# AI Assistant — Flutter Client (`clients/mobile/`)

Flutter frontend for the AI Assistant — on-device STT/TTS voice, streaming chat,
plugin-managed inference, and a full conversation UI.

## Setup

The primary dev workflow runs from the repo root:

```sh
./dev.sh    # provisions the gateway, starts flutter run
```

To run the Flutter app standalone:

```sh
cd clients/mobile
flutter pub get
flutter run
```

The app needs a running gateway. See `server/README.md` at the repo root for
running the gateway independently.

## Project structure

```
lib/
  main.dart                        Entry point
  app/                             App-level widgets, theme, startup gate
    widgets/                       Shared UI components (buttons, logo, etc.)
  core/
    config.dart                    Build-time environment
    backend_probe.dart             Backend connectivity checks
    backend_settings.dart          Runtime backend URL configuration
    secure_storage.dart            OS credential storage
  features/
    auth/                          Sign-up, sign-in, credential management
    chat/                          SSE streaming, conversation UI
    voice/                         Capture pipeline, STT/TTS engines
    plugins/                       Plugin registry client, credential store
    attachments/                   File picker, upload, cache
    vision/                        Image understanding
    notifications/                 owner-scoped SSE notification client
    settings/                      Preferences, account management
    memory/                        Local AI memory store
    onboarding/                    First-run setup screens
```

## Test data

Shared test fixtures live at `test/fixtures/` in the repo root (used by both
the server and client test suites).

## Building

```sh
flutter build apk --debug    # Android APK
flutter build ios --debug    # iOS (requires macOS)
```

CI builds are triggered via the `app-build` GitHub Actions workflow.