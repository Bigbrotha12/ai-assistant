/// Runtime-entered backend configuration (host + environment + service tokens).
class BackendSettings {
  const BackendSettings({
    required this.host,
    this.environment = BackendEnvironment.dev,
    this.mcpSecret,
    this.filesSecret,
    this.storageUrl,
  });

  final String host;

  /// Dev vs production deployment; selects the http/https scheme used by every
  /// derived backend URI.
  final BackendEnvironment environment;

  /// Optional voice-mcp bearer token. When blank/null no MCP auth is used.
  final String? mcpSecret;

  /// Optional bearer token for the files service (upload/list/fetch/delete).
  /// When blank/null the attachment features degrade to a no-op client.
  final String? filesSecret;

  /// Optional storage service URL. When null/blank derived from host:17603.
  final String? storageUrl;

  /// True when the host is non-blank. The MCP and files tokens are optional
  /// and not required for validity.
  bool get isValid => host.trim().isNotEmpty;

  String get trimmedHost => host.trim();

  /// The MCP secret with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedMcpSecret =>
      mcpSecret?.trim().isEmpty ?? true ? null : mcpSecret?.trim();

  /// The files secret with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedFilesSecret =>
      filesSecret?.trim().isEmpty ?? true ? null : filesSecret?.trim();

  /// The storage URL with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedStorageUrl =>
      storageUrl?.trim().isEmpty ?? true ? null : storageUrl?.trim();

  BackendSettings copyWith({
    String? host,
    BackendEnvironment? environment,
    String? mcpSecret,
    String? filesSecret,
    String? storageUrl,
  }) =>
      BackendSettings(
        host: host ?? this.host,
        environment: environment ?? this.environment,
        mcpSecret: mcpSecret ?? this.mcpSecret,
        filesSecret: filesSecret ?? this.filesSecret,
        storageUrl: storageUrl ?? this.storageUrl,
      );

  @override
  bool operator ==(Object other) =>
      other is BackendSettings &&
      other.host == host &&
      other.environment == environment &&
      other.mcpSecret == mcpSecret &&
      other.filesSecret == filesSecret &&
      other.storageUrl == storageUrl;

  @override
  int get hashCode =>
      Object.hash(host, environment, mcpSecret, filesSecret, storageUrl);
}

/// Deployment environment; selects the URI scheme for backend endpoints.
enum BackendEnvironment {
  dev('http'),
  production('https');

  const BackendEnvironment(this.scheme);

  /// The URI scheme used by derived backend endpoints in this environment.
  final String scheme;
}
