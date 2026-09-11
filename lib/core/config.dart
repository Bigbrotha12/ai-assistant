import 'package:flutter/foundation.dart' show debugPrint;

import 'backend_settings.dart';

/// Backend endpoints for the self-hosted voice stack.
///
/// Host is entered at runtime (Phase 1 settings, stored in
/// flutter_secure_storage). These builders derive each service's URI from a
/// host; ports match the layout in PLAN.md. `--dart-define` values only
/// serve as defaults / dev fallbacks. The URI scheme (http/https) is driven by
/// the [BackendEnvironment]: dev → `http`, production → `https`.
class BackendConfig {
  /// Compile-time fallback host (`HOST_FQDN` dart-define). When the
  /// `PUBLIC_BACKEND_URL` define is set, its (scheme-less) host takes
  /// precedence.
  static const String defaultHostDefine = String.fromEnvironment(
    'HOST_FQDN',
    defaultValue: 'localhost',
  );

  /// Optional public backend URL dart-define (e.g. `https://api.example.com`).
  /// Parsed at the boundary into a scheme (driving [defaultEnvironment]) and a
  /// scheme-less host (driving [defaultHost]).
  static const String publicBackendUrl = String.fromEnvironment(
    'PUBLIC_BACKEND_URL',
  );

  /// Scheme extracted from [publicBackendUrl], or null when unset/blank.
  static String? get publicBackendScheme {
    final url = publicBackendUrl.trim();
    if (url.isEmpty) return null;
    final uri = Uri.tryParse(url);
    return uri != null && uri.scheme.isNotEmpty ? uri.scheme : null;
  }

  static String? get _publicBackendHost {
    final url = publicBackendUrl.trim();
    if (url.isEmpty) return null;
    final uri = Uri.tryParse(url);
    if (uri == null || uri.host.isEmpty) return null;
    // Host only: the services derive their own fixed ports below, so the
    // URL's port must never be carried into the scheme-less host.
    return uri.host;
  }

  /// The effective default backend host: the `PUBLIC_BACKEND_URL` host when
  /// set (scheme and port stripped so it stays a scheme-less authority), else
  /// the `HOST_FQDN` define (default `localhost`).
  static String get defaultHost => _publicBackendHost ?? defaultHostDefine;

  /// The default backend environment: `production` when [publicBackendUrl] is
  /// set with an `https` scheme, otherwise `dev`.
  static BackendEnvironment get defaultEnvironment =>
      publicBackendScheme == 'https'
          ? BackendEnvironment.production
          : BackendEnvironment.dev;

  /// Dev-only fallback storage URL; the runtime settings value always wins.
  static const String defaultStorageUrl = String.fromEnvironment(
    'STORAGE_URL',
    defaultValue: '',
  );

  /// ntfy server base URL for push notifications. Empty (default) disables
  /// notifications — the notifier server is out of scope until it exists.
  static const String defaultNotifUrl = String.fromEnvironment(
    'NOTIF_URL',
    defaultValue: '',
  );

  /// Resolves the effective storage base URL from three sources (in precedence):
  /// 1. Runtime settings override (`settings.storageUrl`), non-blank.
  /// 2. Compile-time env default (`STORAGE_URL` dart-define), non-blank.
  /// 3. Host-derived (`host:17603`).
  ///
  /// An absolute storage URL whose scheme contradicts the [environment] is
  /// resolved with the environment's scheme (with a debug warning).
  static String effectiveStorageUrl(
    String host,
    String? settingsUrl, {
    BackendEnvironment? environment,
  }) {
    final env = environment ?? defaultEnvironment;
    final s = settingsUrl?.trim();
    if (s != null && s.isNotEmpty) return _resolveStorageScheme(s, env);
    final e = defaultStorageUrl.trim();
    if (e.isNotEmpty) return _resolveStorageScheme(e, env);
    return files(host, environment: env).toString();
  }

