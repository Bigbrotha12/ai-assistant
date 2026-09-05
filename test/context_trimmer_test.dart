import 'package:ai_assistant/features/chat/context_trimmer.dart';
import 'package:ai_assistant/features/chat/message_model.dart';
import 'package:flutter_test/flutter_test.dart';

Message _user(String id, String content) =>
    Message(id: id, role: MessageRole.user, content: content);

Message _assistant(String id, String content) =>
    Message(id: id, role: MessageRole.assistant, content: content);

Message _assistantWithTools(String id, List<ToolCall> calls) =>
    Message(id: id, role: MessageRole.assistant, content: 'call', toolCalls: calls);

Message _tool(String id, String callId, String content) =>
    Message(id: id, role: MessageRole.tool, content: content, toolCallId: callId);

ToolCall _call(String id) => ToolCall(id: id, name: 'voices');

void main() {
  group('ContextTrimmer', () {
    test('returns empty for empty input', () {
      final trimmer = ContextTrimmer();
      expect(trimmer.trim(const []), isEmpty);
    });

    test('keeps all messages when under budget', () {
      final messages = [
        _user('u1', 'hello'),
        _assistant('a1', 'hi there'),
        _user('u2', 'how are you'),
      ];
      final trimmer = ContextTrimmer(maxTokens: 1000);
      expect(trimmer.trim(messages), messages);
    });

    test('drops oldest messages when over budget', () {
      // ~40 chars per message => ~10 tokens each; budget fits 2 messages.
      final messages = [
        _user('u1', 'A' * 40), // 10 tokens
        _assistant('a1', 'B' * 40), // 10 tokens
        _user('u2', 'C' * 40), // 10 tokens
      ];
      final trimmer = ContextTrimmer(maxTokens: 20);
      final result = trimmer.trim(messages);
      // Only the newest 2 fit (20 tokens). Oldest u1 is dropped.
      expect(result.map((m) => m.id), ['a1', 'u2']);
      expect(result, messages.sublist(1));
    });

    test('keeps the newest user message even when it exceeds the budget', () {
      final messages = [
        _assistant('a1', 'A' * 4000), // ~1000 tokens
        _user('u1', 'old'),
        _user('u2', 'X' * 10000), // ~2500 tokens, way over budget
      ];
      final trimmer = ContextTrimmer(maxTokens: 100);
      final result = trimmer.trim(messages);
      expect(result.map((m) => m.id), ['u2']);
    });

    test('keeps tool-call pair together when it fits', () {
      final messages = [
        _user('u1', 'old'),
        _assistantWithTools('a1', [_call('call_1'), _call('call_2')]),
        _tool('t1', 'call_1', 'result one'),
        _tool('t2', 'call_2', 'result two'),
        _user('u2', 'newest'),
      ];
      final trimmer = ContextTrimmer(maxTokens: 1000);
      final result = trimmer.trim(messages);
      expect(result.map((m) => m.id), ['u1', 'a1', 't1', 't2', 'u2']);
    });

    test('drops tool pair when assistant tool-calls message is dropped', () {
      // The assistant with toolCalls is big enough to exceed the budget with
      // the newest user, forcing the whole pair (assistant + its tool results)
      // to be dropped.
      final messages = [
        _assistantWithTools(
          'a1',
          [_call('call_1')],
        ) /* small */,
        _tool('t1', 'call_1', 'result'),
        _assistantWithTools(
          'a2',
          [_call('call_2')],
        ),
        _tool('t2', 'call_2', 'huge result ' * 2000), // ~5000+ tokens
        _user('u1', 'question'),
      ];
      final trimmer = ContextTrimmer(maxTokens: 100);
      final result = trimmer.trim(messages);
      // The a2/t2 pair is dropped entirely; the older a1/t1 pair also goes
      // because it's older and the budget is exhausted. Only the newest user
      // survives.
      expect(result.map((m) => m.id), ['u1']);
    });

    test('does not split a tool pair', () {
      // Tool messages newer than their owner: if the assistant is dropped the
      // tool results must not survive alone.
      final messages = [
        _assistantWithTools('a1', [_call('call_1')]),
        _tool('t1', 'call_1', 'A' * 4000), // ~1000 tokens alone, over budget
        _user('u1', 'final question'),
      ];
      final trimmer = ContextTrimmer(maxTokens: 200);
      final result = trimmer.trim(messages);
      // Neither the orphaned tool result nor its dropped owner remain; only
      // the newest user message is kept.
      expect(result.map((m) => m.id), ['u1']);
    });

    test('preserves relative order', () {
      final messages = [
        _user('u1', 'first'),
        _assistant('a1', 'reply'),
        _user('u2', 'second'),
        _assistant('a2', 'another reply'),
        _user('u3', 'third'),
      ];
      final trimmer = ContextTrimmer(maxTokens: 1000);
      final result = trimmer.trim(messages);
      expect(result.map((m) => m.id), ['u1', 'a1', 'u2', 'a2', 'u3']);
    });
  });
}
