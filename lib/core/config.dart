/// Backend endpoints and credentials for the self-hosted voice stack.
///
/// Override at build time, e.g.:
///   flutter run --dart-define=HOST_FQDN=mesh-host-name
/// Values default to the homelab tailnet layout documented in PLAN.md.
class BackendConfig {
  static const String host = String.fromEnvironment(
    'HOST_FQDN',
    defaultValue: 'localhost',
  );

  /// token-mint: exchanges the shared secret for short-lived LiveKit JWTs.
  static Uri get tokenMint => Uri.http(host, ':17602');

  /// LiveKit signaling (voice rooms). Media flows over UDP on the same host.
  static Uri get liveKitWs => Uri(scheme: 'ws', host: host, port: 7880);

  /// queues proxy: OpenAI-compatible chat completions (streaming SSE).
  static Uri get llmProxy => Uri.http(host, ':9091');

  /// voice-mcp: tool bridge (bearer-gated).
  static Uri get mcp => Uri.http(host, ':17601');

  /// Shared secret for token-mint (set via --dart-define; store in
  /// secure_storage at runtime once login exists).
  static const String tokenMintSecret = String.fromEnvironment(
    'TOKEN_MINT_SHARED_SECRET',
  );
}
