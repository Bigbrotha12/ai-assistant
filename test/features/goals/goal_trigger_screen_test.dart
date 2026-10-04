import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_screen.dart';
import 'package:ai_assistant/features/goals/data/goal_providers.dart';
import 'package:ai_assistant/features/goals/ui/goal_todo_screen.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../fakes.dart';
import 'goal_client_test.dart' show FakeAdapter, jsonResponse;
import 'goal_providers_test.dart'
    show InMemorySecureStorage, TestAuth, credentials;

/// Phase 3.7's send surface end-to-end: arm the goal trigger in the chat
/// composer, send, and land on the todo view — the §12 POST then the §12 GET,
/// with the chat path untouched while the trigger is disarmed.

const _goalId = 'g_550e8400-e29b-41d4-a716-446655440000';

Map<String, Object?> _detailJson() => {
  'goalId': _goalId,
  'status': 'running',
  'pauseReason': null,
  'pauseQuestion': null,
  'resultSummary': null,
  'failureReason': null,
  'instruction': "plan tomorrow's meals",
  'todos': ['buy salmon'],
  'tokenBudget': 200000,
  'tokensSpent': 41230,
  'effectState': 'none_known',
  'canCancel': true,
  'canResume': false,
  'terminal': false,
  'unresolvedMutations': <Object?>[],
  'steps': <Object?>[],
  'updatedAt': '2026-10-04T00:01:00.000Z',
};

void main() {
  late FakeAdapter adapter;
  late List<Map<String, dynamic>> postedBodies;

  /// Builds the chat screen with the goal wiring live.
  ///
  /// Everything the trigger reads is created INSIDE the test body: a
  /// `PluginCredentialsStore` constructed in `setUp` pins its serialized-write
  /// queue to another zone, and an awaited `store.load` from the fake-async
  /// body then never resolves (the plugins screen tests build their store the
  /// same way).
  Future<void> pumpGoalChat(WidgetTester tester) async {
    final store = PluginCredentialsStore(storage: InMemorySecureStorage());
    final scope = AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gw.test',
      ownerId: 'owner-a',
    )!;
    await store.setSelectedModel(scope, 'openrouter');
    await store.setCredentials(scope, 'openrouter', {'apiKey': 'sk-stored'});
    await store.setAgentConfig(
      scope,
      'mealie-agent',
      AgentConfig(id: 'mealie-agent', kind: AgentKind.template),
    );
    await store.setSelectedAgent(scope, 'mealie-agent');

    postedBodies = [];
    adapter = FakeAdapter((options) {
      if (options.method == 'POST') {
        postedBodies.add(Map<String, dynamic>.from(options.data as Map));
        return jsonResponse({
          'goalId': _goalId,
          'status': 'queued',
          'todos': <Object?>[],
          'createdAt': '2026-10-04T00:00:00.000Z',
        });
      }
      return jsonResponse(_detailJson());
    });

    final chatStore = FakeChatStore();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(
            FakeSettingsStore(stored: const BackendSettings(host: 'myhost')),
          ),
          backendProbeProvider.overrideWithValue(FakeProbe()),
          chatStoreProvider.overrideWithValue(chatStore),
          managedChatAdapterProvider.overrideWithValue(
            FakeManagedChatAdapter(store: chatStore, script: FakeChatClient()),
          ),
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
          pluginAccountScopeProvider.overrideWithValue(scope),
          pluginCredentialsStoreProvider.overrideWithValue(store),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
        ],
        child: const MaterialApp(home: ChatScreen()),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('arming the trigger sends the text as a goal and opens its todos',
      (tester) async {
    await pumpGoalChat(tester);
    expect(find.text('Message…'), findsOneWidget);

    await tester.enterText(find.byType(TextField), "plan tomorrow's meals");
    await tester.pump();

    // Arm: the toggle gates on the account's configured agent first. The hint
    // is only rendered while the field is EMPTY, so read it off the
    // decoration — the field already holds the instruction.
    await tester.tap(find.byKey(const Key('goal-mode')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField)).decoration?.hintText,
      'Goal instruction…',
    );

    // Send admits the goal (§12 POST) instead of a chat turn…
    await tester.tap(
      find.ancestor(
        of: find.byIcon(Icons.send),
        matching: find.byType(IconButton),
      ),
    );
    await tester.pumpAndSettle();

    final body = postedBodies.single;
    expect(body['clientGoalId'], matches(RegExp(r'^[0-9a-f-]{36}$')));
    expect(body, {
      'instruction': "plan tomorrow's meals",
      'agent': 'mealie-agent',
      'modelPluginId': 'openrouter',
      'tokenBudget': kGoalTokenBudget,
      'clientGoalId': body['clientGoalId'],
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
    });

    // …and lands on the todo view, which renders the §12 GET.
    expect(find.byType(GoalTodoScreen), findsOneWidget);
    expect(find.text("plan tomorrow's meals"), findsOneWidget);
    expect(find.text('buy salmon'), findsOneWidget);

    // Back out: the trigger disarmed itself, so the composer is a chat
    // composer again and no poll outlives the screen.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.text('Message…'), findsOneWidget);
    expect(postedBodies, hasLength(1));
  });

  testWidgets('the trigger stays disarmed by default — Send is still a chat',
      (tester) async {
    await pumpGoalChat(tester);
    expect(find.text('Message…'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'just a chat message');
    await tester.pump();
    await tester.tap(
      find.ancestor(
        of: find.byIcon(Icons.send),
        matching: find.byType(IconButton),
      ),
    );
    await tester.pumpAndSettle();

    expect(postedBodies, isEmpty, reason: 'no goal is admitted by a chat send');
    expect(find.byType(GoalTodoScreen), findsNothing);
  });
}
