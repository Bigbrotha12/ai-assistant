import 'package:dio/dio.dart';
import 'package:drift/native.dart' show NativeDatabase;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_screen.dart';
import 'package:ai_assistant/features/chat/ui/message_bubble.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';

import '../../fakes.dart';

class _FixedActiveId extends ActiveConversationNotifier {
  @override
  String? build() => 'c1';
}

class _SlowClient implements ChatClient {
  final List<(String, Duration)> _deltas;

  _SlowClient(this._deltas);

  @override
  Future<ChatResult> streamCompletions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)? onToolCallDelta,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) async {
    for (final (text, delay) in _deltas) {
      await Future<void>.delayed(delay);
      onContent?.call(text);
    }
    return const ChatResult(content: 'SECOND ANSWER', toolCalls: [], finishReason: 'stop');
  }

  @override
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) {
    throw UnimplementedError();
  }
}

void main() {
  testWidgets('render tree: bubbles shown at each phase of a send',
      (tester) async {
    final db = AppDatabase(NativeDatabase.memory());
    addTearDown(db.close);
    final chatStore = DriftChatStore(db);
    await chatStore.ensureConversation(
      'c1',
      title: 'existing',
      firstMessage: const Message(
        id: 'u1',
        role: MessageRole.user,
        content: 'FIRST Q',
        createdAt: null,
      ),
    );
    await chatStore.appendMessage(
      'c1',
      const Message(
        id: 'a1',
        role: MessageRole.assistant,
        content: 'FIRST A',
        createdAt: null,
      ),
    );

    final client = _SlowClient([
      ('SEC', const Duration(milliseconds: 50)),
      ('OND', const Duration(milliseconds: 50)),
    ]);

    await tester.pumpWidget(ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'myhost')),
        ),
        backendProbeProvider.overrideWithValue(FakeProbe()),
        chatStoreProvider.overrideWithValue(chatStore),
        chatApiClientProvider.overrideWithValue(client),
        activeConversationIdProvider.overrideWith(_FixedActiveId.new),
        filesStoreProvider.overrideWithValue(FakeFileStore()),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ));
    await tester.pumpAndSettle();

    List<String> bubbles() => tester
        .widgetList<MessageBubble>(find.byType(MessageBubble))
        .map((b) => '${b.message.role.name}:${b.message.content}')
        .toList();

    // ignore: avoid_print
    print('INIT: ${bubbles()}');

    await tester.enterText(find.byType(TextField), 'SECOND Q');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump();
    // ignore: avoid_print
    print('T+0ms: ${bubbles()}');

    await tester.pump(const Duration(milliseconds: 30));
    // ignore: avoid_print
    print('T+30ms: ${bubbles()}');

    await tester.pump(const Duration(milliseconds: 40));
    // ignore: avoid_print
    print('T+70ms: ${bubbles()}');

    await tester.pump(const Duration(milliseconds: 60));
    // ignore: avoid_print
    print('T+130ms: ${bubbles()}');

    await tester.pumpAndSettle();
    // ignore: avoid_print
    print('DONE: ${bubbles()}');

    // Expect exactly one user + one assistant per turn, no duplicates.
    expect(bubbles().where((b) => b == 'assistant:FIRST A'), hasLength(1));
    expect(bubbles().where((b) => b == 'user:SECOND Q'), hasLength(1));
    expect(bubbles().where((b) => b.contains('SECOND ANSWER')), hasLength(1));
    expect(bubbles(), hasLength(4));
  });
}