import './message_model.dart';

/// Enforces a client-side token budget so the 16k-context model is never
/// overflowed. Token estimate: (chars / 4).ceil().
class ContextTrimmer {
  final int maxTokens; // default 12000 for a 16k-context model
  const ContextTrimmer({this.maxTokens = 12000});

  /// Returns the largest TAIL of [messages] (most recent kept) whose
  /// estimated token count fits in the budget, ALWAYS keeping the newest
  /// user message, and NEVER splitting a tool-call pair (an assistant
  /// message with toolCalls + its following tool messages stay together).
  ///
  /// Messages earlier in the list (older) are dropped first.
  List<Message> trim(List<Message> messages) {
    if (messages.isEmpty) {
      return const [];
    }

    final newestUserIndex = _lastIndexOfRole(messages, MessageRole.user);

    // Kept messages, newest first (reversed before returning).
    final kept = <Message>[];
    var tokens = 0;
    // Once the budget is exceeded we drop everything older, except we always
    // keep the single newest user message.
    var dropped = false;

    for (var i = messages.length - 1; i >= 0; i--) {
      final message = messages[i];
      final isNewestUser = i == newestUserIndex;

      if (dropped) {
        if (isNewestUser) {
          kept.add(message);
          tokens += _estimateTokens(message);
        }
        continue;
      }

      final messageTokens = _estimateTokens(message);

      if (tokens + messageTokens <= maxTokens) {
        kept.add(message);
        tokens += messageTokens;
        continue;
      }

      // Over budget here. The newest user message is always kept as a last
      // resort; otherwise this message (and everything older) is dropped.
      if (isNewestUser) {
        kept.add(message);
        tokens += messageTokens;
        dropped = true;
        continue;
      }

      // Dropping an assistant message with toolCalls must also drop the tool
      // messages it owns (they were kept earlier because they are newer).
      if (message.role == MessageRole.assistant &&
          (message.toolCalls?.isNotEmpty ?? false)) {
        _removeOwnedToolMessages(kept, message);
      }

      dropped = true;
    }

    return kept.reversed.toList();
  }

  int _lastIndexOfRole(List<Message> messages, MessageRole role) {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role == role) {
        return i;
      }
    }
    return -1;
  }

  /// Removes from [kept] (newest-first) any tool messages owned by [assistant]
  /// (i.e. whose toolCallId matches one of the assistant's tool calls).
  void _removeOwnedToolMessages(List<Message> kept, Message assistant) {
    final callIds = (assistant.toolCalls ?? const <ToolCall>[])
        .map((c) => c.id)
        .toSet();
    if (callIds.isEmpty) {
      return;
    }
    kept.removeWhere((m) =>
        m.role == MessageRole.tool && callIds.contains(m.toolCallId));
  }

  int _estimateTokens(Message message) {
    var tokens = (message.content.length / 4).ceil();
    final calls = message.toolCalls;
    if (calls != null) {
      tokens += calls.length * 4;
    }
    return tokens;
  }
}
