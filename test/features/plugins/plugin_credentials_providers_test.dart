import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/plugin_catalog_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_registry_client.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;
import 'plugin_credentials_store_test.dart' show DelayedSecureStorage;

class FakeRegistryClient extends PluginRegistryClient {
  FakeRegistryClient()
    : super(dio: Dio(), baseUrl: 'http://example.com:17600/v1');

  List<Map<String, dynamic>> templates = const [];
  Object? error;

  @override
  Future<List<Map<String, dynamic>>> fetchAgentTemplates({
    required String gatewayKey,
  }) async {
    final failure = error;
    if (failure != null) throw failure;
    return templates;
  }
}

AuthCredentials credentials(String owner, {String key = 'key'}) =>
    AuthCredentials(
      apiKey: key,
      ownerId: owner,
      backendOrigin: 'http://example.com:17600',
    );

void main() {
  late ProviderContainer container;
  late PluginCredentialsStore store;
  late FakeAuthCredentialsStore authStore;
  late FakeRegistryClient registry;

  setUp(() async {
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    authStore = FakeAuthCredentialsStore(stored: credentials('a'));
    registry = FakeRegistryClient();
    final db = AppDatabase(NativeDatabase.memory());
    addTearDown(db.close);
    container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(authStore),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(store),
        pluginRegistryClientProvider.overrideWithValue(registry),
        databaseProvider.overrideWithValue(db),
      ],
    );
    await container.read(authCredentialsProvider.future);
    await container.read(settingsProvider.future);
  });

  tearDown(() => container.dispose());

  test('writes publish after persistence and increment epoch; stale handle rejected', () async {
    final subscription = container.listen(pluginCredentialsProvider, (_, _) {});
    addTearDown(subscription.close);
    final mutations = container.listen(
      scopedPluginCredentialsProvider,
      (_, _) {},
    );
    addTearDown(mutations.close);
    await container.read(pluginCredentialsProvider.future);
    final handle = container.read(scopedPluginCredentialsProvider);
    final before = container.read(pluginCredentialsEpochProvider);
    await handle.setCredentials('one', {'token': 'a'});
    expect(container.read(pluginCredentialsEpochProvider), greaterThan(before));
    final config = await container.read(pluginCredentialsProvider.future);
    expect(config.plugins['one']!.credentials['token'], 'a');
    await expectLater(
      handle.setEnabled('one', true),
      throwsA(isA<PluginReauthenticationRequired>()),
    );
    await container
        .read(scopedPluginCredentialsProvider)
        .setEnabled('one', true);
    expect(
      (await container.read(pluginCredentialsProvider.future))
          .plugins['one']!
          .enabled,
      isTrue,
    );
  });
