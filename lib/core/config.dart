/// Backend endpoints and credentials for the self-hosted voice stack.
///
/// Host is entered at runtime (Phase 1 settings, stored in
/// flutter_secure_storage). These builders derive each service's URI from a
/// host; ports match the layout in PLAN.md. `--dart-define` values only
/// serve as defaults / dev fallbacks.
class BackendConfig {
  static const String defaultHost = String.fromEnvironment(
    'HOST_FQDN',
    defaultValue: 'localhost',
  );

  /// Dev-only fallback secret; the runtime settings value always wins.
  static const String defaultSecret = String.fromEnvironment(
    'TOKEN_MINT_SHARED_SECRET',
  );

  /// token-mint: exchanges the shared secret for short-lived LiveKit JWTs.
  static Uri tokenMint(String host) => Uri(scheme: 'http', host: host, port: 17602);

  /// token-mint health probe endpoint: `GET /healthz`.
  static Uri tokenMintHealthz(String host) =>
      tokenMint(host).replace(path: '/healthz');

  /// token-mint token exchange endpoint: `POST /token` (bearer-gated).
  static Uri tokenMintToken(String host) =>
      tokenMint(host).replace(path: '/token');

  /// LiveKit signaling (voice rooms). Media flows over UDP on the same host.
  static Uri liveKitWs(String host) => Uri(scheme: 'ws', host: host, port: 7880);

  /// queues proxy: OpenAI-compatible chat completions (streaming SSE).
  static Uri llmProxy(String host) => Uri(scheme: 'http', host: host, port: 9091);

  /// queues proxy chat completions endpoint: `POST /v1/chat/completions`.
  static Uri llmCompletions(String host) =>
      llmProxy(host).replace(path: '/v1/chat/completions');

  /// voice-mcp: tool bridge (bearer-gated).
  static Uri mcp(String host) => Uri(scheme: 'http', host: host, port: 17601);

  /// files service: bearer-gated upload/list/fetch/delete.
  static Uri files(String host) => Uri(scheme: 'http', host: host, port: 17603);
}