import '../../chat/data/chat_client.dart';
import '../../chat/data/message_model.dart';
import 'plugin_dto.dart';

/// Terminal status of a task referenced by `200 already_completed`, carried
/// verbatim from the server so failed/cancelled tasks are never conflated with
/// a successful turn.
enum ManagedTerminalStatus { succeeded, failed, cancelled, unknown }

ManagedTerminalStatus parseManagedTerminalStatus(Object? value) {
  return switch (value) {
    'succeeded' => ManagedTerminalStatus.succeeded,
    'failed' => ManagedTerminalStatus.failed,
    'cancelled' => ManagedTerminalStatus.cancelled,
    _ => ManagedTerminalStatus.unknown,
  };
}

class ManagedTurnResult {
  const ManagedTurnResult({
    required this.threadId,
    required this.state,
    this.result,
    this.taskId,
    this.terminalStatus = ManagedTerminalStatus.unknown,
  });

  final String threadId;
  final String state;
  final ChatResult? result;
  final String? taskId;
  final ManagedTerminalStatus terminalStatus;
  bool get alreadyCompleted => taskId != null;
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

class ManagedThreadSummary {
  ManagedThreadSummary.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    threadId = managedPublicId(json['threadId']);
    final count = json['messageCount'];
    if (count is! int || count < 0) throw const PluginProtocolException();
    messageCount = count;
  }

  late final String threadId;
  late final int messageCount;
}

class ManagedThreadHistory {
  ManagedThreadHistory.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    threadId = managedPublicId(json['threadId']);
    final raw = json['messages'];
    if (raw is! List) throw const PluginProtocolException();
    messages = List.unmodifiable(
      raw.indexed.map((entry) {
        // Distinct, stable local ids: every recovered message keyed to this
        // thread's position so store upserts never collapse the history to a
        // single row (a bare '' primary key) and two conversations can never
        // share message rows. Tool messages keep their server `tool_call_id`
        // linkage untouched.
        final (index, value) = entry;
        final m = pluginJsonObject(value);
        final role = m['role'];
        if (!['user', 'assistant', 'system', 'tool'].contains(role) ||
            m['content'] != null && m['content'] is! String) {
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
          id: '$threadId-msg-$index',
          role: MessageRole.values.byName(role as String),
          content: m['content'] as String? ?? '',
          toolCalls: tools,
          toolCallId: linkage as String?,
        );
      }),
    );
  }

  late final String threadId;
  late final List<Message> messages;
}
