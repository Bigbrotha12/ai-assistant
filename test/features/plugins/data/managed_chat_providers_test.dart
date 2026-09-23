import 'dart:async';
import 'dart:convert';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/langchain_request.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_dto.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_catalog_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/plugins/data/plugin_registry_client.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../fakes.dart';
import '../../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;
import 'managed_conversation_service_test.dart' show FakeLangChainClient;

class _FakeRegistryClient extends PluginRegistryClient {
  _FakeRegistryClient() : super(dio: Dio(), baseUrl: 'https://gw.test/v1');

  List<PluginModelDto> models = const [];

  @override
  Future<List<PluginModelDto>> listModels({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async => models;
}

PluginModelDto _model(String id) => PluginModelDto.fromJson({
  'id': id,
  'object': 'model',
  'created': 0,
  'owned_by': 'test',
  'defaultModel': '$id/upstream',
  'tokenLimit': 4096,
  'visionCapable': false,
  'supportsStreaming': true,
  'parameters': <String, dynamic>{},
});

AuthCredentials _credentials(String owner, {String key = 'gateway-secret'}) =>
    AuthCredentials(
      apiKey: key,
      ownerId: owner,
      backendOrigin: 'http://example.com:17600',
    );

void main() {
  late AppDatabase db;
  late ProviderContainer container;
  late PluginCredentialsStore pluginStore;
  late _FakeRegistryClient registry;
  late FakeLangChainClient client;
  late AuthAccountScope scope;
  late Future<ManagedTurnResult> Function(LangChainRequest) respondWith;

  setUp(() async {
    db = AppDatabase(NativeDatabase.memory());
    addTearDown(() async => db.close());
    pluginStore = PluginCredentialsStore(storage: InMemorySecureStorage());
    registry = _FakeRegistryClient();
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'local reply',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    client = FakeLangChainClient((request) => respondWith(request));
    container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(
          FakeAuthCredentialsStore(stored: _credentials('a')),
        ),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(pluginStore),
        pluginRegistryClientProvider.overrideWithValue(registry),
        databaseProvider.overrideWithValue(db),
        managedLangChainClientProvider.overrideWithValue(client),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    await container.read(settingsProvider.future);
    scope = container.read(pluginAccountScopeProvider);
  });

  Future<void> seedReadyConfig() async {
    registry.models = [_model('text')];
    await pluginStore.setSelectedModel(scope, 'text');
    await pluginStore.setCredentials(scope, 'text', {'apiKey': 'text-test'});
    await pluginStore.setEnabled(scope, 'web', true);
    await pluginStore.setCredentials(scope, 'web', {'apiKey': 'web-test'});
  }

  test(
    'provider is non-autoDispose and rebuilds only when the account scope '
    'changes',
    () async {
      final first = container.read(managedChatAdapterProvider);
      expect(container.read(managedChatAdapterProvider), same(first));

      // Listener teardown must not dispose it: an autoDispose provider would
      // drop the element and hand back a fresh instance on the next read.
      final subscription = container.listen(
        managedChatAdapterProvider,
        (_, _) {},
      );
      subscription.close();
      await Future<void>.delayed(Duration.zero);
      expect(container.read(managedChatAdapterProvider), same(first));

      // An unrelated credentials-epoch bump does not rebuild it.
      container.read(pluginCredentialsEpochProvider.notifier).invalidate();
      expect(container.read(managedChatAdapterProvider), same(first));

      // An account switch changes the scope → a new adapter instance.
      await container
          .read(authCredentialsProvider.notifier)
          .save(_credentials('b'));
      final switched = container.read(managedChatAdapterProvider);
      expect(switched, isNot(same(first)));
      expect(switched.scope.ownerId, 'b');
    },
  );

  test(
    'sendTurn succeeds end-to-end through the adapter into the scoped store '
    'with exactly one user row',
    () async {
      await seedReadyConfig();
      final adapter = container.read(managedChatAdapterProvider);

      final outcome = await adapter.sendTurn(
        'c1',
        history: const [],
        userText: 'hi',
      );

      expect(outcome.state, 'seeded');
      expect(outcome.sessionId, isNotEmpty);
      final request = client.requests.single;
      expect(request.modelPluginId, 'text');
      expect(request.enabledPlugins, ['web']);
      expect(request.gatewayKey, 'gateway-secret');
      final body = request.toJson();
      expect(body['conversation_mode'], 'managed');
      expect(body['model'], 'text');
      expect(body['enabled_plugins'], ['web']);
      expect((body['messages'] as List).map((m) => m['content']), ['hi']);

      final repo = container.read(managedConversationRepositoryProvider);
      final stored = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(stored, isNotNull);
      final users = stored!.messages
          .where((m) => m.role == MessageRole.user)
          .toList();
      expect(users, hasLength(1));
      expect(users.single.content, 'hi');
      expect(
        stored.messages
            .where((m) => m.role == MessageRole.assistant)
            .single
            .content,
        'local reply',
      );
      expect(await db.select(db.messages).get(), hasLength(2));
      expect(await repo.pending(scope, 'c1'), isNull);
      expect(await repo.mappedSession('c1'), outcome.sessionId);
    },
  );

  test(
    'resolution failure without a selected model surfaces as '
    'PluginClientException(no_selected_model)',
    () async {
      // Models are listed, but the account has no selection.
      registry.models = [_model('text')];
      final adapter = container.read(managedChatAdapterProvider);
      await expectLater(
        adapter.sendTurn('c1', history: const [], userText: 'hi'),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'no_selected_model',
          ),
        ),
      );
      expect(client.requests, isEmpty);
      expect(await db.select(db.conversations).get(), isEmpty);
    },
  );

