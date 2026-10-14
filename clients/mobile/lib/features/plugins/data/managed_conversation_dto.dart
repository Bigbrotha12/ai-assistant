import '../../chat/data/chat_client.dart';
import '../../chat/data/message_model.dart';
import 'plugin_dto.dart';

class ManagedTurnResult {
  const ManagedTurnResult({
    required this.sessionId,
    required this.state,
    this.result,
    this.alreadyCompleted = false,
  });

  final String sessionId;
  final String state;
  final ChatResult? result;
  final bool alreadyCompleted;
}

String managedPublicId(Object? value) {
  if (value is! String ||
      value.trim().isEmpty ||
      value.length > 1024 ||
      value.contains(RegExp(r'[\r\n]'))) {
    throw const PluginProtocolException();
  }
  return value;
}

/// Accumulated conversation read back from `GET /v1/sessions/:id`. Keys
/// stable local ids off the session id (`'$sessionId-msg-$index'`).
class ManagedSessionHistory {
  ManagedSessionHistory.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    sessionId = managedPublicId(json['sessionId']);
    final raw = json['messages'];
    if (raw is! List) throw const PluginProtocolException();
    messages = List.unmodifiable(
      raw.indexed.map((entry) {
        // Distinct, stable local ids: every recovered message keyed to this
        // session's position so store upserts never collapse the history to a
        // single row (a bare '' primary key) and two conversations can never
        // share message rows. Tool messages keep their server `tool_call_id`
        // linkage untouched.
        final (index, value) = entry;
        final m = pluginJsonObject(value);
        final role = m['role'];
        final content = m['content'];
        if (!['user', 'assistant', 'system', 'tool'].contains(role) ||
            content != null && content is! String && content is! List) {
          throw const PluginProtocolException();
        }
        final calls = m['tool_calls'];
        if (calls != null && calls is! List) {
          throw const PluginProtocolException();
        }
        final tools = (calls as List?)?.map((value) {
          final call = pluginJsonObject(value);
          final function = pluginJsonObject(call['function']);
          return ToolCall(
            id: managedPublicId(call['id']),
            name: managedPublicId(function['name']),
            args: pluginJsonObject(
              decodePluginJson(function['arguments'] as String),
            ),
          );
        }).toList();
        final linkage = m['tool_call_id'];
        if (role == 'tool') managedPublicId(linkage);
        return Message(
          id: '$sessionId-msg-$index',
          role: MessageRole.values.byName(role as String),
          content: flattenMessageContent(content),
          toolCalls: tools,
          toolCallId: linkage as String?,
        );
      }),
    );
  }

  late final String sessionId;
  late final List<Message> messages;
}

/// Reduces a wire message's `content` to the local String model. A String
/// passes through; a List (multimodal `{type: 'text'|'image_url', ...}`
/// blocks, or a tool's array result) is flattened by concatenating the `text`
/// fields of its text blocks — image blocks are ignored for the local
/// `Message.content` string model. Anything else is a protocol error.
String flattenMessageContent(Object? content) {
  if (content == null) return '';
  if (content is String) return content;
  if (content is List) {
    final buffer = StringBuffer();
    for (final block in content) {
      if (block is Map<String, dynamic> && block['type'] == 'text') {
        final text = block['text'];
        if (text is String) buffer.write(text);
      }
    }
    return buffer.toString();
  }
  throw const PluginProtocolException();
}
