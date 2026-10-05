import 'dart:async';

import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/goals/data/goal_attention_providers.dart';
import 'package:ai_assistant/features/goals/data/goal_dto.dart';
import 'package:ai_assistant/features/goals/data/goal_providers.dart';
import 'package:ai_assistant/features/goals/ui/goals_overlay.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/features/settings/data/prefs_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../fakes.dart';
import 'goal_client_test.dart' show FakeAdapter, jsonResponse, summaryJson;
import 'goal_providers_test.dart' show TestAuth, credentials;

/// Phase 7.3's client foreground reconciliation: a `paused`/`failed` goal newer
/// than the account's last-seen marker raises the chip's attention dot; viewing
/// the goals clears it. Read-only, fail-quiet, and timer-free.

const _older = '2020-01-01T00:00:00.000Z';
const _newer = '2020-01-02T00:00:00.000Z';
const _future = '2030-01-01T00:00:00.000Z';

final _scope = AuthAccountScope.fromIdentity(
  backendOrigin: 'https://gw.test',
  ownerId: 'owner-a',
)!;

GoalSummary _summary({
  required String status,
  String updatedAt = _newer,
  String? pauseQuestion,
  String? failureReason,
}) => GoalSummary.fromJson(
  summaryJson(
    status: status,
    updatedAt: updatedAt,
    pauseQuestion: pauseQuestion,
    failureReason: failureReason,
  ),
);

FakeAdapter _listAdapter(List<Map<String, Object?>> goals) =>
    FakeAdapter((_) => jsonResponse({'goals': goals}));

/// A list notifier whose build always fails — the deterministic "fetch error"
/// input for the attention fail-quiet test.
class _FailingGoalList extends GoalListNotifier {
  @override
  Future<GoalListPage> build() async {
    throw const PluginClientException('server_error');
  }
}

/// A prefs store whose load always fails — the deterministic "prefs error"
/// input for the L2 fail-quiet test.
class _FailingPrefsStore implements AppPrefsStore {
  const _FailingPrefsStore();

  @override
  Future<AppPrefs> load() async => throw StateError('prefs unavailable');

  @override
  Future<void> save(AppPrefs prefs) async {}
}

