import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/ui/conversation_list.dart';

import '../../fakes.dart';

Conversation conversation(String id, String title) => Conversation(
      id: id,
      title: title,
      createdAt: DateTime(2024),
      updatedAt: DateTime(2024),
      messages: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
      ],
    );

Widget listApp({required FakeChatStore store, Set<String> pending = const {}}) {
  return ProviderScope(
    overrides: [
      chatStoreProvider.overrideWithValue(store),
      pendingConversationIdsProvider.overrideWithValue(AsyncData(pending)),
    ],
    child: const MaterialApp(home: ConversationListScreen()),
  );
}

void main() {
  testWidgets(
      'a conversation with a pending job shows the hourglass indicator and '
      'conversations without one do not', (tester) async {
    final store = FakeChatStore(initial: [
      conversation('c1', 'Pending one'),
      conversation('c2', 'Idle one'),
    ]);
    await tester.pumpWidget(listApp(store: store, pending: const {'c1'}));
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.hourglass_top), findsOneWidget);
    final pendingRow = tester.widget<ListTile>(
      find.ancestor(
        of: find.text('Pending one'),
        matching: find.byType(ListTile),
      ),
    );
    expect(pendingRow.trailing, isNotNull);
    final idleRow = tester.widget<ListTile>(
      find.ancestor(
        of: find.text('Idle one'),
        matching: find.byType(ListTile),
      ),
    );
    expect(idleRow.trailing, isNull);
  });

  testWidgets('no indicator is shown when the pending set is empty',
      (tester) async {
    final store = FakeChatStore(initial: [conversation('c1', 'Only one')]);
    await tester.pumpWidget(listApp(store: store));
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.hourglass_top), findsNothing);
  });

  testWidgets('tapping a pending row still pops its conversation id '
      '(the indicator is not an interaction surface)', (tester) async {
    String? poppedId;
    final store = FakeChatStore(initial: [conversation('c1', 'Pending one')]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          chatStoreProvider.overrideWithValue(store),
          pendingConversationIdsProvider.overrideWithValue(
            const AsyncData<Set<String>>({'c1'}),
          ),
        ],
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () async {
                    poppedId = await Navigator.push<String>(
                      context,
                      MaterialPageRoute<String>(
                        builder: (_) => const ConversationListScreen(),
                      ),
                    );
                  },
                  child: const Text('open-history'),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open-history'));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.hourglass_top), findsOneWidget);

    await tester.tap(find.text('Pending one'));
    await tester.pumpAndSettle();
    expect(poppedId, 'c1');
  });
}