  /// Rewrites [url]'s scheme to match [env] when they contradict, warning in
  /// debug builds. Relative and scheme-less strings are left untouched.
  static String _resolveStorageScheme(String url, BackendEnvironment env) {
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme || !uri.hasAuthority) return url;
    if (uri.scheme == env.scheme) return url;
    debugPrint(
      'BackendConfig: storage URL scheme "${uri.scheme}" contradicts the '
      '${env.name} environment; using "${env.scheme}".',
    );
    return uri.replace(scheme: env.scheme).toString();
  }

  /// Gateway origin for the app's account services only (better-auth under
  /// `/api/auth`): `host:17600`. Inference never routes through the gateway —
  /// it targets the configured external API (see [defaultLlmBaseUrl]).
  static Uri gatewayBase(String host, {BackendEnvironment? environment}) =>
      Uri(
        scheme: _scheme(environment),
        host: _sanitizeAuthority(host),
        port: 17600,
      );

  /// Normalises a user-entered or stored authority so the service URI builders
  /// can't throw on it: trims, strips a scheme prefix, truncates any `/path`,
  /// and drops a trailing `:port` (these builders always fix the service port,
  /// so a stored port is meaningless). Falls back to [defaultHost] when nothing
  /// usable remains — the auth/files/mcp providers must degrade, not crash.
  static String _sanitizeAuthority(String authority) {
    var value = authority.trim();
    final schemeEnd = value.indexOf('://');
    if (schemeEnd != -1) value = value.substring(schemeEnd + 3);
    final pathStart = value.indexOf('/');
    if (pathStart != -1) value = value.substring(0, pathStart);
    if (!value.startsWith('[')) {
      final port = RegExp(r':\d+$').firstMatch(value);
      if (port != null) value = value.substring(0, port.start);
    }
    value = value.trim();
    return value.isEmpty ? defaultHost : value;
  }

  /// External OpenAI-compatible inference base URL dart-define (e.g. a
  /// LibreChat agents endpoint `https://<host>/api/agents/v1`, including the
  /// API-version `/v1` prefix the chat client appends `chat/completions` to).
  ///
  /// THE ONLY inference routing source: there is no gateway fallback. A build
  /// without this (and [defaultLlmModel] / [defaultLlmApiKey]) fails loudly at
  /// chat-client creation.
  static const String defaultLlmBaseUrl = String.fromEnvironment(
    'LLM_BASE_URL',
  );

  /// Inference model dart-define (e.g. a LibreChat agent id).
  static const String defaultLlmModel = String.fromEnvironment('LLM_MODEL');

  /// Inference bearer key dart-define (e.g. a LibreChat API key).
  static const String defaultLlmApiKey = String.fromEnvironment('LLM_API_KEY');

  /// Normalises [base] for clients that append their own `/v1/...` path
  /// (vision's models probe + client): strips whitespace, a trailing slash,
  /// and a trailing API-version `/v1` suffix. `https://h/api/agents/v1` →
  /// `https://h/api/agents`; `https://h/api/openai/v1/` → `https://h/api/openai`.
  static String stripV1Suffix(String base) {
    final value = trimTrailingSlash(base);
    if (value.endsWith('/v1')) {
      return value.substring(0, value.length - 3);
    }
    return value;
  }

  /// Removes surrounding whitespace and a trailing `/` from [value]. Keeps
  /// any API-version `/v1` prefix — that is [stripV1Suffix]'s job.
  static String trimTrailingSlash(String value) {
    var result = value.trim();
    while (result.endsWith('/')) {
      result = result.substring(0, result.length - 1);
    }
    return result;
  }

  /// voice-mcp: tool bridge (bearer-gated).
  static Uri mcp(String host, {BackendEnvironment? environment}) =>
      Uri(
        scheme: _scheme(environment),
        host: _sanitizeAuthority(host),
        port: 17601,
      );

  /// files service: bearer-gated upload/list/fetch/delete.
  static Uri files(String host, {BackendEnvironment? environment}) =>
      Uri(
        scheme: _scheme(environment),
        host: _sanitizeAuthority(host),
        port: 17603,
      );

  static String _scheme(BackendEnvironment? environment) =>
      (environment ?? defaultEnvironment).scheme;
}