import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/goals/ui/goal_todo_screen.dart';
import 'package:ai_assistant/features/goals/ui/goals_overlay.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'goal_client_test.dart' show FakeAdapter, jsonResponse, summaryJson;
import 'goal_providers_test.dart' show TestAuth, credentials;

/// Phase 3.7's read-only goals overlay: opened from the gear chip, it lists
/// every goal, paginates behind an explicit footer, and hands a row off to the
/// todo view. It never mutates anything.

Map<String, Object?> _detailFor(String goalId) => {
  'goalId': goalId,
  'status': 'running',
  'pauseReason': null,
  'pauseQuestion': null,
  'resultSummary': null,
  'failureReason': null,
  'instruction': 'plan tomorrow\'s meals',
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

  Future<void> pumpHost(WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
          pluginAccountScopeProvider.overrideWithValue(
            AuthAccountScope.fromIdentity(
              backendOrigin: 'https://gw.test',
              ownerId: 'owner-a',
            )!,
          ),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Center(
              child: Builder(
                builder: (context) => IconButton(
                  key: const Key('open-goals'),
                  icon: const Icon(Icons.settings),
                  onPressed: () => showGoalsOverlay(context),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> open(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('open-goals')));
    await tester.pumpAndSettle();
  }

  testWidgets('lists the goals newest-first with their live state', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.uri.query.isNotEmpty) {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_run',
              status: 'running',
              instruction: 'plan meals',
            ),
            summaryJson(
              goalId: 'g_pause',
              status: 'paused',
              instruction: 'answer me',
              pauseQuestion: 'which flight?',
            ),
            summaryJson(
              goalId: 'g_fail',
              status: 'failed',
              instruction: 'bad idea',
              failureReason: 'step_cap_exceeded',
            ),
          ],
        });
      }
      return jsonResponse(_detailFor('g_run'));
    });
    await pumpHost(tester);
    await open(tester);

    expect(find.byKey(const Key('goals-overlay')), findsOneWidget);
    expect(find.text('plan meals'), findsOneWidget);
    expect(find.text('answer me'), findsOneWidget);
    expect(find.text('bad idea'), findsOneWidget);

    final rows = tester
        .widgetList<ListTile>(find.byType(ListTile))
        .map((tile) => (tile.title as Text).data)
        .toList();
    expect(rows, ['plan meals', 'answer me', 'bad idea']);

    // The actionable line outranks the plain status.
    expect(find.text('Running'), findsOneWidget);
    expect(find.text('Needs you: which flight?'), findsOneWidget);
    expect(find.text('step_cap_exceeded'), findsOneWidget);

    await tester.tap(find.byKey(const Key('goals-dismiss')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('goals-overlay')), findsNothing);
  });

  testWidgets('a row opens that goal\'s todo view (read-only)', (tester) async {
    adapter = FakeAdapter((options) {
      if (options.uri.query.isNotEmpty) {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_run',
              status: 'running',
              instruction: 'plan meals',
            ),
          ],
        });
      }
      return jsonResponse(_detailFor('g_run'));
    });
    await pumpHost(tester);
    await open(tester);

    await tester.tap(find.text('plan meals'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('goals-overlay')), findsNothing);
    expect(find.byType(GoalTodoScreen), findsOneWidget);
    expect(find.text('buy salmon'), findsOneWidget);

    // Back out of the todo view: its poll must not outlive the screen.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(GoalTodoScreen), findsNothing);
    expect(find.byKey(const Key('open-goals')), findsOneWidget);
  });

  testWidgets('older goals append behind the footer action', (tester) async {
    var listCalls = 0;
    adapter = FakeAdapter((options) {
      final offset = int.parse(options.uri.queryParameters['offset'] ?? '0');
      listCalls++;
      return jsonResponse(
        {
          'goals': [
            summaryJson(
              goalId: offset == 0 ? 'g_new' : 'g_old',
              instruction: offset == 0 ? 'newest' : 'oldest',
            ),
          ],
        },
        nextOffset: offset == 0 ? '100' : null,
      );
    });
    await pumpHost(tester);
    await open(tester);

    expect(find.text('newest'), findsOneWidget);
    expect(find.text('Show older goals…'), findsOneWidget);

    await tester.tap(find.text('Show older goals…'));
    await tester.pumpAndSettle();

    expect(listCalls, 2);
    expect(find.text('newest'), findsOneWidget);
    expect(find.text('oldest'), findsOneWidget);
    expect(find.text('Show older goals…'), findsNothing);
  });

  testWidgets('an empty account shows the empty state', (tester) async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'goals': <Object?>[]}),
    );
    await pumpHost(tester);
    await open(tester);

    expect(find.text('No goals yet.'), findsOneWidget);
    expect(find.byType(ListTile), findsNothing);
  });

  testWidgets('a failed load offers a retry instead of an empty list', (
    tester,
  ) async {
    // Fails until the test flips it, so however many times the provider
    // re-runs while the dialog settles, the visible state stays an error.
    var failing = true;
    var calls = 0;
    adapter = FakeAdapter((_) {
      calls++;
      if (failing) return jsonResponse({'error': 'internal'}, status: 500);
      return jsonResponse({
        'goals': [summaryJson(goalId: 'g_ok', instruction: 'recovered')],
      });
    });
    await pumpHost(tester);
    await open(tester);

    expect(calls, greaterThanOrEqualTo(1));
    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('No goals yet.'), findsNothing);

    failing = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(calls, greaterThanOrEqualTo(2));
    expect(find.text('recovered'), findsOneWidget);
  });
}
