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

  /// Gateway LLM proxy: OpenAI-compatible chat completions (streaming SSE).
  static Uri llmProxy(String host, {BackendEnvironment? environment}) =>
      Uri(scheme: _scheme(environment), host: host, port: 9091);

  /// Gateway LLM proxy chat completions endpoint: `POST /v1/chat/completions`.
  static Uri llmCompletions(String host, {BackendEnvironment? environment}) =>
      llmProxy(host, environment: environment)
          .replace(path: '/v1/chat/completions');

  /// voice-mcp: tool bridge (bearer-gated).
  static Uri mcp(String host, {BackendEnvironment? environment}) =>
      Uri(scheme: _scheme(environment), host: host, port: 17601);

  /// files service: bearer-gated upload/list/fetch/delete.
  static Uri files(String host, {BackendEnvironment? environment}) =>
      Uri(scheme: _scheme(environment), host: host, port: 17603);

  static String _scheme(BackendEnvironment? environment) =>
      (environment ?? defaultEnvironment).scheme;
}