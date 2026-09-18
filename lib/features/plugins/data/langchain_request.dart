import '../../chat/data/message_model.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

class LangChainRequest {
  LangChainRequest({
    required this.gatewayKey,
    required this.modelPluginId,
    required Map<String, Map<String, String>> credentials,
    required List<ApiMessage> messages,
    this.conversationPublicId,
    this.turnId,
    this.managed = false,
    List<String> enabledPlugins = const [],
  }) : enabledPlugins = List.unmodifiable(enabledPlugins),
       credentials = Map.unmodifiable(
         credentials.map(
           (id, fields) =>
               MapEntry(id, Map<String, String>.unmodifiable(fields)),
         ),
       ),
       messages = List.unmodifiable(messages.map(_copyMessage)) {
    if (gatewayKey.trim().isEmpty || gatewayKey.contains(RegExp(r'[\r\n]'))) {
      throw const PluginClientException('missing_gateway_key');
    }
    pluginJsonId(modelPluginId);
    for (final id in enabledPlugins) {
      pluginJsonId(id);
    }
    if (managed && (turnId == null || turnId!.trim().isEmpty)) {
      throw const PluginClientException('invalid_request');
    }
    for (final id in credentials.keys) {
      pluginJsonId(id);
    }
    if (messages.isEmpty ||
        messages.any(
          (m) => !['system', 'user', 'assistant', 'tool'].contains(m.role),
        ) ||
        conversationPublicId != null && conversationPublicId!.trim().isEmpty ||
        turnId != null && turnId!.trim().isEmpty) {
      throw const PluginClientException('invalid_request');
    }
  }

  final String gatewayKey;
  final String modelPluginId;
  final Map<String, Map<String, String>> credentials;
  final List<ApiMessage> messages;
  final String? conversationPublicId;
  final String? turnId;
  final bool managed;
  final List<String> enabledPlugins;

  Map<String, dynamic> toJson() => {
    'model': modelPluginId,
    'stream': true,
    if (managed) 'conversation_mode': 'managed',
    if (managed || enabledPlugins.isNotEmpty) 'enabled_plugins': enabledPlugins,
    'credentials': credentials,
    'messages': messages
        .map(
          (m) => {
            'role': m.role,
            'content': m.content,
            if (m.toolCalls != null) 'tool_calls': m.toolCalls,
            if (m.toolCallId != null) 'tool_call_id': m.toolCallId,
          },
        )
        .toList(),
    if (conversationPublicId != null) 'thread_id': conversationPublicId,
    if (turnId != null) 'messageId': turnId,
  };

  static ApiMessage _copyMessage(ApiMessage message) => ApiMessage(
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls == null
        ? null
        : List.unmodifiable(
            message.toolCalls!.map(
              (call) => freezePluginJson(call) as Map<String, dynamic>,
            ),
          ),
  );

  @override
  String toString() => 'LangChainRequest';
}
