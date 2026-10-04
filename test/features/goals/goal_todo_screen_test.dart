import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/goals/ui/goal_todo_screen.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import 'goal_client_test.dart' show FakeAdapter, jsonResponse;
import 'goal_providers_test.dart' show TestAuth, credentials;

/// Phase 3.7's todo view: it renders `GET /v1/goals/:id` and keeps it live —
/// updating while the goal runs, stopping once the goal is terminal, and
/// stopping when the screen goes away (no timer outlives the widget).

Map<String, Object?> detail({
  required String status,
  required List<Object?> todos,
  required String updatedAt,
  bool terminal = false,
}) => {
  'goalId': 'g_1',
  'status': status,
  'pauseReason': null,
  'pauseQuestion': null,
  'resultSummary': null,
  'failureReason': null,
  'instruction': "plan tomorrow's meals",
  'todos': todos,
  'tokenBudget': 200000,
  'tokensSpent': 41230,
  'effectState': 'none_known',
  'canCancel': true,
  'canResume': false,
  'terminal': terminal,
  'unresolvedMutations': <Object?>[],
  'steps': <Object?>[],
  'updatedAt': updatedAt,
};

List<Override> overridesFor(FakeAdapter adapter) => [
  dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
  pluginAccountScopeProvider.overrideWithValue(
    AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gw.test',
      ownerId: 'owner-a',
    )!,
  ),
  authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
];

void main() {
  /// Returns the override LIST so [unmount] reuses the very same instances:
  /// fresh `overrideWithValue` objects would count as changed values and
  /// invalidate the goal provider — a stray fetch at teardown.
  Future<List<Override>> mount(WidgetTester tester, FakeAdapter adapter) async {
    final overrides = overridesFor(adapter);
    await tester.pumpWidget(
      ProviderScope(
        overrides: overrides,
        child: const MaterialApp(home: GoalTodoScreen(goalId: 'g_1')),
      ),
    );
    await tester.pumpAndSettle();
    return overrides;
  }

  /// Replaces the tree with an empty home — the screen disposes (cancelling
  /// its poll) while the SAME override instances keep Riverpod from
  /// invalidating anything on the way out.
  Future<void> unmount(WidgetTester tester, List<Override> overrides) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: overrides,
        child: const MaterialApp(home: SizedBox()),
      ),
    );
    await tester.pump();
  }

  testWidgets('renders the goal instruction and its todos', (tester) async {
    final adapter = FakeAdapter(
      (_) => jsonResponse(
        detail(
          status: 'running',
          todos: ['buy salmon', 'chop onions'],
          updatedAt: '2026-10-04T00:01:00.000Z',
        ),
      ),
    );
    final overrides = await mount(tester, adapter);

    expect(find.text("plan tomorrow's meals"), findsOneWidget);
    expect(find.text('buy salmon'), findsOneWidget);
    expect(find.text('chop onions'), findsOneWidget);
    expect(find.text('Running'), findsOneWidget);

    await unmount(tester, overrides);
  });

  testWidgets('a live refresh repaints the todos while the goal runs', (
    tester,
  ) async {
    var calls = 0;
    final adapter = FakeAdapter((_) {
      calls++;
      return jsonResponse(
        detail(
          status: 'running',
          todos: calls == 1
              ? ['buy salmon']
              : ['buy salmon', 'chop onions'],
          updatedAt: '2026-10-04T00:0$calls:00.000Z',
        ),
      );
    });
    final overrides = await mount(tester, adapter);
    expect(find.text('chop onions'), findsNothing);
    expect(calls, 1);

    // First poll tick (1s after mount) re-reads and repaints.
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(calls, 2);
    expect(find.text('chop onions'), findsOneWidget);

    await unmount(tester, overrides);
  });

  testWidgets('polling stops once the goal is terminal', (tester) async {
    var calls = 0;
    final adapter = FakeAdapter((_) {
      calls++;
      final done = calls >= 2;
      return jsonResponse(
        detail(
          status: done ? 'complete' : 'running',
          todos: ['done'],
          updatedAt: '2026-10-04T00:0$calls:00.000Z',
          terminal: done,
        ),
      );
    });
    final overrides = await mount(tester, adapter);
    expect(calls, 1);

    // The tick that learns the goal finished consumes one more read…
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.text('Complete'), findsOneWidget);

    // …and nothing polls after that.
    await tester.pump(const Duration(seconds: 30));
    await tester.pump();
    expect(calls, 2);

    await unmount(tester, overrides);
  });

  testWidgets('disposing the screen cancels its poll', (tester) async {
    var calls = 0;
    final adapter = FakeAdapter((_) {
      calls++;
      return jsonResponse(
        detail(
          status: 'running',
          todos: ['buy salmon'],
          updatedAt: '2026-10-04T00:01:00.000Z',
        ),
      );
    });
    final overrides = await mount(tester, adapter);
    expect(calls, 1);

    await unmount(tester, overrides);

    await tester.pump(const Duration(seconds: 30));
    expect(calls, 1, reason: 'no request after the screen is gone');
  });
}
