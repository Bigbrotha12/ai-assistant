import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
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

import 'goal_client_test.dart' show FakeAdapter, jsonResponse;

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
  late PluginCredentialsStore store;
  late FakeAdapter adapter;
  late ProviderContainer container;

  setUp(() {
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    adapter = FakeAdapter((_) => jsonResponse({
      'goalId': 'g_1',
      'status': 'queued',
      'todos': <Object?>[],
      'createdAt': '2026-10-04T00:00:00.000Z',
    }));
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

  test('gate refuses a custom agent — its spec is not an id the route resolves',
      () async {
    await seedConfig(agent: 'my-agent', agentKind: AgentKind.custom);

    final gap = await container.read(goalTriggerProvider).gate();
    expect(gap, GoalTrigger.agentGapMessage);
  });

  test('gate refuses when no agent is selected at all', () async {
    await seedConfig(agent: null);

    final gap = await container.read(goalTriggerProvider).gate();
    expect(gap, GoalTrigger.agentGapMessage);
    expect(adapter.requests, isEmpty);
  });
}
