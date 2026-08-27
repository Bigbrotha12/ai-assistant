import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/core/chat_client_provider.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/chat/chat_screen.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';
import 'package:ai_assistant/features/chat/message_model.dart';

import 'fakes.dart';

Widget chatApp({
  required FakeSettingsStore store,
  required FakeProbe probe,
  required FakeChatStore chatStore,
  required FakeChatClient client,
}) {
  return ProviderScope(
    overrides: [
      settingsStoreProvider.overrideWithValue(store),
      backendProbeProvider.overrideWithValue(probe),
      chatStoreProvider.overrideWithValue(chatStore),
      chatApiClientProvider.overrideWithValue(client),
    ],
    child: const MaterialApp(home: ChatScreen()),
  );
}

void main() {
  testWidgets('ChatScreen renders empty state with input enabled',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: FakeChatClient(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('AI Assistant'), findsOneWidget);
    expect(find.text('Message…'), findsOneWidget);
    final textField = tester.widget<TextField>(find.byType(TextField));
    expect(textField.enabled, isTrue);
    final sendButton = tester.widget<IconButton>(
      find.ancestor(of: find.byIcon(Icons.send), matching: find.byType(IconButton)),
    );
    expect(sendButton.onPressed, isNull);
  });

  testWidgets('typing and tapping Send appends a user bubble and assistant reply',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient(
      results: const [
        ChatResult(
          content: 'Hello back',
          toolCalls: [],
          finishReason: 'stop',
        ),
      ],
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Hi there');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(find.text('Hi there'), findsOneWidget);
    expect(find.text('Hello back'), findsOneWidget);
  });

  testWidgets('assistant reply renders markdown', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient(
      results: const [
        ChatResult(
          content: 'This is **bold** and *italic*.',
          toolCalls: [],
          finishReason: 'stop',
        ),
      ],
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(find.textContaining('bold'), findsOneWidget);
  });

  testWidgets('markdown images never render an Image widget (SSRF guard)',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient(
      results: const [
        ChatResult(
          content: '![x](http://10.0.0.1/) ![sized](http://10.0.0.2/a.png#50x50)',
          toolCalls: [],
          finishReason: 'stop',
        ),
      ],
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    // Plain and sized image markdown must not produce an Image widget (which
    // would fetch the URL via Image.network and allow SSRF into internal
    // tailnet services).
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('tool-call chip renders when assistant message has toolCalls',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient(
      results: const [
        ChatResult(
          content: '',
          toolCalls: [
            ToolCall(id: 'tc1', name: 'list_voices', result: '2 voices'),
          ],
          finishReason: 'tool_calls',
        ),
      ],
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'list voices');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(find.textContaining('list_voices'), findsWidgets);
  });

  testWidgets('Stop button appears while streaming and stops the stream',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient(
      results: const [
        ChatResult(content: 'partial', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final hang = Completer<ChatResult>();
    client.hang = hang;
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump();

    expect(find.byIcon(Icons.stop), findsOneWidget);

    await tester.tap(find.byIcon(Icons.stop));
    await tester.pump();
    hang.complete(
      const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.stop), findsNothing);
  });

  testWidgets('error banner and Retry button appear when client errors',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final client = FakeChatClient()..error = 'boom';
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: client,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('History screen lists conversations and delete removes one',
      (tester) async {
    final now = DateTime.now();
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final chatStore = FakeChatStore(
      initial: [
        Conversation(
          id: 'c1',
          title: 'First chat',
          messages: const [],
          createdAt: now,
          updatedAt: now,
        ),
        Conversation(
          id: 'c2',
          title: 'Second chat',
          messages: const [],
          createdAt: now,
          updatedAt: now,
        ),
      ],
    );
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: chatStore,
      client: FakeChatClient(),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pumpAndSettle();
    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();

    expect(find.text('First chat'), findsOneWidget);
    expect(find.text('Second chat'), findsOneWidget);

    await tester.drag(find.text('First chat'), const Offset(-500, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(find.text('First chat'), findsNothing);
    expect(find.text('Second chat'), findsOneWidget);
  });

  testWidgets('Configure Backend banner shows when settings invalid',
      (tester) async {
    final store = FakeSettingsStore(); // no stored settings -> invalid
    await tester.pumpWidget(chatApp(
      store: store,
      probe: FakeProbe(),
      chatStore: FakeChatStore(),
      client: FakeChatClient(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Backend not configured'), findsOneWidget);
    expect(find.text('Configure Backend'), findsOneWidget);
  });
}
