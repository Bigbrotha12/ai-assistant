/// Runtime-entered backend configuration (host + environment + service tokens).
class BackendSettings {
  const BackendSettings({
    required this.host,
    this.environment = BackendEnvironment.dev,
    this.mcpSecret,
    this.filesSecret,
    this.storageUrl,
    this.llmBaseUrl,
    this.llmModel,
    this.llmApiKey,
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

  /// Optional external OpenAI-compatible LLM API base root (e.g. a LibreChat
  /// agents endpoint `https://<host>/api/agents/v1`, including the `/v1`
  /// prefix). When null/blank the gateway LLM proxy is used.
  final String? llmBaseUrl;

  /// Optional inference model (e.g. a LibreChat agent id). When null/blank the
  /// gateway's default model applies.
  final String? llmModel;

  /// Optional inference bearer key (e.g. a LibreChat API key). When null/blank
  /// the gateway's better-auth key applies.
  final String? llmApiKey;

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

  /// The LLM base URL with surrounding whitespace and a trailing slash
  /// removed; an empty (or blank) value is normalised to null.
  String? get trimmedLlmBaseUrl {
    final value = llmBaseUrl?.trim();
    if (value == null || value.isEmpty) return null;
    return value.endsWith('/') ? value.substring(0, value.length - 1) : value;
  }

  /// The LLM model with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedLlmModel =>
      llmModel?.trim().isEmpty ?? true ? null : llmModel?.trim();

  /// The LLM API key with surrounding whitespace removed; an empty (or blank)
  /// value is normalised to null.
  String? get trimmedLlmApiKey =>
      llmApiKey?.trim().isEmpty ?? true ? null : llmApiKey?.trim();

  BackendSettings copyWith({
    String? host,
    BackendEnvironment? environment,
    String? mcpSecret,
    String? filesSecret,
    String? storageUrl,
    String? llmBaseUrl,
    String? llmModel,
    String? llmApiKey,
  }) =>
      BackendSettings(
        host: host ?? this.host,
        environment: environment ?? this.environment,
        mcpSecret: mcpSecret ?? this.mcpSecret,
        filesSecret: filesSecret ?? this.filesSecret,
        storageUrl: storageUrl ?? this.storageUrl,
        llmBaseUrl: llmBaseUrl ?? this.llmBaseUrl,
        llmModel: llmModel ?? this.llmModel,
        llmApiKey: llmApiKey ?? this.llmApiKey,
      );

  @override
  bool operator ==(Object other) =>
      other is BackendSettings &&
      other.host == host &&
      other.environment == environment &&
      other.mcpSecret == mcpSecret &&
      other.filesSecret == filesSecret &&
      other.storageUrl == storageUrl &&
      other.llmBaseUrl == llmBaseUrl &&
      other.llmModel == llmModel &&
      other.llmApiKey == llmApiKey;

  @override
  int get hashCode => Object.hash(host, environment, mcpSecret, filesSecret,
      storageUrl, llmBaseUrl, llmModel, llmApiKey);
}

/// Deployment environment; selects the URI scheme for backend endpoints.
enum BackendEnvironment {
  dev('http'),
  production('https');

  const BackendEnvironment(this.scheme);

  /// The URI scheme used by derived backend endpoints in this environment.
  final String scheme;
}
