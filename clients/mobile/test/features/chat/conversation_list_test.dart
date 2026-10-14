import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/ui/conversation_list.dart';

import '../../fakes.dart';

Conversation conversation(String id, String title) => Conversation(
  id: id,
  title: title,
  createdAt: DateTime(2024),
  updatedAt: DateTime(2024),
  messages: const [Message(id: 'm1', role: MessageRole.user, content: 'hi')],
);

Widget listApp({
  required FakeChatStore store,
  Map<String, LedgerTaskProjection> projections = const {},
}) {
  return ProviderScope(
    overrides: [
      chatStoreProvider.overrideWithValue(store),
      backgroundJobProjectionsProvider.overrideWithValue(
        AsyncData(projections),
      ),
    ],
    child: const MaterialApp(home: ConversationListScreen()),
  );
}

void main() {
  testWidgets(
    'a conversation with a pending job shows the hourglass indicator and '
    'conversations without one do not',
    (tester) async {
      final store = FakeChatStore(
        initial: [
          conversation('c1', 'Pending one'),
          conversation('c2', 'Idle one'),
        ],
      );
      await tester.pumpWidget(
        listApp(
          store: store,
          projections: {'c1': LedgerTaskProjection.queued()},
        ),
      );
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
    },
  );

  testWidgets('review projection uses a distinct conversation-list chip', (
    tester,
  ) async {
    final store = FakeChatStore(initial: [conversation('c1', 'Review one')]);
    await tester.pumpWidget(
      listApp(
        store: store,
        projections: {
          'c1': const LedgerTaskProjection(
            code: LedgerTaskProgressCode.review,
            canCancel: false,
            canRetry: false,
            effectState: LedgerTaskEffectState.completedStepsOnly,
            terminalStatus: LedgerTaskStatus.awaitingReview,
          ),
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.rate_review_outlined), findsOneWidget);
    expect(find.byIcon(Icons.hourglass_top), findsNothing);
    expect(
      tester.widget<Icon>(find.byIcon(Icons.rate_review_outlined)).semanticLabel,
      'Background job awaiting review',
    );
  });

  testWidgets('no indicator is shown when the pending set is empty', (
    tester,
  ) async {
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
          backgroundJobProjectionsProvider.overrideWithValue(
            AsyncData<Map<String, LedgerTaskProjection>>({
              'c1': LedgerTaskProjection.queued(),
            }),
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
