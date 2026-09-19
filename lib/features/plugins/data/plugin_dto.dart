import 'dart:convert';

class PluginProtocolException implements Exception {
  const PluginProtocolException();

  @override
  String toString() => 'PluginProtocolException: invalid_response';
}

Map<String, dynamic> pluginJsonObject(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const PluginProtocolException();
  }
  return value;
}

String pluginJsonString(Object? value) {
  if (value is! String || value.trim().isEmpty) {
    throw const PluginProtocolException();
  }
  return value;
}

String pluginJsonId(Object? value) {
  final id = pluginJsonString(value);
  if (!RegExp(r'^[a-z0-9]+(?:-[a-z0-9]+)*$').hasMatch(id)) {
    throw const PluginProtocolException();
  }
  return id;
}

bool _boolean(Object? value) {
  if (value is! bool) throw const PluginProtocolException();
  return value;
}

int _integer(Object? value, {int minimum = 1}) {
  if (value is! int || value < minimum) {
    throw const PluginProtocolException();
  }
  return value;
}

List<T> pluginJsonList<T>(Object? value, T Function(Object?) parse) {
  if (value is! List) throw const PluginProtocolException();
  return List<T>.unmodifiable(value.map(parse));
}

Object? freezePluginJson(Object? value) {
  if (value == null || value is String || value is bool) return value;
  if (value is num && value.isFinite) return value;
  if (value is List) return pluginJsonList(value, freezePluginJson);
  final object = pluginJsonObject(value);
  return Map<String, dynamic>.unmodifiable(
    object.map((key, value) => MapEntry(key, freezePluginJson(value))),
  );
}

T? _optional<T>(
  Map<String, dynamic> json,
  String key,
  T Function(Object?) parse,
) => json.containsKey(key) ? parse(json[key]) : null;

String _url(Object? value) {
  final text = pluginJsonString(value);
  final uri = Uri.tryParse(text);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
    throw const PluginProtocolException();
  }
  return text;
}

class PluginCredentialSpec {
  PluginCredentialSpec.fromJson(Object? value) {
    final json = pluginJsonObject(pluginJsonObject(value)['apiKey']);
    label = pluginJsonString(json['label']);
    required = _boolean(json['required']);
  }

  late final String label;
  late final bool required;
}

class PluginBaseUrl {
  PluginBaseUrl.fromJson(Object? value, {bool detail = false}) {
    final json = pluginJsonObject(value);
    id = pluginJsonId(json['id']);
    label = _optional(json, 'label', pluginJsonString);
    url = detail ? _url(json['url']) : null;
  }

  late final String id;
  late final String? label;
  late final String? url;
}

class PluginToolDto {
  PluginToolDto.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    name = pluginJsonString(json['name']);
    description = pluginJsonString(json['description']);
    readOnly = _boolean(json['readOnly']);
    final schema = pluginJsonObject(json['inputSchema']);
    _validateSchema(schema);
    inputSchema = freezePluginJson(schema) as Map<String, dynamic>;
  }

  late final String name;
  late final String description;
  late final bool readOnly;
  late final Map<String, dynamic> inputSchema;

  static void _validateSchema(Object? value) {
    final json = pluginJsonObject(value);
    for (final key in ['type', 'description']) {
      if (json.containsKey(key) && json[key] is! String) {
        throw const PluginProtocolException();
      }
    }
    if (json.containsKey('properties')) {
      pluginJsonObject(json['properties']).values.forEach(_validateSchema);
    }
    if (json.containsKey('required')) {
      pluginJsonList(json['required'], pluginJsonString);
    }
    if (json.containsKey('items')) _validateSchema(json['items']);
  }
}

class PluginInferenceDto {
  PluginInferenceDto.fromJson(Object? value, {bool detail = false}) {
    final json = pluginJsonObject(value);
    defaultModel = pluginJsonString(json['defaultModel']);
    tokenLimit = _integer(json['tokenLimit']);
    supportsStreaming = _boolean(json['supportsStreaming']);
    visionCapable = _boolean(json['visionCapable']);
    endpoint = detail ? _url(json['endpoint']) : null;
    parameters = detail
        ? freezePluginJson(pluginJsonObject(json['parameters']))
              as Map<String, dynamic>
        : null;
  }

  late final String defaultModel;
  late final int tokenLimit;
  late final bool supportsStreaming;
  late final bool visionCapable;
  late final String? endpoint;
  late final Map<String, dynamic>? parameters;
}

class PluginDto {
  PluginDto.fromSummaryJson(Object? value) : this._(value, detail: false);
  PluginDto.fromDetailJson(Object? value) : this._(value, detail: true);

