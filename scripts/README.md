# scripts

## `install-latest-apk.sh`

Download the newest `app-build` APK artifact and install it on the connected
Android device.

```sh
scripts/install-latest-apk.sh              # newest successful app-build run
scripts/install-latest-apk.sh <run-id>     # a specific run
```

It resolves the run via `gh`, downloads the artifact, finds `adb` (PATH or
`ANDROID_SDK_ROOT`), runs `adb install -r` on the single connected device, then
launches the app. Overrides: `SERIAL`, `LAUNCH=0`, `UNINSTALL=1`, `REPO`,
`ADB`. Run `scripts/install-latest-apk.sh --help`.

# App delivery — getting builds onto the device

`ci-cd.yml` builds and deploys the **gateway**; it does not build the Flutter
app. The implemented app path is **CI artifact + local install**: GitHub Actions
builds a single arm64 APK on the self-hosted runner and uploads it as an
artifact; the script above pulls the newest one and installs it over `adb`.

## Build in CI

`.github/workflows/app-build.yml` is `workflow_dispatch`-only (app installs
should not fire on every `main` push). Trigger it from the Actions tab, or:

```sh
gh workflow run app-build -f build_mode=debug
gh workflow run app-build -f build_mode=release -f ref=my-branch
```

It uploads an artifact named `app-apk` containing
`build/app/outputs/flutter-apk/app-<mode>.apk` (14-day retention). The workflow
must exist on the default branch for the Actions button to appear; once it is on
`main`, you can dispatch it against any ref via the `ref` input.

Requirements on the runner: Flutter, Android SDK, and a JDK (all present on the
current self-hosted host). The SDK path is `ANDROID_SDK_ROOT` in the workflow,
overridable with a repo **variable** of the same name.

## Caveats

- **Signing.** `android/app/build.gradle.kts` signs `release` with the debug key
  and there is no keystore/`key.properties`. So `debug`, `profile`, and
  `release` are all debug-signed today — fine for internal installs, **not** for
  Play or public distribution. Adding a real keystore later (base64 in CI
  secrets + generated `key.properties`) needs no change to the install flow.
- **Data preservation.** `adb install -r` keeps app data (stored API
  key/session) only when the signing key matches. A mismatch fails with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; re-run with `UNINSTALL=1`, which **wipes
  app data** (you will sign in again).
- **Version code.** `pubspec.yaml` is `1.0.0+1` and `android/local.properties`
  pins `flutter.versionCode=1`, so it never bumps. `adb install -r` tolerates a
  non-increasing code; Play/Firebase App Distribution require a higher one per
  upload.
- **ABI.** The build pins `arm64-v8a` only (sherpa-onnx native libs), which is
  correct for a modern phone but will not install on an armv7/x86 emulator.
- **Build mode.** `debug` is large and slow but hot-reloadable; `profile` or
  `release` (debug-signed) is better for daily driving.

## Alternatives (not implemented)

- **Firebase App Distribution** — build in CI, `firebase appdistribution:distribute`
  to a tester group; the phone gets a notification and installs OTA. Needs a
  Firebase project, a CI service account secret, and (for a clean release) a
  real keystore.
- **`adb install` straight from CI** — if the phone is reachable from the runner
  host via wireless debugging (`adb connect <ip>:<port>`, same LAN or
  Tailscale), the workflow can install directly with no local step. USB into a
  service-run CI is fragile (udev permissions, device sleep, RSA auth).
