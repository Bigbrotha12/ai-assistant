import 'dart:convert';

import 'package:ai_assistant/features/chat/message_model.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Message', () {
    test('constructs with default nulls', () {
      final message = Message(
        id: 'msg-1',
        role: MessageRole.user,
        content: 'Hello',
      );
      expect(message.id, 'msg-1');
      expect(message.role, MessageRole.user);
      expect(message.content, 'Hello');
      expect(message.toolCallId, isNull);
      expect(message.toolCalls, isNull);
      expect(message.createdAt, isNull);
    });

    test('fromJson/toJson round-trip', () {
      final message = Message(
        id: 'msg-2',
        role: MessageRole.assistant,
        content: 'Hi',
        toolCalls: const [
          ToolCall(id: 'call_1', name: 'voices', args: {'limit': 3}),
        ],
        createdAt: DateTime.utc(2026, 8, 27),
      );
      final json = message.toJson();
      final restored = Message.fromJson(json);
      expect(restored, message);
      expect(restored.toolCalls!.single.args, {'limit': 3});
    });

    test('round-trip with null toolCallId', () {
      final message = Message(
        id: 'msg-3',
        role: MessageRole.tool,
        content: 'result',
        toolCallId: null,
      );
      final restored = Message.fromJson(message.toJson());
      expect(restored.toolCallId, isNull);
      expect(restored, message);
    });
  });

  group('ToolCall', () {
    test('fromJson/toJson round-trip', () {
      final call = ToolCall(
        id: 'call_2',
        name: 'voices',
        args: {'topK': 5},
        result: 'done',
      );
      final restored = ToolCall.fromJson(call.toJson());
      expect(restored, call);
      expect(restored.result, 'done');
    });

    test('round-trip with null args', () {
      final call = ToolCall(id: 'call_3', name: 'voices');
      final restored = ToolCall.fromJson(call.toJson());
      expect(restored.args, isNull);
      expect(restored, call);
    });
  });

  group('Conversation', () {
    test('fromJson/toJson round-trip', () {
      final conversation = Conversation(
        id: 'conv-1',
        title: 'A long title that should be truncated',
        messages: const [
          Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        ],
        createdAt: DateTime.utc(2026, 8, 27),
        updatedAt: DateTime.utc(2026, 8, 27, 12),
      );
      final restored = Conversation.fromJson(conversation.toJson());
      expect(restored, conversation);
      expect(restored.messages.single.content, 'hi');
    });

    test('equality', () {
      final a = Conversation(
        id: 'c1',
        title: 't',
        messages: const [],
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
      );
      final b = Conversation(
        id: 'c1',
        title: 't',
        messages: const [],
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
      );
      final c = Conversation(
        id: 'c2',
        title: 't',
        messages: const [],
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
      );
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a == c, isFalse);
    });
  });

  group('toApiMessages', () {
    test('user message maps to role/content', () {
      final result = toApiMessages([
        Message(id: '1', role: MessageRole.user, content: 'Hello there'),
      ]);
      expect(result, hasLength(1));
      expect(result.single.role, 'user');
      expect(result.single.content, 'Hello there');
      expect(result.single.toolCalls, isNull);
      expect(result.single.toolCallId, isNull);
    });

    test('assistant with tools serializes arguments as JSON string', () {
      final result = toApiMessages([
        Message(
          id: '2',
          role: MessageRole.assistant,
          content: 'call',
          toolCalls: const [
            ToolCall(id: 'call_x', name: 'voices', args: {'topK': 3}),
          ],
        ),
      ]);
      expect(result, hasLength(1));
      final api = result.single;
      expect(api.role, 'assistant');
      expect(api.content, isNull);
      final call = api.toolCalls!.single;
      expect(call['id'], 'call_x');
      expect(call['type'], 'function');
      expect(call['function']['name'], 'voices');
      expect(call['function']['arguments'], jsonEncode({'topK': 3}));
    });

    test('tool result with toolCallId', () {
      final result = toApiMessages([
        Message(
          id: '3',
          role: MessageRole.tool,
          content: 'the result',
          toolCallId: 'call_x',
        ),
      ]);
      expect(result, hasLength(1));
      expect(result.single.role, 'tool');
      expect(result.single.content, 'the result');
      expect(result.single.toolCallId, 'call_x');
    });

    test('assistant without tools maps to content', () {
      final result = toApiMessages([
        Message(id: '4', role: MessageRole.assistant, content: 'plain answer'),
      ]);
      expect(result, hasLength(1));
      expect(result.single.role, 'assistant');
      expect(result.single.content, 'plain answer');
      expect(result.single.toolCalls, isNull);
    });

    test('skips tool message missing toolCallId', () {
      final result = toApiMessages([
        Message(id: '1', role: MessageRole.user, content: 'start'),
        Message(id: '2', role: MessageRole.tool, content: 'orphan result'),
        Message(id: '3', role: MessageRole.user, content: 'end'),
      ]);
      expect(result, hasLength(2));
      expect(result[0].content, 'start');
      expect(result[1].content, 'end');
    });
  });
}