ProviderContainer _container({
  required FakeAdapter adapter,
  AppPrefs prefs = const AppPrefs(),
  Duration? Function(int retryCount, Object error)? retry,
}) {
  final container = ProviderContainer(
    retry: retry,
    overrides: [
      dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
      pluginAccountScopeProvider.overrideWithValue(_scope),
      authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
      appPrefsStoreProvider.overrideWithValue(FakePrefsStore(initial: prefs)),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

Future<FakePrefsStore> _pumpChip(
  WidgetTester tester, {
  required FakeAdapter adapter,
  AppPrefs prefs = const AppPrefs(),
}) async {
  final store = FakePrefsStore(initial: prefs);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
        pluginAccountScopeProvider.overrideWithValue(_scope),
        authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
        appPrefsStoreProvider.overrideWithValue(store),
      ],
      child: const MaterialApp(
        home: Scaffold(body: Center(child: GoalsChip())),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('goalHasAttention', () {
    test('true for a paused goal newer than the marker', () {
      expect(
        goalHasAttention(
          goals: [_summary(status: 'paused', updatedAt: _newer)],
          lastSeenIso: _older,
        ),
        isTrue,
      );
    });

    test('true for a failed goal newer than the marker', () {
      expect(
        goalHasAttention(
          goals: [_summary(status: 'failed', updatedAt: _newer)],
          lastSeenIso: _older,
        ),
        isTrue,
      );
    });

    test('false when every paused/failed goal is older than the marker', () {
      expect(
        goalHasAttention(
          goals: [
            _summary(status: 'paused', updatedAt: _older),
            _summary(status: 'failed', updatedAt: _older),
          ],
          lastSeenIso: _future,
        ),
        isFalse,
      );
    });

    test('false when only running/complete goals exist', () {
      expect(
        goalHasAttention(
          goals: [
            _summary(status: 'running'),
            _summary(status: 'complete'),
          ],
          lastSeenIso: null,
        ),
        isFalse,
      );
    });

    test('true for a paused goal with no marker yet', () {
      expect(
        goalHasAttention(
          goals: [_summary(status: 'paused')],
          lastSeenIso: null,
        ),
        isTrue,
      );
    });

    test('an unparseable updatedAt never draws attention once a marker exists',
        () {
      expect(
        goalHasAttention(
          goals: [_summary(status: 'paused', updatedAt: '')],
          lastSeenIso: _older,
        ),
        isFalse,
      );
    });
  });

  group('goalAttentionProvider', () {
    test('true when the list holds a paused goal newer than lastSeen',
        () async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
      ]);
      final container = _container(
        adapter: adapter,
        prefs: AppPrefs(goalLastSeen: {_scope.storageId: _older}),
      );

      // Resolve auth first (the overridden scope otherwise resolves before the
      // key, making the list build twice), then establish the attention watch
      // so the autoDispose list provider stays alive for the awaited load.
      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);
      await container.read(goalListProvider.future);

      expect(container.read(goalAttentionProvider), isTrue);
    });

    test('false when all goals are older than lastSeen', () async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
        summaryJson(goalId: 'g_fail', status: 'failed', updatedAt: _newer),
      ]);
      final container = _container(
        adapter: adapter,
        prefs: AppPrefs(goalLastSeen: {_scope.storageId: _future}),
      );

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);
      await container.read(goalListProvider.future);

      expect(container.read(goalAttentionProvider), isFalse);
    });

    test('false when only running/complete goals exist', () async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_run', status: 'running', updatedAt: _newer),
        summaryJson(goalId: 'g_done', status: 'complete', updatedAt: _newer),
      ]);
      final container = _container(adapter: adapter);

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);
      await container.read(goalListProvider.future);

      expect(container.read(goalAttentionProvider), isFalse);
    });

    test('a failed list fetch never sets attention (fail quiet)', () async {
      final container = ProviderContainer(
        overrides: [
          pluginAccountScopeProvider.overrideWithValue(_scope),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
          appPrefsStoreProvider.overrideWithValue(
            FakePrefsStore(
              initial: AppPrefs(goalLastSeen: {_scope.storageId: _older}),
            ),
          ),
          goalListProvider.overrideWith(_FailingGoalList.new),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);

      // Let the failing list build settle to its error state.
      await Future<void>.delayed(Duration.zero);

      expect(container.read(goalListProvider).hasError, isTrue);
      expect(container.read(goalAttentionProvider), isFalse);
    });

    test(
      'an errored list REFRESH never sets attention (retained value ignored)',
      () async {
        var listCalls = 0;
        final adapter = FakeAdapter((_) {
          listCalls++;
          if (listCalls > 1) {
            // The refetch fails. With retries disabled (below), Riverpod lands
            // the provider on a terminal AsyncError while RETAINING the first
            // page as the error's `value` — the hazard this test guards.
            return jsonResponse(
              {
                'error': {'code': 'server_error', 'message': 'boom'},
              },
              status: 500,
            );
          }
          return jsonResponse({
            'goals': [
              summaryJson(
                goalId: 'g_pause',
                status: 'paused',
                updatedAt: _newer,
              ),
            ],
          });
        });
        // Retries disabled: the default Riverpod retry would keep the provider
        // in AsyncLoading (isLoading true) and never reach the terminal
        // AsyncError state this test needs. With retry off, the errored refresh
        // settles with `isLoading == false` while `value` is the stale page.
        final container = _container(
          adapter: adapter,
          prefs: AppPrefs(goalLastSeen: {_scope.storageId: _older}),
          retry: (_, _) => null,
        );

        await container.read(authCredentialsProvider.future);
        container.read(goalAttentionProvider);
        await container.read(appPrefsProvider.future);
        await container.read(goalListProvider.future);
        // The first load's paused goal is newer than the marker.
        expect(container.read(goalAttentionProvider), isTrue);

        // Force a REFRESH (invalidate); its fetch fails, so the previous paused
        // goal survives only as the AsyncError's retained value. A value-only
        // read would keep the dot lit.
        container.invalidate(goalListProvider);
        await expectLater(
          container.read(goalListProvider.future),
          throwsA(isA<PluginClientException>()),
        );

        final list = container.read(goalListProvider);
        expect(list.isLoading, isFalse);
        expect(list.hasError, isTrue);
        expect(list.value, isNotNull); // the stale page is retained…
        expect(container.read(goalAttentionProvider), isFalse); // …but ignored.
      },
    );

    test('an errored prefs store never sets attention (fail quiet)', () async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
      ]);
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
          pluginAccountScopeProvider.overrideWithValue(_scope),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
          appPrefsStoreProvider.overrideWithValue(const _FailingPrefsStore()),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await expectLater(
        container.read(appPrefsProvider.future),
        throwsA(isA<StateError>()),
      );
      await container.read(goalListProvider.future);

      expect(container.read(appPrefsProvider).hasError, isTrue);
      expect(container.read(goalAttentionProvider), isFalse);
    });

    test('a scope switch gates attention while the stale list reloads', () async {
      final scopeB = AuthAccountScope.fromIdentity(
        backendOrigin: 'https://gw.test',
        ownerId: 'owner-b',
      )!;
      final reload = Completer<void>();
      var listCalls = 0;
      final adapter = FakeAdapter((_) async {
        listCalls++;
        if (listCalls > 1) await reload.future; // the reload hangs
        return jsonResponse({
          'goals': [
            summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
          ],
        });
      });
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
          pluginAccountScopeProvider.overrideWithValue(_scope),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
          appPrefsStoreProvider.overrideWithValue(
            FakePrefsStore(
              initial: AppPrefs(goalLastSeen: {_scope.storageId: _older}),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);
      await container.read(goalListProvider.future);
      expect(container.read(goalAttentionProvider), isTrue);

      // Switch to a second account with no marker. The reload hangs, so the
      // list still carries the previous account's goals as its loading value.
      container.updateOverrides([
        dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
        pluginAccountScopeProvider.overrideWithValue(scopeB),
        authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
        appPrefsStoreProvider.overrideWithValue(
          FakePrefsStore(
            initial: AppPrefs(goalLastSeen: {_scope.storageId: _older}),
          ),
        ),
      ]);

      expect(container.read(goalAttentionProvider), isFalse);

      reload.complete();
      await container.read(goalListProvider.future);
      // The new scope has no marker, so a paused goal draws attention again.
      expect(container.read(goalAttentionProvider), isTrue);
    });

    test('resume re-fetches the list and recomputes attention', () async {
      var listCalls = 0;
      final adapter = FakeAdapter((_) {
        listCalls++;
        return jsonResponse({
          'goals': [
            summaryJson(goalId: 'g_run', status: 'running', updatedAt: _newer),
          ],
        });
      });
      final container = _container(adapter: adapter);

      await container.read(authCredentialsProvider.future);
      container.read(goalAttentionProvider);
      await container.read(appPrefsProvider.future);
      await container.read(goalListProvider.future);
      final before = listCalls;

      // Foreground reconciliation goes through the same self-contained
      // observer the chip keeps alive.
      container.read(goalAttentionLifecycleProvider).onForeground();
      await container.read(goalListProvider.future);

      expect(listCalls, greaterThan(before));
      expect(container.read(goalAttentionProvider), isFalse);
    });
  });

  group('GoalsChip attention dot', () {
    testWidgets('renders the dot for a paused goal newer than the marker',
        (tester) async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
      ]);
      await _pumpChip(tester, adapter: adapter);

      expect(find.byKey(const Key('goals-chip')), findsOneWidget);
      expect(find.byKey(const Key('goals-attention-dot')), findsOneWidget);
    });

    testWidgets('omits the dot when the goal is older than the marker',
        (tester) async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
      ]);
      await _pumpChip(
        tester,
        adapter: adapter,
        prefs: AppPrefs(goalLastSeen: {_scope.storageId: _future}),
      );

      expect(find.byKey(const Key('goals-attention-dot')), findsNothing);
    });

    testWidgets('omits the dot when only running/complete goals exist',
        (tester) async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_run', status: 'running', updatedAt: _newer),
        summaryJson(goalId: 'g_done', status: 'complete', updatedAt: _newer),
      ]);
      await _pumpChip(tester, adapter: adapter);

      expect(find.byKey(const Key('goals-attention-dot')), findsNothing);
    });

    testWidgets('opening the overlay records lastSeen and clears the dot',
        (tester) async {
      final adapter = _listAdapter([
        summaryJson(
          goalId: 'g_fail',
          status: 'failed',
          failureReason: 'step_cap_exceeded',
          updatedAt: _newer,
        ),
      ]);
      final store = await _pumpChip(tester, adapter: adapter);
      expect(find.byKey(const Key('goals-attention-dot')), findsOneWidget);

      await tester.tap(find.byKey(const Key('goals-chip')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('goals-overlay')), findsOneWidget);

      // The marker write is async; the post-frame callback fires and settles.
      await tester.pumpAndSettle();
      expect(store.prefs.goalLastSeen[_scope.storageId], isNotNull);

      await tester.tap(find.byKey(const Key('goals-dismiss')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('goals-attention-dot')), findsNothing);
    });

    testWidgets(
      'clears the dot after viewing a goal whose updatedAt is in the future',
      (tester) async {
        // Server clock ahead of the device: the marker must be clamped to the
        // rendered updatedAt or the dot would never clear.
        final adapter = _listAdapter([
          summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _future),
        ]);
        final store = await _pumpChip(tester, adapter: adapter);
        expect(find.byKey(const Key('goals-attention-dot')), findsOneWidget);

        await tester.tap(find.byKey(const Key('goals-chip')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('goals-overlay')), findsOneWidget);
        await tester.pumpAndSettle();

        final marker = DateTime.parse(
          store.prefs.goalLastSeen[_scope.storageId]!,
        );
        expect(marker.isBefore(DateTime.parse(_future)), isFalse);

        await tester.tap(find.byKey(const Key('goals-dismiss')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('goals-attention-dot')), findsNothing);
      },
    );

    testWidgets('disposes cleanly with no pending timers', (tester) async {
      final adapter = _listAdapter([
        summaryJson(goalId: 'g_pause', status: 'paused', updatedAt: _newer),
      ]);
      await _pumpChip(tester, adapter: adapter);
      expect(find.byKey(const Key('goals-attention-dot')), findsOneWidget);

      // Tearing the scope down must unregister the lifecycle observer and
      // leave no timer behind (the test framework fails on a pending timer).
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    });
  });

  group('markGoalsSeen clock clamp', () {
    ProviderContainer prefsContainer(FakePrefsStore store) {
      final container = ProviderContainer(
        overrides: [appPrefsStoreProvider.overrideWithValue(store)],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('clamps the marker up to a future observed updatedAt', () async {
      final container = prefsContainer(FakePrefsStore());
      await container.read(appPrefsProvider.future);

      final observed = DateTime.utc(2030, 1, 1);
      await container
          .read(appPrefsProvider.notifier)
          .markGoalsSeen('acct-a', maxObservedUpdatedAt: observed);

      final marker = DateTime.parse(
        container.read(appPrefsProvider).value!.goalLastSeen['acct-a']!,
      );
      expect(marker.isBefore(observed), isFalse);
    });

    test('keeps device now when the observed updatedAt is older', () async {
      final container = prefsContainer(FakePrefsStore());
      await container.read(appPrefsProvider.future);

      final observed = DateTime.utc(2020, 1, 1);
      await container
          .read(appPrefsProvider.notifier)
          .markGoalsSeen('acct-a', maxObservedUpdatedAt: observed);

      final marker = DateTime.parse(
        container.read(appPrefsProvider).value!.goalLastSeen['acct-a']!,
      );
      expect(marker.isAfter(observed), isTrue);
    });
  });

  group('AppPrefs goalLastSeen serialization', () {
    test('an old two-segment record still loads (backward compatible)',
        () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'app_prefs': '5:en-US:1',
      });

      final prefs = await SharedPrefsAppPrefsStore().load();

      expect(prefs.dateFormat, 'en-US');
      expect(prefs.onboardingComplete, isTrue);
      expect(prefs.goalLastSeen, isEmpty);
    });

    test('goalLastSeen round-trips through the store', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final store = SharedPrefsAppPrefsStore();

      await store.save(
        AppPrefs(goalLastSeen: {'acct-a': _newer, 'acct-b': _older}),
      );

      final loaded = await store.load();
      expect(loaded.goalLastSeen, {'acct-a': _newer, 'acct-b': _older});
    });

    test('a legacy record with a colon-bearing dateFormat still loads',
        () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'app_prefs': '11:en-US:POSIX:0',
      });

      final prefs = await SharedPrefsAppPrefsStore().load();

      expect(prefs.dateFormat, 'en-US:POSIX');
      expect(prefs.onboardingComplete, isFalse);
      expect(prefs.goalLastSeen, isEmpty);
    });
  });
}
