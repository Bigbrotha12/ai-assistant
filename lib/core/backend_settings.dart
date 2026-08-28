/// Runtime-entered backend configuration (host + shared secret).
class BackendSettings {
  const BackendSettings({
    required this.host,
    required this.secret,
    this.mcpSecret,
    this.filesSecret,
    this.storageUrl,
  });

  final String host;
  final String secret;

  /// Optional voice-mcp bearer token. When blank/null no MCP auth is used.
  final String? mcpSecret;

  /// Optional bearer token for the files service (upload/list/fetch/delete).
  /// When blank/null the attachment features degrade to a no-op client.
  final String? filesSecret;

  /// Optional storage service URL. When null/blank derived from host:17603.
  final String? storageUrl;

  /// True when both host and shared secret are non-blank. The MCP and files
  /// tokens are optional and not required for validity.
  bool get isValid => host.trim().isNotEmpty && secret.trim().isNotEmpty;

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
    String? secret,
    String? mcpSecret,
    String? filesSecret,
    String? storageUrl,
  }) =>
      BackendSettings(
        host: host ?? this.host,
        secret: secret ?? this.secret,
        mcpSecret: mcpSecret ?? this.mcpSecret,
        filesSecret: filesSecret ?? this.filesSecret,
        storageUrl: storageUrl ?? this.storageUrl,
      );

  @override
  bool operator ==(Object other) =>
      other is BackendSettings &&
      other.host == host &&
      other.secret == secret &&
      other.mcpSecret == mcpSecret &&
      other.filesSecret == filesSecret &&
      other.storageUrl == storageUrl;

  @override
  int get hashCode => Object.hash(host, secret, mcpSecret, filesSecret, storageUrl);
}