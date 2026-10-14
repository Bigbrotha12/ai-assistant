import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> sessionJson(
  String sessionId,
  List<Map<String, Object?>> messages,
) =>
    {'sessionId': sessionId, 'messages': messages};

const toolCall = <String, Object?>{
  'id': 'call_1',
  'type': 'function',
  'function': {'name': 'web_search', 'arguments': '{"q":"weather"}'},
};

void main() {
  group('ManagedSessionHistory.fromJson reconciliation ids', () {
    test('every recovered message gets a distinct, stable id keyed to the '
        'session', () {
      final history = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'hello'},
          {'role': 'user', 'content': 'again'},
        ]),
      );
      expect(history.messages, hasLength(3));
      final ids = history.messages.map((m) => m.id).toList();
      expect(ids.every((id) => id.isNotEmpty), isTrue);
      expect(ids.toSet(), hasLength(3));

      // Deterministic across parses: a re-reconciliation yields the same ids so
      // store upserts overwrite rows in place instead of collapsing to one ''.
      final reparsed = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'hello'},
          {'role': 'user', 'content': 'again'},
        ]),
      );
      expect(reparsed.messages.map((m) => m.id).toList(), ids);
    });

    test('ids are disjoint across sessions so rows never bleed between '
        'conversations', () {
      final a = ManagedSessionHistory.fromJson(
        sessionJson('session-a', [
          {'role': 'user', 'content': 'hi'},
        ]),
      );
      final b = ManagedSessionHistory.fromJson(
        sessionJson('session-b', [
          {'role': 'user', 'content': 'hi'},
        ]),
      );
      expect(a.messages.single.id, isNot(b.messages.single.id));
    });

    test('tool messages keep their server tool_call_id linkage', () {
      final history = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {
            'role': 'assistant',
            'content': null,
            'tool_calls': [toolCall],
          },
          {'role': 'tool', 'content': 'results', 'tool_call_id': 'call_1'},
        ]),
      );
      final assistant = history.messages.first;
      expect(assistant.role, MessageRole.assistant);
      expect(assistant.toolCalls!.single.id, 'call_1');
      expect(assistant.toolCalls!.single.name, 'web_search');
      expect(assistant.toolCalls!.single.args, {'q': 'weather'});
      final tool = history.messages.last;
      expect(tool.role, MessageRole.tool);
      expect(tool.toolCallId, 'call_1');
    });

    test('malformed roles, content, or missing tool linkage are rejected', () {
      expect(
        () => ManagedSessionHistory.fromJson(
          sessionJson('pub-1', [
            {'role': 'robot', 'content': 'x'},
          ]),
        ),
        throwsA(isA<PluginProtocolException>()),
      );
      expect(
        () => ManagedSessionHistory.fromJson(
          sessionJson('pub-1', [
            {'role': 'tool', 'content': 'x'},
          ]),
        ),
        throwsA(isA<PluginProtocolException>()),
      );
      expect(
        () => ManagedSessionHistory.fromJson(
          sessionJson('pub-1', [
            {'role': 'user', 'content': 42},
          ]),
        ),
        throwsA(isA<PluginProtocolException>()),
      );
      expect(ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {'role': 'user', 'content': null},
        ]),
      ).messages.single.content, isEmpty);
    });

    test('multimodal (image_url) content blocks flatten to their text and '
        'never break reconciliation', () {
      final history = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {
            'role': 'user',
            'content': [
              {'type': 'text', 'text': 'Look at '},
              {
                'type': 'image_url',
                'image_url': {'url': 'data:image/png;base64,AAAA'},
              },
            ],
          },
          {'role': 'assistant', 'content': 'nice picture'},
        ]),
      );
      expect(history.messages, hasLength(2));
      // Leading text is preserved; the image block is ignored for the local
      // String content model.
      expect(history.messages.first.content, 'Look at ');
      expect(history.messages.last.content, 'nice picture');
    });

    test('tool messages with an array content flatten the same way', () {
      final history = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {'role': 'user', 'content': 'run the tool'},
          {
            'role': 'assistant',
            'content': null,
            'tool_calls': [toolCall],
          },
          {
            'role': 'tool',
            'content': [
              {'type': 'text', 'text': 'result-a'},
              {'type': 'text', 'text': 'result-b'},
            ],
            'tool_call_id': 'call_1',
          },
        ]),
      );
      final tool = history.messages.last;
      expect(tool.role, MessageRole.tool);
      expect(tool.toolCallId, 'call_1');
      expect(tool.content, 'result-aresult-b');
    });

    test('recovered history persists as distinct rows in the store (no row '
        'collapse)', () async {
      final db = AppDatabase(NativeDatabase.memory());
      addTearDown(db.close);
      final store = DriftChatStore(db);
      final history = ManagedSessionHistory.fromJson(
        sessionJson('pub-1', [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'from server'},
        ]),
      );
      await store.saveConversation(
        Conversation(
          id: 'c1',
          title: 'T',
          createdAt: DateTime(2024),
          updatedAt: DateTime(2024),
          messages: List.of(history.messages),
        ),
      );
      final loaded = await store.loadConversation('c1');
      expect(loaded!.messages, hasLength(2));
      expect(loaded.messages.map((m) => m.id).toSet(), hasLength(2));
      expect(loaded.messages.map((m) => m.role).toList(), [
        MessageRole.user,
        MessageRole.assistant,
      ]);
    });
  });
}