  PluginDto._(Object? value, {required bool detail}) {
    final json = pluginJsonObject(value);
    id = pluginJsonId(json['id']);
    type = pluginJsonString(json['type']);
    name = pluginJsonString(json['name']);
    description = pluginJsonString(json['description']);
    version = pluginJsonString(json['version']);
    if (!RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version)) {
      throw const PluginProtocolException();
    }
    schemaVersion = _integer(json['schemaVersion']);
    installed = _boolean(json['installed']);
    baseUrls = detail && type != 'tool' && !json.containsKey('baseUrls')
        ? const []
        : json.containsKey('baseUrls')
            ? pluginJsonList(
                json['baseUrls'],
                (value) => PluginBaseUrl.fromJson(value, detail: detail),
              )
            : const [];
    credentials = _optional(json, 'credentials', PluginCredentialSpec.fromJson);
    tools = type == 'tool' || json.containsKey('tools')
        ? pluginJsonList(json['tools'], PluginToolDto.fromJson)
        : const [];
    if (type == 'tool' && tools.isEmpty) {
      throw const PluginProtocolException();
    }
    inference = type == 'model' || json.containsKey('inference')
        ? PluginInferenceDto.fromJson(json['inference'], detail: detail)
        : null;
  }

  late final String id;
  late final String type;
  late final String name;
  late final String description;
  late final String version;
  late final int schemaVersion;
  late final bool installed;
  late final List<PluginBaseUrl> baseUrls;
  late final PluginCredentialSpec? credentials;
  late final List<PluginToolDto> tools;
  late final PluginInferenceDto? inference;

  bool get isSupported =>
      schemaVersion == 1 && (type == 'tool' || type == 'model' || type == 'agent');

  static List<PluginDto> parseList(Object? value) => pluginJsonList(
    pluginJsonObject(value)['plugins'],
    PluginDto.fromSummaryJson,
  );
}

class AgentDto {
  AgentDto.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    id = pluginJsonId(json['id']);
    if (json['object'] != 'agent') throw const PluginProtocolException();
    created = _integer(json['created'], minimum: 0);
    ownedBy = pluginJsonString(json['owned_by']);
    name = pluginJsonString(json['name']);
    description = pluginJsonString(json['description']);
    defaultModel = _optional(json, 'defaultModel', pluginJsonString);
    visionCapable = _boolean(json['visionCapable']);
    temperature = _optional(json, 'temperature', (v) => (v as num).toDouble());
    maxTokens = _optional(json, 'maxTokens', (v) => _integer(v, minimum: 1));
    toolGrants = _optional(
      json, 'toolGrants',
      (list) => pluginJsonList(list, (v) => AgentToolGrant.fromJson(v)),
    ) ?? const [];
    skillCount = _integer(json['skillCount'], minimum: 0);
  }

  late final String id;
  late final int created;
  late final String ownedBy;
  late final String name;
  late final String description;
  late final String? defaultModel;
  late final bool visionCapable;
  late final double? temperature;
  late final int? maxTokens;
  late final List<AgentToolGrant> toolGrants;
  late final int skillCount;

  static List<AgentDto> parseList(Object? value) {
    final json = pluginJsonObject(value);
    if (json['object'] != 'list') throw const PluginProtocolException();
    return pluginJsonList(json['data'], AgentDto.fromJson);
  }
}

class AgentToolGrant {
  AgentToolGrant.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    pluginId = pluginJsonId(json['pluginId']);
    required = _boolean(json['required']);
  }

  late final String pluginId;
  late final bool required;
}

class PluginModelDto {
  PluginModelDto.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    id = pluginJsonId(json['id']);
    if (json['object'] != 'model') throw const PluginProtocolException();
    created = _integer(json['created'], minimum: 0);
    ownedBy = pluginJsonString(json['owned_by']);
    defaultModel = pluginJsonString(json['defaultModel']);
    tokenLimit = _integer(json['tokenLimit']);
    visionCapable = _boolean(json['visionCapable']);
    supportsStreaming = _boolean(json['supportsStreaming']);
    parameters = freezePluginJson(
      pluginJsonObject(json['parameters']),
    ) as Map<String, dynamic>;
  }

  late final String id;
  late final int created;
  late final String ownedBy;
  late final String defaultModel;
  late final int tokenLimit;
  late final bool visionCapable;
  late final bool supportsStreaming;
  late final Map<String, dynamic> parameters;

  static List<PluginModelDto> parseList(Object? value) {
    final json = pluginJsonObject(value);
    if (json['object'] != 'list') throw const PluginProtocolException();
    return pluginJsonList(json['data'], PluginModelDto.fromJson);
  }
}

Object? decodePluginJson(String value) {
  try {
    return jsonDecode(value);
  } on FormatException {
    throw const PluginProtocolException();
  }
}
