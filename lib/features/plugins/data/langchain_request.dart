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
    this.background = false,
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
    // Both managed and background requests carry a client-minted idempotency
    // key (`messageId`); a background request without one is a 400 server-side.
    if ((managed || background) && (turnId == null || turnId!.trim().isEmpty)) {
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

  /// Session id (was public thread id). The gateway keys its in-memory session
  /// store on this; sent as `session_id` on the wire. Absent for background
  /// submissions — an async job runs on the submitted snapshot and must NOT
  /// carry a session dependency (plan §5).
  final String? conversationPublicId;

  final String? turnId;
  final bool managed;

  /// Async submission (plan §5): the gateway admits an idempotent background
  /// task (keyed by `messageId`) instead of streaming; the client polls the
  /// ledger for the terminal status and reads the reply back. Background
  /// requests ship the FULL trimmed history as `messages` and never include a
  /// `session_id`/`conversation_mode`.
  final bool background;
  final List<String> enabledPlugins;

  Map<String, dynamic> toJson() => {
    'model': modelPluginId,
    'stream': true,
    if (background) 'background': true,
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
    if (conversationPublicId != null) 'session_id': conversationPublicId,
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