test(
    'owner switch and rotation invalidate epoch without transferring data',
    () async {
      final subscription = container.listen(
        pluginCredentialsProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await store.setCredentials(credentials('a').accountScope!, 'one', {
        'token': 'a',
      });
      await container.read(pluginCredentialsProvider.future);
      final oldHandle = container.read(scopedPluginCredentialsProvider);
      final oldEpoch = container.read(pluginCredentialsEpochProvider);
      await container
          .read(authCredentialsProvider.notifier)
          .save(credentials('b'));
      expect(
        container.read(pluginCredentialsEpochProvider),
        greaterThan(oldEpoch),
      );
      // No agent templates exist, so nothing is fabricated for the new scope;
      // the original 'one' plugin is not carried over.
      expect(
        (await container.read(pluginCredentialsProvider.future)).plugins,
        isEmpty,
      );
      expect(
        (await container.read(pluginCredentialsProvider.future)).plugins.keys,
        isNot(contains('one')),
      );
      await expectLater(
        oldHandle.setEnabled('one', true),
        throwsA(isA<PluginReauthenticationRequired>()),
      );
      await container
          .read(authCredentialsProvider.notifier)
          .save(credentials('a', key: 'rotated'));
      // Scope 'a' had its plugin store cleared on the owner switch and no
      // agent templates exist, so nothing is fabricated back.
      expect(
        (await container.read(pluginCredentialsProvider.future)).plugins,
        isEmpty,
      );
      await container.read(authCredentialsProvider.notifier).clear();
      await expectLater(
        container.read(pluginCredentialsProvider.future),
        throwsA(anything),
      );
      expect(
        (await store.load(credentials('a').accountScope!)).plugins,
        isEmpty,
      );
    },
  );

  test(
    'settings origin switch rejects old identity until reauthentication',
    () async {
      final subscription = container.listen(
        pluginCredentialsProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await container.read(pluginCredentialsProvider.future);
      final handle = container.read(scopedPluginCredentialsProvider);
      await container
          .read(settingsProvider.notifier)
          .save(const BackendSettings(host: 'other.example'));
      expect(
        container.read(authBackendOriginProvider),
        'http://other.example:17600',
      );
      await expectLater(
        container.read(pluginCredentialsProvider.future),
        throwsA(anything),
      );
      await expectLater(
        handle.setEnabled('one', true),
        throwsA(isA<PluginReauthenticationRequired>()),
      );
    },
  );

  test(
    'legacy credentials fail closed with a reauthentication message',
    () async {
      await container
          .read(authCredentialsProvider.notifier)
          .save(
            const AuthCredentials(
              apiKey: 'legacy',
              email: 'a@example.com',
              keyId: 'not-owner',
            ),
          );
      final subscription = container.listen(
        pluginCredentialsProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await expectLater(
        container.read(pluginCredentialsProvider.future),
        throwsA(
          predicate(
            (e) => e.toString().contains('Sign in again to configure plugins'),
          ),
        ),
      );
    },
  );

  test('failed plugin write does not advance epoch or publish data', () async {
    final storage = DelayedSecureStorage()..failNextWrite = true;
    container.dispose();
    container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(authStore),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(
          PluginCredentialsStore(storage: storage),
        ),
        pluginRegistryClientProvider.overrideWithValue(registry),
      ],
    );
    await container.read(authCredentialsProvider.future);
    await container.read(settingsProvider.future);
    final subscription = container.listen(pluginCredentialsProvider, (_, _) {});
    addTearDown(subscription.close);
    await container.read(pluginCredentialsProvider.future);
    final before = container.read(pluginCredentialsEpochProvider);
    await expectLater(
      container.read(scopedPluginCredentialsProvider).setEnabled('one', true),
      throwsStateError,
    );
    expect(container.read(pluginCredentialsEpochProvider), before);
    expect(
      (await container.read(pluginCredentialsProvider.future)).plugins,
      isEmpty,
    );
  });

  test(
    'seeding picks the first catalog template id when the store is empty',
    () async {
      registry.templates = [
        {'id': 'kitchen-copilot', 'name': 'Kitchen Copilot'},
        {'id': 'research-assistant', 'name': 'Research Assistant'},
      ];
      final config = await container.read(pluginCredentialsProvider.future);
      expect(config.plugins.keys, ['kitchen-copilot']);
      expect(config.plugins['kitchen-copilot']!.enabled, isTrue);
      expect(
        config.plugins['kitchen-copilot']!.agent!.id,
        'kitchen-copilot',
      );
      expect(config.selectedAgent, 'kitchen-copilot');
    },
  );

  test(
    'seeding adopts the default template when a model is set but no agent',
    () async {
      registry.templates = [
        {'id': 'voice-assistant', 'name': 'Voice Assistant'},
      ];
      final scope = credentials('a').accountScope!;
      await store.setCredentials(scope, 'openrouter', {'apiKey': 'sk-x'});
      await store.setSelectedModel(scope, 'openrouter');
      final config = await container.read(pluginCredentialsProvider.future);
      expect(config.selectedModel, 'openrouter');
      expect(config.selectedAgent, 'voice-assistant');
      expect(
        config.plugins['voice-assistant']!.agent!.kind,
        AgentKind.template,
      );
    },
  );

  test(
    'seeding leaves the store empty when the template fetch fails',
    () async {
      registry.error = DioException(
        requestOptions: RequestOptions(path: '/v1/agents'),
        type: DioExceptionType.connectionError,
      );
      final config = await container.read(pluginCredentialsProvider.future);
      expect(config.plugins, isEmpty);
      expect(config.selectedAgent, isNull);
    },
  );
}