  test(
    'resolution failure without model credentials surfaces as '
    'PluginClientException(no_credentials)',
    () async {
      registry.models = [_model('text')];
      // The model is selected but its apiKey was never saved.
      await pluginStore.setSelectedModel(scope, 'text');
      final adapter = container.read(managedChatAdapterProvider);
      await expectLater(
        adapter.sendTurn('c1', history: const [], userText: 'hi'),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'no_credentials',
          ),
        ),
      );
      expect(client.requests, isEmpty);
    },
  );

  test('retryTurn forwards to the service and replays the persisted messageId',
      () async {
        await seedReadyConfig();
        respondWith = (_) => throw const PluginClientException('network_error');
        final adapter = container.read(managedChatAdapterProvider);
        await expectLater(
          adapter.sendTurn('c1', history: const [], userText: 'hi'),
          throwsA(
            isA<ManagedTurnError>().having(
              (e) => e.code,
              'code',
              'network_error',
            ),
          ),
        );
        final repo = container.read(managedConversationRepositoryProvider);
        final pending = (await repo.pending(scope, 'c1'))!;
        final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
        expect(envelope['userMessageId'], isNotEmpty);

        respondWith = (request) async => ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'resumed',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        );
        final outcome = await adapter.retryTurn('c1');
        expect(outcome.state, 'resumed');
        expect(outcome.userMessageId, envelope['userMessageId'],
            reason: 'P1b: the retry outcome carries the admitted row id '
                'persisted in the envelope');
        expect(client.requests.last.turnId, pending.messageId);
        expect(await repo.pending(scope, 'c1'), isNull);
      });

  test(
    'submitBackground forwards to the service as a background ledger job',
    () async {
      await seedReadyConfig();
      final adapter = container.read(managedChatAdapterProvider);
      final handle = await adapter.submitBackground(
        'c1',
        history: const [],
        userText: 'later',
      );
      expect(handle, isA<LedgerPollHandle>());
      final request = client.requests.single;
      expect(request.background, isTrue);
      expect(request.conversationPublicId, isNull);
      expect((request.toJson()['messages'] as List).map((m) => m['content']), [
        'later',
      ]);
      final repo = container.read(managedConversationRepositoryProvider);
      final pending = (await repo.pending(scope, 'c1'))!;
      final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
      expect(envelope['background'], isTrue);
      expect(envelope['model'], 'text');
    },
  );

  test(
    'rewatchPendingBackgroundOnForeground re-watches every still-pending '
    'BACKGROUND row and skips non-background pending rows',
    () async {
      await seedReadyConfig();
      final adapter = container.read(managedChatAdapterProvider);
      await adapter.submitBackground(
        'c1',
        history: const [],
        userText: 'job',
      );
      // A streaming turn left hanging holds a non-background pending row.
      final gate = Completer<ManagedTurnResult>();
      respondWith = (_) => gate.future;
      final sent = adapter.sendTurn('c2', history: const [], userText: 'hi');
      final repo = container.read(managedConversationRepositoryProvider);
      while ((await repo.pending(scope, 'c2')) == null) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(await repo.pending(scope, 'c1'), isNotNull);
      expect(await repo.pending(scope, 'c2'), isNotNull);

      final rewound = await adapter.rewatchPendingBackgroundOnForeground();
      expect(rewound, ['c1'],
          reason: 'only the background envelope gets a fresh watch');

      await adapter.abandonTurn('c2', partialText: '');
      sent.ignore();
    },
  );

  test(
    'rewatchPendingBackgroundOnForeground with no pending rows re-watches '
    'nothing',
    () async {
      await seedReadyConfig();
      final adapter = container.read(managedChatAdapterProvider);
      expect(await adapter.rewatchPendingBackgroundOnForeground(), isEmpty);
    },
  );

  test(
    'reconcileFromServer forwards to the service and swaps in the server '
    'session history',
    () async {
      await seedReadyConfig();
      final adapter = container.read(managedChatAdapterProvider);
      final outcome = await adapter.sendTurn(
        'c1',
        history: const [],
        userText: 'hi',
      );
      final messages = await adapter.reconcileFromServer(outcome.sessionId.isEmpty ? 'c1' : 'c1');
      expect(client.sessionLoads, [outcome.sessionId]);
      expect(messages.map((m) => m.content), ['hi', 'from server']);
    },
  );

  test('abandonTurn forwards to the service: mid-dispatch cancel clears the '
      'pending row and persists the partial', () async {
    await seedReadyConfig();
    final gate = Completer<ManagedTurnResult>();
    respondWith = (_) => gate.future;
    final adapter = container.read(managedChatAdapterProvider);
    final sent = adapter.sendTurn('c1', history: const [], userText: 'hi');
    final repo = container.read(managedConversationRepositoryProvider);
    while ((await repo.pending(scope, 'c1')) == null) {
      await Future<void>.delayed(Duration.zero);
      if (client.requests.isNotEmpty) break;
    }
    // Give admission one more tick if the request has not been recorded yet.
    while (client.requests.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }

    // Mid-flight: the server has the user message but no reply yet, so the
    // terminal check must fall through to the partial-retention path.
    client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
      'sessionId': sessionId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
      ],
    });

    await adapter.abandonTurn('c1', partialText: 'partial ');

    expect(await repo.pending(scope, 'c1'), isNull);
    final dispatched = client.cancelTokens.single;
    expect(dispatched!.isCancelled, isTrue);
    final stored = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(stored!.messages, hasLength(2));
    expect(stored.messages.last.content, 'partial ');
    sent.ignore();
  });

  test('abandonTurn works when model selection is broken — the fallback '
      'service still clears the pending row', () async {
    await seedReadyConfig();
    final gate = Completer<ManagedTurnResult>();
    respondWith = (_) => gate.future;
    final adapter = container.read(managedChatAdapterProvider);
    final sent = adapter.sendTurn('c1', history: const [], userText: 'hi');
    while (client.requests.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }
    final repo = container.read(managedConversationRepositoryProvider);
    expect(await repo.pending(scope, 'c1'), isNotNull);

    // Break selection: no models → buildService would throw no_selected_model.
    registry.models = [];

    await adapter.abandonTurn('c1', partialText: 'partial ');

    expect(await repo.pending(scope, 'c1'), isNull);
    final stored = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(stored!.messages.last.content, 'partial ');
    sent.ignore();
  });
}
