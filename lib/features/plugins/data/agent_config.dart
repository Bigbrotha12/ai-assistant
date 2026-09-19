enum AgentKind { template, custom }

class AgentConfig {
  AgentConfig({
    required this.id,
    required this.kind,
    this.name = '',
    this.description,
    this.systemPrompt,
    this.skills = const [],
    this.mcpServers = const [],
    this.tools = const [],
    this.modelRef,
    this.inference,
  });

  final String id;
  final AgentKind kind;
  final String name;
  final String? description;
  final String? systemPrompt;
  final List<String> skills;
  final List<String> mcpServers;
  final List<AgentToolGrantData> tools;
  final String? modelRef;
  final AgentInferenceData? inference;

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind.name,
    'name': name,
    if (description != null) 'description': description,
    if (systemPrompt != null) 'systemPrompt': systemPrompt,
    'skills': skills,
    'mcpServers': mcpServers,
    'tools': tools.map((t) => t.toJson()).toList(),
    if (modelRef != null) 'modelRef': modelRef,
    if (inference != null) 'inference': inference!.toJson(),
  };

  factory AgentConfig.fromJson(Map<String, dynamic> json) => AgentConfig(
    id: json['id'] as String,
    kind: AgentKind.values.firstWhere((k) => k.name == json['kind']),
    name: json['name'] as String? ?? '',
    description: json['description'] as String?,
    systemPrompt: json['systemPrompt'] as String?,
    skills: (json['skills'] as List<dynamic>?)?.cast<String>() ?? [],
    mcpServers: (json['mcpServers'] as List<dynamic>?)?.cast<String>() ?? [],
    tools: (json['tools'] as List<dynamic>?)?.map((t) => AgentToolGrantData.fromJson(t as Map<String, dynamic>)).toList() ?? [],
    modelRef: json['modelRef'] as String?,
    inference: json['inference'] != null ? AgentInferenceData.fromJson(json['inference'] as Map<String, dynamic>) : null,
  );
}

class AgentToolGrantData {
  AgentToolGrantData({required this.pluginId, this.required = false});
  final String pluginId;
  final bool required;
  Map<String, dynamic> toJson() => {'pluginId': pluginId, 'required': required};
  factory AgentToolGrantData.fromJson(Map<String, dynamic> json) => AgentToolGrantData(
    pluginId: json['pluginId'] as String,
    required: json['required'] as bool? ?? false,
  );
}

class AgentInferenceData {
  AgentInferenceData({this.temperature, this.maxTokens, this.visionCapable = false});
  final double? temperature;
  final int? maxTokens;
  final bool visionCapable;
  Map<String, dynamic> toJson() => {
    if (temperature != null) 'temperature': temperature,
    if (maxTokens != null) 'maxTokens': maxTokens,
    'visionCapable': visionCapable,
  };
  factory AgentInferenceData.fromJson(Map<String, dynamic> json) => AgentInferenceData(
    temperature: (json['temperature'] as num?)?.toDouble(),
    maxTokens: json['maxTokens'] as int?,
    visionCapable: json['visionCapable'] as bool? ?? false,
  );
}