import 'auth_credentials_store.dart';
import 'backend_settings.dart';
import 'config.dart';

/// Resolves the effective [BackendSettings] for the app.
///
/// Single source of truth shared by the onboarding gate, the settings screen
/// and the onboarding flow: stored settings win; when nothing usable is stored
/// the compile-time defaults (`--dart-define`) apply, so the forms can prefill
/// a packaged app built with a `PUBLIC_BACKEND_URL` (or `HOST_FQDN`) define.
BackendSettings effectiveSettings(BackendSettings? stored) =>
    stored ??
    BackendSettings(
      host: BackendConfig.defaultHost,
      environment: BackendConfig.defaultEnvironment,
    );

/// The effective backend host: stored settings, else the compile-time default
/// (`PUBLIC_BACKEND_URL` host / `HOST_FQDN` define).
String effectiveHost(BackendSettings? stored) =>
    stored?.trimmedHost ?? BackendConfig.defaultHost;

/// The effective backend environment: stored settings, else the compile-time
/// default (`https` `PUBLIC_BACKEND_URL` → production, otherwise dev).
BackendEnvironment effectiveEnvironment(BackendSettings? stored) =>
    stored?.environment ?? BackendConfig.defaultEnvironment;

/// True when the app is fully configured: an API key **and** an explicitly
/// stored, structurally valid backend host.
///
/// A non-null [stored] host is required — the `--dart-define` defaults alone
/// do NOT count as configured. They only prefill the onboarding/settings
/// forms, so a packaged build without stored settings is still guided through
/// setup instead of silently pointing at `localhost`.
bool isConfigured({
  required AuthCredentials? credentials,
  required BackendSettings? stored,
}) =>
    credentials != null && stored != null && stored.isValid;