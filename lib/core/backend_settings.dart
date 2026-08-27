/// Runtime-entered backend configuration (host + shared secret).
class BackendSettings {
  const BackendSettings({required this.host, required this.secret, this.mcpSecret});

  final String host;
  final String secret;

  /// Optional voice-mcp bearer token. When blank/null no MCP auth is used.
  final String? mcpSecret;

  /// True when both host and shared secret are non-blank. The MCP token is
  /// optional and not required for validity.
  bool get isValid => host.trim().isNotEmpty && secret.trim().isNotEmpty;

  String get trimmedHost => host.trim();

  /// The MCP secret with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedMcpSecret =>
      mcpSecret?.trim().isEmpty ?? true ? null : mcpSecret?.trim();

  BackendSettings copyWith({String? host, String? secret, String? mcpSecret}) =>
      BackendSettings(
        host: host ?? this.host,
        secret: secret ?? this.secret,
        mcpSecret: mcpSecret ?? this.mcpSecret,
      );

  @override
  bool operator ==(Object other) =>
      other is BackendSettings &&
      other.host == host &&
      other.secret == secret &&
      other.mcpSecret == mcpSecret;

  @override
  int get hashCode => Object.hash(host, secret, mcpSecret);
}