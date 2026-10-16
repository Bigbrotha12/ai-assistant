import 'dart:async';

import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/goals/data/goal_dto.dart';
import 'package:ai_assistant/features/goals/data/goal_providers.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/managed_error_codes.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'goal_client_test.dart'
    show FakeAdapter, jsonResponse, summaryJson, detailJson;

/// Phase 3.7's trigger: the §12 body it assembles from the account's stored
/// selection, and the prerequisite gates (`gate` / typed codes) that decide
/// whether the composer can arm at all.

/// In-memory [FlutterSecureStorage] double (the per-file idiom used by
/// `auth_credentials_store_test.dart`).
class InMemorySecureStorage extends FlutterSecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }
}

class TestAuth extends AuthCredentialsNotifier {
  TestAuth(this.initial);

  final AuthCredentials? initial;

  @override
  Future<AuthCredentials?> build() async => initial;
}

const credentials = AuthCredentials(
  apiKey: 'test-key',
  ownerId: 'owner-a',
  backendOrigin: 'https://gw.test',
);

void main() {
  // The detail/list routes key on this id; the fixtures default to it.
  const goalId = 'g_550e8400-e29b-41d4-a716-446655440000';

  late PluginCredentialsStore store;
  late FakeAdapter adapter;
  late ProviderContainer container;

  // Mutable response handler so each test can route by path/method without
  // rebuilding the container (the Dio adapter closes over this variable).
  late FutureOr<ResponseBody> Function(RequestOptions options) handler;

  setUp(() {
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    handler = (_) => jsonResponse({
      'goalId': 'g_1',
      'status': 'queued',
      'todos': <Object?>[],
      'createdAt': '2026-10-04T00:00:00.000Z',
    });
    adapter = FakeAdapter((options) => handler(options));
    container = ProviderContainer(
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
    );
    addTearDown(container.dispose);
  });

  AuthAccountScope scope() => AuthAccountScope.fromIdentity(
    backendOrigin: 'https://gw.test',
    ownerId: 'owner-a',
  )!;

  /// Resolves auth, then loads + keeps the goal detail alive so a later
  /// `resume` reads the cached detail instead of issuing its own GET.
  Future<void> primeDetail() async {
    await container.read(authCredentialsProvider.future);
    container.listen(
      goalDetailProvider(goalId),
      (_, _) {},
      fireImmediately: true,
    );
    await container.read(goalDetailProvider(goalId).future);
  }

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  Future<void> seedConfig({
    String? model = 'openrouter',
    String? apiKey = 'sk-stored',
    String? agent = 'mealie-agent',
    AgentKind agentKind = AgentKind.template,
  }) async {
    final scope = AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gw.test',
      ownerId: 'owner-a',
    )!;
    if (model != null) await store.setSelectedModel(scope, model);
    if (model != null && apiKey != null) {
      await store.setCredentials(scope, model, {'apiKey': apiKey});
    }
    if (agent != null) {
      await store.setAgentConfig(
        scope,
        agent,
        AgentConfig(id: agent, kind: agentKind),
      );
      await store.setSelectedAgent(scope, agent);
    }
  }

  test('submit assembles the §12 body from the stored selection', () async {
    await seedConfig();

    final submitted = await container
        .read(goalTriggerProvider)
        .submit("plan tomorrow's meals");

    final body = adapter.requests.single.data as Map<String, dynamic>;
    expect(body['instruction'], "plan tomorrow's meals");
    expect(body['agent'], 'mealie-agent');
    expect(body['modelPluginId'], 'openrouter');
    expect(body['tokenBudget'], kGoalTokenBudget);
    expect(body['clientGoalId'], matches(RegExp(r'^[0-9a-f-]{36}$')));
    expect(body['credentials'], {
      'openrouter': {'apiKey': 'sk-stored'},
    });
    expect(submitted.goalId, 'g_1');
  });

  test('a missing selected model refuses with no_selected_model', () async {
    await seedConfig(model: null);

    await expectLater(
      container.read(goalTriggerProvider).submit('do the thing'),
      throwsA(
        isA<PluginClientException>().having(
          (e) => e.code,
          'code',
          ManagedErrorCodes.noSelectedModel,
        ),
      ),
    );
    expect(adapter.requests, isEmpty);
  });

  test('a model without a stored key refuses with no_credentials', () async {
    await seedConfig(apiKey: null);

    await expectLater(
      container.read(goalTriggerProvider).submit('do the thing'),
      throwsA(
        isA<PluginClientException>().having(
          (e) => e.code,
          'code',
          ManagedErrorCodes.noCredentials,
        ),
      ),
    );
    expect(adapter.requests, isEmpty);
  });

  test('gate blocks the trigger without a configured template agent', () async {
    await seedConfig();
    expect(await container.read(goalTriggerProvider).gate(), isNull);
  });

  test(
    'gate refuses a custom agent — its spec is not an id the route resolves',
    () async {
      await seedConfig(agent: 'my-agent', agentKind: AgentKind.custom);

      final gap = await container.read(goalTriggerProvider).gate();
      expect(gap, GoalTrigger.agentGapMessage);
    },
  );

  test('gate refuses when no agent is selected at all', () async {
    await seedConfig(agent: null);

    final gap = await container.read(goalTriggerProvider).gate();
    expect(gap, GoalTrigger.agentGapMessage);
    expect(adapter.requests, isEmpty);
  });

  test("resume assembles ONLY the goal's pinned model credentials", () async {
    await seedConfig();
    // A second, unrelated plugin the account has configured. The resume must
    // not leak it onto the wire.
    await store.setCredentials(scope(), 'anthropic', {
      'apiKey': 'sk-anthropic',
    });
    handler = (options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(
          detailJson(
            goalId: goalId,
            status: 'paused',
            pauseReason: 'needs_user_input',
            pauseQuestion: 'which flight?',
            modelPluginId: 'openrouter',
          ),
        );
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'goalId': goalId, 'status': 'queued'});
      }
      fail('unexpected ${options.method} ${options.uri.path}');
    };
    await primeDetail();

    final resumed = await container
        .read(goalActionsProvider)
        .resume(goalId, answer: 'morning flight');

    final resume = adapter.requests.singleWhere(
      (request) => request.uri.path.endsWith('/resume'),
    );
    expect(resume.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      'answer': 'morning flight',
    });
    expect(resumed.goalId, goalId);
    expect(resumed.status, 'queued');
  });

  test(
    'resume refuses no_credentials when the goal has no pinned model',
    () async {
      await seedConfig();
      handler = (options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detailJson(
              goalId: goalId,
              status: 'paused',
              pauseReason: 'budget_exhausted',
            )..remove('modelPluginId'),
          );
        }
        fail('unexpected ${options.method} ${options.uri.path}');
      };
      await primeDetail();

      await expectLater(
        container.read(goalActionsProvider).resume(goalId, tokenBudget: 400000),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            ManagedErrorCodes.noCredentials,
          ),
        ),
      );
      expect(
        adapter.requests.where((request) => request.method == 'POST'),
        isEmpty,
        reason: 'no resume call without a credential to send',
      );
    },
  );

  test(
    'resume refuses no_credentials when the pinned model has no stored key',
    () async {
      await seedConfig(apiKey: '   ');
      handler = (options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detailJson(
              goalId: goalId,
              status: 'paused',
              pauseReason: 'budget_exhausted',
              modelPluginId: 'openrouter',
            ),
          );
        }
        fail('unexpected ${options.method} ${options.uri.path}');
      };
      await primeDetail();

      await expectLater(
        container.read(goalActionsProvider).resume(goalId, tokenBudget: 400000),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            ManagedErrorCodes.noCredentials,
          ),
        ),
      );
      expect(
        adapter.requests.where((request) => request.method == 'POST'),
        isEmpty,
      );
    },
  );

  test(
    'needs_user_input resume without an answer refuses before any HTTP call',
    () async {
      await seedConfig();
      handler = (options) {
        if (options.method == 'GET' &&
            options.uri.path == '/v1/goals/$goalId') {
          return jsonResponse(
            detailJson(
              goalId: goalId,
              status: 'paused',
              pauseReason: 'needs_user_input',
              pauseQuestion: 'which flight?',
              modelPluginId: 'openrouter',
            ),
          );
        }
        fail('unexpected ${options.method} ${options.uri.path}');
      };
      await primeDetail();
      adapter.requests.clear();

      await expectLater(
        container.read(goalActionsProvider).resume(goalId),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'invalid_request',
          ),
        ),
      );
      expect(adapter.requests, isEmpty);
    },
  );

  test('resume forwards tokenBudget and mutation resolutions', () async {
    await seedConfig();
    handler = (options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals/$goalId') {
        return jsonResponse(
          detailJson(
            goalId: goalId,
            status: 'paused',
            pauseReason: 'budget_exhausted',
            modelPluginId: 'openrouter',
          ),
        );
      }
      if (options.method == 'POST' &&
          options.uri.path == '/v1/goals/$goalId/resume') {
        return jsonResponse({'goalId': goalId, 'status': 'queued'});
      }
      fail('unexpected ${options.method} ${options.uri.path}');
    };
    await primeDetail();

    await container
        .read(goalActionsProvider)
        .resume(
          goalId,
          tokenBudget: 400000,
          resolveMutations: const [
            GoalMutationResolutionInput(
              tool: 'create_mealplan',
              argsHash: 'abc123',
              resolution: 'not_applied',
            ),
          ],
        );

    final body =
        adapter.requests
                .singleWhere((request) => request.uri.path.endsWith('/resume'))
                .data
            as Map<String, dynamic>;
    expect(body['tokenBudget'], 400000);
    expect(body['resolveMutations'], [
      {
        'tool': 'create_mealplan',
        'argsHash': 'abc123',
        'resolution': 'not_applied',
      },
    ]);
    expect(body.containsKey('answer'), isFalse);
  });

  test('cancel invalidates the list and the goal detail providers', () async {
    await seedConfig();
    var listFetches = 0;
    var detailFetches = 0;
    handler = (options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        listFetches++;
        return jsonResponse({
          'goals': [summaryJson(goalId: goalId, status: 'running')],
        });
      }
      if (options.method == 'GET' && path == '/v1/goals/$goalId') {
        detailFetches++;
        return jsonResponse(detailJson(goalId: goalId, status: 'running'));
      }
      if (options.method == 'POST' && path == '/v1/goals/$goalId/cancel') {
        return jsonResponse({
          'goalId': goalId,
          'status': 'cancelled',
          'previousStatus': 'running',
          'effectState': 'none_known',
        });
      }
      fail('unexpected ${options.method} $path');
    };

    await container.read(authCredentialsProvider.future);
    container.listen(goalListProvider, (_, _) {}, fireImmediately: true);
    container.listen(
      goalDetailProvider(goalId),
      (_, _) {},
      fireImmediately: true,
    );
    await container.read(goalListProvider.future);
    await container.read(goalDetailProvider(goalId).future);
    expect(listFetches, 1);
    expect(detailFetches, 1);

    final result = await container.read(goalActionsProvider).cancel(goalId);
    expect(result.status, 'cancelled');

    await settle();
    await container.read(goalListProvider.future);
    await container.read(goalDetailProvider(goalId).future);
    expect(listFetches, 2, reason: 'cancel invalidates the list');
    expect(detailFetches, 2, reason: 'cancel invalidates the detail');
  });

  test('delete invalidates the list and the goal detail providers', () async {
    await seedConfig();
    var listFetches = 0;
    var detailFetches = 0;
    handler = (options) {
      final path = options.uri.path;
      if (options.method == 'GET' && path == '/v1/goals') {
        listFetches++;
        return jsonResponse({
          'goals': [summaryJson(goalId: goalId, status: 'complete')],
        });
      }
      if (options.method == 'GET' && path == '/v1/goals/$goalId') {
        detailFetches++;
        return jsonResponse(detailJson(goalId: goalId, status: 'complete'));
      }
      if (options.method == 'DELETE' && path == '/v1/goals/$goalId') {
        return ResponseBody.fromString('', 204);
      }
      fail('unexpected ${options.method} $path');
    };

    await container.read(authCredentialsProvider.future);
    container.listen(goalListProvider, (_, _) {}, fireImmediately: true);
    container.listen(
      goalDetailProvider(goalId),
      (_, _) {},
      fireImmediately: true,
    );
    await container.read(goalListProvider.future);
    await container.read(goalDetailProvider(goalId).future);

    await container.read(goalActionsProvider).delete(goalId);

    await settle();
    await container.read(goalListProvider.future);
    await container.read(goalDetailProvider(goalId).future);
    expect(listFetches, 2, reason: 'delete invalidates the list');
    expect(detailFetches, 2, reason: 'delete invalidates the detail');
  });
}
