import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/status_tracker.dart';
import 'package:ai_assistant/features/goals/ui/goals_overlay.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'goal_client_test.dart' show FakeAdapter, jsonResponse;
import 'goal_providers_test.dart'
    show TestAuth, credentials, InMemorySecureStorage;

/// The goal resume sheet: it loads the detail, asks for exactly the input the
/// pause reason requires, and submits `POST /v1/goals/:id/resume` with only the
/// relevant fields (credentials pinned by the action layer).

void main() {
  const goalId = 'g_pause';

  late FakeAdapter adapter;

  Map<String, Object?> detail({
    required String pauseReason,
    String? pauseQuestion,
    int tokenBudget = 200000,
    int tokensSpent = 41230,
    List<Map<String, Object?>> mutations = const [],
    String? modelPluginId = 'openrouter',
  }) => {
    'goalId': goalId,
    'status': 'paused',
    'modelPluginId': modelPluginId,
    'pauseReason': pauseReason,
    'pauseQuestion': pauseQuestion,
    'resultSummary': null,
    'failureReason': null,
    'instruction': "plan tomorrow's meals",
    'todos': <Object?>[],
    'tokenBudget': tokenBudget,
    'tokensSpent': tokensSpent,
    'effectState': 'none_known',
    'canCancel': true,
    'canResume': true,
    'terminal': false,
    'unresolvedMutations': mutations,
    'steps': <Object?>[],
    'updatedAt': '2026-10-04T00:01:00.000Z',
  };

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
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Center(
              child: Builder(
                builder: (context) => ElevatedButton(
                  key: const Key('open-resume'),
                  onPressed: () =>
                      showGoalResumeSheet(context, goalId: goalId),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('open-resume')));
    await tester.pumpAndSettle();
  }

  FilledButton submit(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byKey(const Key('goal-resume-submit')));

  Future<void> tapSubmit(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('goal-resume-submit')));
    await tester.pumpAndSettle();
  }

  /// Taps a mutation ChoiceChip, scrolling the dialog content to it first (a
  /// run of mutations can push the lower chips out of the viewport).
  Future<void> tapChip(WidgetTester tester, Key key) async {
    final finder = find.byKey(key);
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pump();
  }

  testWidgets('a failed detail load offers a retry that recovers', (
    tester,
  ) async {
    var failing = true;
    adapter = FakeAdapter((options) {
      if (options.uri.path == '/v1/goals/$goalId') {
        if (failing) return jsonResponse({'error': 'internal'}, status: 500);
        return jsonResponse(
          detail(pauseReason: 'needs_user_input', pauseQuestion: 'which flight?'),
        );
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester);
    await openSheet(tester);

    expect(find.byKey(const Key('goal-resume-retry')), findsOneWidget);

    failing = false;
    await tester.tap(find.byKey(const Key('goal-resume-retry')));
    await tester.pumpAndSettle();

    expect(find.text('which flight?'), findsOneWidget);
    expect(find.byKey(const Key('goal-resume-submit')), findsOneWidget);
  });

  testWidgets('needs_user_input sends only the answer once non-blank', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(
          detail(pauseReason: 'needs_user_input', pauseQuestion: 'which flight?'),
        );
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'goalId': goalId, 'status': 'queued'});
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester);
    await openSheet(tester);

    expect(find.text('which flight?'), findsOneWidget);
    expect(submit(tester).onPressed, isNull);

    await tester.enterText(
      find.byKey(const Key('goal-resume-answer')),
      'morning flight',
    );
    await tester.pump();
    expect(submit(tester).onPressed, isNotNull);

    await tapSubmit(tester);

    final resume = adapter.requests.singleWhere(
      (r) => r.uri.path == '/v1/goals/$goalId/resume',
    );
    expect(resume.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      'answer': 'morning flight',
    });
    expect(find.byKey(const Key('goal-resume-sheet')), findsNothing);
  });

  testWidgets(
    'needs_mutation_resolution waits for every choice and round-trips all three',
    (tester) async {
      adapter = FakeAdapter((options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detail(
              pauseReason: 'needs_mutation_resolution',
              mutations: [
                {'tool': 'create_mealplan', 'argsHash': 'abc123'},
                {'tool': 'send_email', 'argsHash': 'def4567890'},
                {'tool': 'book_table', 'argsHash': 'ghi789'},
              ],
            ),
          );
        }
        if (options.method == 'POST' &&
            options.uri.path == '/v1/goals/$goalId/resume') {
          return jsonResponse({'goalId': goalId, 'status': 'queued'});
        }
        return jsonResponse({'error': 'not_found'}, status: 404);
      });
      await pumpHost(tester);
      await openSheet(tester);

      expect(find.text('create_mealplan · abc123'), findsOneWidget);
      expect(submit(tester).onPressed, isNull);

      await tapChip(tester, const Key('mutation-0-applied'));
      expect(submit(tester).onPressed, isNull);
      await tapChip(tester, const Key('mutation-1-retryable'));
      expect(submit(tester).onPressed, isNull);
      await tapChip(tester, const Key('mutation-2-not_applied'));
      expect(submit(tester).onPressed, isNotNull);

      await tapSubmit(tester);

      final resume = adapter.requests.singleWhere(
        (r) => r.uri.path == '/v1/goals/$goalId/resume',
      );
      expect(resume.data, {
        'credentials': {
          'openrouter': {'apiKey': 'sk-stored'},
        },
        'resolveMutations': [
          {
            'tool': 'create_mealplan',
            'argsHash': 'abc123',
            'resolution': 'applied',
          },
          {
            'tool': 'send_email',
            'argsHash': 'def4567890',
            'resolution': 'retryable',
          },
          {
            'tool': 'book_table',
            'argsHash': 'ghi789',
            'resolution': 'not_applied',
          },
        ],
      });
    },
  );

  testWidgets('budget_exhausted requires a raise above both thresholds', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(
          detail(
            pauseReason: 'budget_exhausted',
            tokenBudget: 100,
            tokensSpent: 150,
          ),
        );
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'goalId': goalId, 'status': 'queued'});
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester);
    await openSheet(tester);

    expect(submit(tester).onPressed, isNull);

    // Above the budget (100) but not above what was already spent (150).
    await tester.enterText(find.byKey(const Key('goal-resume-budget')), '120');
    await tester.pump();
    expect(submit(tester).onPressed, isNull);

    await tester.enterText(find.byKey(const Key('goal-resume-budget')), '151');
    await tester.pump();
    expect(submit(tester).onPressed, isNotNull);

    await tapSubmit(tester);

    final resume = adapter.requests.singleWhere(
      (r) => r.uri.path == '/v1/goals/$goalId/resume',
    );
    expect(resume.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      'tokenBudget': 151,
    });
  });

  testWidgets('credentials_required resumes with no extra input', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(detail(pauseReason: 'credentials_required'));
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'goalId': goalId, 'status': 'queued'});
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester);
    await openSheet(tester);

    expect(submit(tester).onPressed, isNotNull);
    await tapSubmit(tester);

    final resume = adapter.requests.singleWhere(
      (r) => r.uri.path == '/v1/goals/$goalId/resume',
    );
    expect(resume.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
    });
    expect(find.byKey(const Key('goal-resume-sheet')), findsNothing);
  });

  testWidgets('no_credentials shows the Plugins hint inline, not a raw failure', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(detail(pauseReason: 'credentials_required'));
      }
      if (options.method == 'POST') {
        fail('resume must not be sent without stored credentials');
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester, seedCredentials: false);
    await openSheet(tester);

    await tapSubmit(tester);

    expect(
      find.byKey(const Key('goal-resume-credentials-hint')),
      findsOneWidget,
    );
    expect(find.text(goalResumeCredentialsHint), findsOneWidget);
    expect(adapter.requests.where((r) => r.method == 'POST'), isEmpty);
    expect(
      find.byWidgetPredicate(
        (w) => w is Text && authErrorPhrases.contains(w.data),
      ),
      findsNothing,
    );
  });

  testWidgets(
    'no_credentials in answer mode surfaces the Plugins hint as a SnackBar',
    (tester) async {
      adapter = FakeAdapter((options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detail(
              pauseReason: 'needs_user_input',
              pauseQuestion: 'which flight?',
            ),
          );
        }
        if (options.method == 'POST') {
          fail('resume must not be sent without stored credentials');
        }
        return jsonResponse({'error': 'not_found'}, status: 404);
      });
      await pumpHost(tester, seedCredentials: false);
      await openSheet(tester);

      await tester.enterText(
        find.byKey(const Key('goal-resume-answer')),
        'morning flight',
      );
      await tester.pump();
      await tapSubmit(tester);

      // The tap is never a silent no-op: the same Plugins pointer surfaces.
      expect(find.text(goalResumeCredentialsHint), findsOneWidget);
      expect(adapter.requests.where((r) => r.method == 'POST'), isEmpty);

      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'no_credentials in budget mode surfaces the Plugins hint as a SnackBar',
    (tester) async {
      adapter = FakeAdapter((options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detail(
              pauseReason: 'budget_exhausted',
              tokenBudget: 100,
              tokensSpent: 150,
            ),
          );
        }
        if (options.method == 'POST') {
          fail('resume must not be sent without stored credentials');
        }
        return jsonResponse({'error': 'not_found'}, status: 404);
      });
      await pumpHost(tester, seedCredentials: false);
      await openSheet(tester);

      await tester.enterText(find.byKey(const Key('goal-resume-budget')), '151');
      await tester.pump();
      await tapSubmit(tester);

      expect(find.text(goalResumeCredentialsHint), findsOneWidget);
      expect(adapter.requests.where((r) => r.method == 'POST'), isEmpty);

      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'no_credentials in mutations mode surfaces the Plugins hint as a SnackBar',
    (tester) async {
      adapter = FakeAdapter((options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detail(
              pauseReason: 'needs_mutation_resolution',
              mutations: [
                {'tool': 'create_mealplan', 'argsHash': 'abc123'},
                {'tool': 'send_email', 'argsHash': 'def4567890'},
                {'tool': 'book_table', 'argsHash': 'ghi789'},
              ],
            ),
          );
        }
        if (options.method == 'POST') {
          fail('resume must not be sent without stored credentials');
        }
        return jsonResponse({'error': 'not_found'}, status: 404);
      });
      await pumpHost(tester, seedCredentials: false);
      await openSheet(tester);

      await tapChip(tester, const Key('mutation-0-applied'));
      await tapChip(tester, const Key('mutation-1-retryable'));
      await tapChip(tester, const Key('mutation-2-not_applied'));
      await tapSubmit(tester);

      expect(find.text(goalResumeCredentialsHint), findsOneWidget);
      expect(adapter.requests.where((r) => r.method == 'POST'), isEmpty);

      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'duplicate (tool,argsHash) mutations disable Resume, explain, and never POST',
    (tester) async {
      adapter = FakeAdapter((options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detail(
              pauseReason: 'needs_mutation_resolution',
              mutations: [
                // Same (tool, argsHash) under two different plugin ids: the
                // wire body only carries the pair, so these collide.
                {
                  'tool': 'send_email',
                  'argsHash': 'abc123',
                  'pluginId': 'gmail',
                },
                {
                  'tool': 'send_email',
                  'argsHash': 'abc123',
                  'pluginId': 'outlook',
                },
                {'tool': 'book_table', 'argsHash': 'ghi789'},
              ],
            ),
          );
        }
        if (options.method == 'POST') {
          fail('a duplicate mutation pair must never be POSTed');
        }
        return jsonResponse({'error': 'not_found'}, status: 404);
      });
      await pumpHost(tester);
      await openSheet(tester);

      expect(
        find.byKey(const Key('goal-resume-duplicate-mutations')),
        findsOneWidget,
      );
      expect(find.text(goalResumeDuplicateMutationsHint), findsOneWidget);
      // No resolution affordance, and Resume stays disabled.
      expect(find.byType(ChoiceChip), findsNothing);
      expect(submit(tester).onPressed, isNull);
      expect(adapter.requests.where((r) => r.method == 'POST'), isEmpty);
    },
  );

  testWidgets('a refusal surfaces the mapped phrase in a SnackBar', (
    tester,
  ) async {
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(detail(pauseReason: 'credentials_required'));
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'error': 'goal_not_resumable'}, status: 409);
      }
      return jsonResponse({'error': 'not_found'}, status: 404);
    });
    await pumpHost(tester);
    await openSheet(tester);

    await tapSubmit(tester);

    expect(
      find.byWidgetPredicate(
        (w) => w is Text && goalNotResumablePhrases.contains(w.data),
      ),
      findsOneWidget,
    );
    // The sheet stays open so the user can adjust and retry.
    expect(find.byKey(const Key('goal-resume-sheet')), findsOneWidget);

    // Let the SnackBar timer expire so no pending timer outlives the test.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
