import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/status_tracker.dart';
import 'package:ai_assistant/features/goals/ui/goal_todo_screen.dart';
import 'package:ai_assistant/features/goals/ui/goals_overlay.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../fakes.dart';
import 'goal_client_test.dart' show FakeAdapter, jsonResponse, summaryJson;
import 'goal_providers_test.dart'
    show TestAuth, credentials, InMemorySecureStorage;

/// Phase 3.7's goals overlay: opened from the gear chip, it lists every goal,
/// paginates behind an explicit footer, and hands a row off to the todo view.
/// Each row also carries an action menu that cancels, deletes, or resumes.

Map<String, Object?> _detailFor(String goalId) => {
  'goalId': goalId,
  'status': 'running',
  'modelPluginId': 'openrouter',
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

  Future<void> pumpHost(
    WidgetTester tester, {
    bool seedCredentials = true,
  }) async {
    final store = PluginCredentialsStore(storage: InMemorySecureStorage());
    if (seedCredentials) {
      await store.setCredentials(
        AuthAccountScope.fromIdentity(
          backendOrigin: 'https://gw.test',
          ownerId: 'owner-a',
        )!,
        'openrouter',
        {'apiKey': 'sk-stored'},
      );
    }
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
          pluginCredentialsStoreProvider.overrideWithValue(store),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
          appPrefsStoreProvider.overrideWithValue(FakePrefsStore()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Mirrors production: watching the chip keeps
                  // `goalListProvider` alive across overlay dismissals, so the
                  // per-open freshness in `showGoalsOverlay` is exercised.
                  const GoalsChip(),
                  Builder(
                    builder: (context) => IconButton(
                      key: const Key('open-goals'),
                      icon: const Icon(Icons.settings),
                      onPressed: () => showGoalsOverlay(context),
                    ),
                  ),
                ],
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

  Future<void> openRowMenu(WidgetTester tester, String goalId) async {
    await tester.tap(find.byKey(Key('goal-actions-$goalId')));
    await tester.pumpAndSettle();
  }

  Future<void> tapAction(WidgetTester tester, String label) async {
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  FilledButton resumeSubmit(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byKey(const Key('goal-resume-submit')));

  /// A summary with `canCancel` forced off (the fixture defaults it true even
  /// for terminal goals, which the server would not).
  Map<String, Object?> doneSummary(String goalId, String instruction) => {
    ...summaryJson(
      goalId: goalId,
      status: 'complete',
      instruction: instruction,
    ),
    'canCancel': false,
  };

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

    // Count from here: the chip keeps the list alive and `showGoalsOverlay`
    // invalidates it on open, so the total includes those refreshes.
    final before = listCalls;
    await tester.tap(find.text('Show older goals…'));
    await tester.pumpAndSettle();

    expect(listCalls, before + 1);
    expect(find.text('newest'), findsOneWidget);
    expect(find.text('oldest'), findsOneWidget);
    expect(find.text('Show older goals…'), findsNothing);
  });

  testWidgets('reopening the overlay shows a fresh first page', (tester) async {
    var instructions = ['first'];
    adapter = FakeAdapter((options) {
      if (options.uri.query.isNotEmpty) {
        return jsonResponse({
          'goals': [
            for (var i = 0; i < instructions.length; i++)
              summaryJson(goalId: 'g_$i', instruction: instructions[i]),
          ],
        });
      }
      return jsonResponse(_detailFor('g_0'));
    });
    await pumpHost(tester);
    await open(tester);
    expect(find.text('first'), findsOneWidget);

    // Mutate the server's response while the chip keeps the list alive, then
    // reopen: the overlay must refetch rather than show the retained snapshot.
    instructions = ['second'];
    await tester.tap(find.byKey(const Key('goals-dismiss')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('goals-overlay')), findsNothing);

    await open(tester);
    expect(find.text('second'), findsOneWidget);
    expect(find.text('first'), findsNothing);
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

  testWidgets('each row menu offers Cancel/Delete/Resume per its flags', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.uri.path == '/v1/goals') {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_live',
              status: 'running',
              instruction: 'live work',
            ),
            doneSummary('g_done', 'finished'),
            {
              ...summaryJson(
                goalId: 'g_paused',
                status: 'paused',
                instruction: 'paused work',
                pauseQuestion: 'which flight?',
              ),
              'canCancel': false,
            },
          ],
        });
      }
      return jsonResponse(_detailFor('g_live'));
    });
    await pumpHost(tester);
    await open(tester);

    await openRowMenu(tester, 'g_live');
    expect(find.text('Cancel'), findsOneWidget);
    expect(find.text('Delete'), findsNothing);
    expect(find.text('Resume'), findsNothing);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await openRowMenu(tester, 'g_done');
    expect(find.text('Delete'), findsOneWidget);
    expect(find.text('Cancel'), findsNothing);
    expect(find.text('Resume'), findsNothing);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await openRowMenu(tester, 'g_paused');
    expect(find.text('Resume'), findsOneWidget);
    expect(find.text('Cancel'), findsNothing);
    expect(find.text('Delete'), findsNothing);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
  });

  testWidgets('Cancel confirms, POSTs /cancel, and refreshes the list', (
    tester,
  ) async {
    var cancelled = false;
    adapter = FakeAdapter((options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_live',
              status: cancelled ? 'cancelled' : 'running',
              instruction: cancelled ? 'stopped work' : 'live work',
            ),
          ],
        });
      }
      if (options.method == 'POST' && path == '/v1/goals/g_live/cancel') {
        cancelled = true;
        return jsonResponse({
          'goalId': 'g_live',
          'status': 'cancelled',
          'previousStatus': 'running',
          'effectState': 'none_known',
        });
      }
      return jsonResponse(_detailFor('g_live'));
    });
    await pumpHost(tester);
    await open(tester);
    expect(find.text('live work'), findsOneWidget);

    await openRowMenu(tester, 'g_live');
    await tapAction(tester, 'Cancel');
    await tester.tap(find.byKey(const Key('goal-confirm-cancel')));
    await tester.pumpAndSettle();

    expect(
      adapter.requests.where(
        (r) => r.method == 'POST' && r.uri.path == '/v1/goals/g_live/cancel',
      ),
      hasLength(1),
    );
    expect(find.text('stopped work'), findsOneWidget);
    expect(find.text('live work'), findsNothing);
  });

  testWidgets('Delete confirms, DELETEs the goal, and refreshes the list', (
    tester,
  ) async {
    var deleted = false;
    adapter = FakeAdapter((options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        return jsonResponse({
          'goals': deleted
              ? <Object?>[]
              : [doneSummary('g_done', 'finished')],
        });
      }
      if (options.method == 'DELETE' && path == '/v1/goals/g_done') {
        deleted = true;
        return ResponseBody.fromString('', 204);
      }
      return jsonResponse(_detailFor('g_done'));
    });
    await pumpHost(tester);
    await open(tester);
    expect(find.text('finished'), findsOneWidget);

    await openRowMenu(tester, 'g_done');
    await tapAction(tester, 'Delete');
    await tester.tap(find.byKey(const Key('goal-confirm-delete')));
    await tester.pumpAndSettle();

    expect(
      adapter.requests.where(
        (r) => r.method == 'DELETE' && r.uri.path == '/v1/goals/g_done',
      ),
      hasLength(1),
    );
    expect(find.text('finished'), findsNothing);
    expect(find.text('No goals yet.'), findsOneWidget);
  });

  testWidgets('a row-action refusal surfaces the mapped phrase in a SnackBar', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_live',
              status: 'running',
              instruction: 'live work',
            ),
          ],
        });
      }
      if (options.method == 'POST' && path == '/v1/goals/g_live/cancel') {
        return jsonResponse({'error': 'goal_not_cancellable'}, status: 409);
      }
      return jsonResponse(_detailFor('g_live'));
    });
    await pumpHost(tester);
    await open(tester);

    await openRowMenu(tester, 'g_live');
    await tapAction(tester, 'Cancel');
    await tester.tap(find.byKey(const Key('goal-confirm-cancel')));
    await tester.pumpAndSettle();

    expect(
      find.byWidgetPredicate(
        (w) => w is Text && goalNotCancellablePhrases.contains(w.data),
      ),
      findsOneWidget,
    );

    // Let the SnackBar timer expire so no pending timer outlives the test.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('the row Resume action opens the sheet and sends only the answer', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        return jsonResponse({
          'goals': [
            summaryJson(
              goalId: 'g_pause',
              status: 'paused',
              instruction: 'answer me',
              pauseQuestion: 'which flight?',
            ),
          ],
        });
      }
      if (options.method == 'GET' && path == '/v1/goals/g_pause') {
        return jsonResponse({
          ..._detailFor('g_pause'),
          'status': 'paused',
          'pauseReason': 'needs_user_input',
          'pauseQuestion': 'which flight?',
          'canCancel': true,
          'canResume': true,
          'terminal': false,
        });
      }
      if (options.method == 'POST' && path == '/v1/goals/g_pause/resume') {
        return jsonResponse({'goalId': 'g_pause', 'status': 'queued'});
      }
      return jsonResponse(_detailFor('g_run'));
    });
    await pumpHost(tester);
    await open(tester);

    await openRowMenu(tester, 'g_pause');
    await tapAction(tester, 'Resume');

    expect(find.byKey(const Key('goal-resume-sheet')), findsOneWidget);
    expect(find.text('which flight?'), findsOneWidget);
    expect(resumeSubmit(tester).onPressed, isNull);

    await tester.enterText(
      find.byKey(const Key('goal-resume-answer')),
      'morning flight',
    );
    await tester.pump();
    expect(resumeSubmit(tester).onPressed, isNotNull);

    await tester.tap(find.byKey(const Key('goal-resume-submit')));
    await tester.pumpAndSettle();

    final resume = adapter.requests.singleWhere(
      (r) => r.uri.path == '/v1/goals/g_pause/resume',
    );
    expect(resume.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      'answer': 'morning flight',
    });
    expect(find.byKey(const Key('goal-resume-sheet')), findsNothing);
  });
}
