import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:drift/native.dart';

import '../../fakes.dart';
import '../plugins/plugin_credentials_store_test.dart'
    show DelayedSecureStorage;

class MemoryAuthStore implements AuthCredentialsStore {
  MemoryAuthStore(this.value);

  AuthCredentials? value;
  Completer<void>? saveGate;
  final saveStarted = Completer<void>();

  @override
  Future<AuthCredentials?> load() async => value;

  @override
  Future<void> save(AuthCredentials credentials) async {
    if (!saveStarted.isCompleted) saveStarted.complete();
    await saveGate?.future;
    value = credentials;
  }

  @override
  Future<void> clear() async => value = null;
}

AuthCredentials credentials(String owner, {String key = 'key'}) =>
    AuthCredentials(
      apiKey: key,
      ownerId: owner,
      backendOrigin: 'http://example.com:17600',
    );

void main() {
  late ProviderContainer container;
  late MemoryAuthStore store;
  late AccountLifecycle lifecycle;
  late List<String> events;

  setUp(() async {
    events = [];
    lifecycle = AccountLifecycle();
    lifecycle.register(
      AccountCleanupRegistration(
        cancelPending: () => events.add('cancel'),
        clearLocal: (scope) async => events.add('clear:${scope.ownerId}'),
      ),
    );
    store = MemoryAuthStore(credentials('a'));
    container = ProviderContainer(
      overrides: [
        accountLifecycleProvider.overrideWithValue(lifecycle),
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
      ],
    );
    await container.read(authCredentialsProvider.future);
  });

  tearDown(() => container.dispose());

  test('overlapping save and logout never republishes a late login', () async {
    final notifier = container.read(authCredentialsProvider.notifier);
    final epoch = notifier.captureEpoch();
    store.saveGate = Completer<void>();
    final save = notifier.save(credentials('b'), expectedEpoch: epoch);
    final rejected = expectLater(
      save,
      throwsA(isA<AccountLifecycleCancelled>()),
    );
    await store.saveStarted.future;
    final logout = notifier.clear();
    expect(container.read(authCredentialsProvider).value, isNull);
    store.saveGate!.complete();
    await rejected;
    await logout;
    expect(store.value, isNull);
    expect(container.read(authCredentialsProvider).value, isNull);
    expect(events, ['cancel', 'clear:a', 'cancel', 'clear:b']);
    await expectLater(
      notifier.save(credentials('a'), expectedEpoch: epoch),
      throwsA(isA<AccountLifecycleCancelled>()),
    );
    expect(store.value, isNull);
  });

  test('late mint after logout is rejected before storage', () async {
    final notifier = container.read(authCredentialsProvider.notifier);
    final epoch = notifier.captureEpoch();
    await notifier.clear();
    await expectLater(
      notifier.save(credentials('b'), expectedEpoch: epoch),
      throwsA(isA<AccountLifecycleCancelled>()),
    );
    expect(store.saveStarted.isCompleted, isFalse);
  });

  test('direct owner switch cancels then clears only previous scope', () async {
    await container
        .read(authCredentialsProvider.notifier)
        .save(credentials('b'));
    expect(events, ['cancel', 'clear:a']);
    expect(store.value, credentials('b'));
  });

  test(
    'same owner rotation cancels without deleting local configuration',
    () async {
      await container
          .read(authCredentialsProvider.notifier)
          .save(credentials('a', key: 'rotated'));
      expect(events, ['cancel']);
      expect(store.value!.apiKey, 'rotated');
    },
  );

  test(
    'cleanup failure blocks state and retry retains previous scope',
    () async {
      var fail = true;
      lifecycle.register(
        AccountCleanupRegistration(
          cancelPending: () {},
          clearLocal: (_) async {
            if (fail) throw StateError('cleanup failed');
          },
        ),
      );
      final notifier = container.read(authCredentialsProvider.notifier);
      await expectLater(notifier.save(credentials('b')), throwsStateError);
      expect(container.read(authCredentialsProvider).hasError, isTrue);
      expect(container.read(authCredentialsProvider).value, isNull);
      expect(lifecycle.blocked, isTrue);
      expect(store.value, credentials('a'));
      fail = false;
      await notifier.clear();
      expect(events, ['cancel', 'clear:a', 'cancel', 'clear:a']);
      expect(store.value, isNull);
      expect(lifecycle.blocked, isFalse);
    },
  );

  test('legacy unscoped auth still clears on logout', () async {
    await container
        .read(authCredentialsProvider.notifier)
        .save(const AuthCredentials(apiKey: 'legacy'));
    events.clear();
    await container.read(authCredentialsProvider.notifier).clear();
    expect(events, ['cancel']);
    expect(store.value, isNull);
  });

  test(
    'logout drains plugin writes and rejects retained mutation handles',
    () async {
      container.dispose();
      final storage = DelayedSecureStorage();
      final plugins = PluginCredentialsStore(storage: storage);
      container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
          pluginCredentialsStoreProvider.overrideWithValue(plugins),
          // The real lifecycle's managed-conversation registration clears the
          // scoped Drift data on logout; keep that DB out of the host filesystem.
          managedConversationRepositoryProvider.overrideWithValue(
            ManagedConversationRepository(AppDatabase(NativeDatabase.memory())),
          ),
          settingsStoreProvider.overrideWithValue(
            FakeSettingsStore(
              stored: const BackendSettings(host: 'example.com'),
            ),
          ),
        ],
      );
      await container.read(authCredentialsProvider.future);
      await container.read(settingsProvider.future);
      final subscription = container.listen(
        scopedPluginCredentialsProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final handle = container.read(scopedPluginCredentialsProvider);
      storage.gate = Completer<void>();
      final write = handle.setCredentials('one', {'token': 'local'});
      final logout = container.read(authCredentialsProvider.notifier).clear();
      await expectLater(
        handle.setEnabled('one', true),
        throwsA(isA<PluginReauthenticationRequired>()),
      );
      storage.gate!.complete();
      await write;
      await logout;
      expect(
        (await plugins.load(credentials('a').accountScope!)).plugins,
        isEmpty,
      );
      expect(store.value, isNull);
    },
  );

  test('registered storage drains late saves before scoped deletion', () async {
    final gate = Completer<void>();
    final rows = <String>[];
    final oldEpoch = lifecycle.epoch;
    final lateWrite = gate.future.then((_) => rows.add('a'));
    lifecycle.register(
      AccountCleanupRegistration(
        cancelPending: () => lateWrite,
        clearLocal: (scope) async => rows.remove(scope.ownerId),
      ),
    );
    final logout = container.read(authCredentialsProvider.notifier).clear();
    expect(
      () => lifecycle.checkCurrent(oldEpoch),
      throwsA(isA<AccountLifecycleCancelled>()),
    );
    expect(store.value, isNotNull);
    gate.complete();
    await logout;
    expect(rows, isEmpty);
    expect(store.value, isNull);
  });

  test(
    'backend origin change clears old auth without remote requests',
    () async {
      container.dispose();
      container = ProviderContainer(
        overrides: [
          accountLifecycleProvider.overrideWithValue(lifecycle),
          authCredentialsStoreProvider.overrideWithValue(store),
          settingsStoreProvider.overrideWithValue(
            FakeSettingsStore(
              stored: const BackendSettings(host: 'example.com'),
            ),
          ),
        ],
      );
      await container.read(settingsProvider.future);
      await container.read(authCredentialsProvider.future);
      await container
          .read(settingsProvider.notifier)
          .save(
            const BackendSettings(
              host: 'other.example',
              environment: BackendEnvironment.production,
            ),
          );
      container.read(authBackendOriginProvider);
      // The origin listener clears auth in the background; drain the transition
      // chain before asserting on the store.
      for (var i = 0; i < 5; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(container.read(authCredentialsProvider).value, isNull);
      expect(store.value, isNull);
      expect(events, ['cancel', 'clear:a']);
    },
  );

  test('new origin rejects credentials before saving', () async {
    await expectLater(
      container
          .read(authCredentialsProvider.notifier)
          .save(
            const AuthCredentials(
              apiKey: 'other',
              ownerId: 'a',
              backendOrigin: 'http://other.example:17600',
            ),
          ),
      throwsA(isA<AccountLifecycleCancelled>()),
    );
    expect(store.saveStarted.isCompleted, isFalse);
  });

  test(
    'logout clears the scoped managed conversations + pending rows via the '
    'lifecycle, keeping other scopes and unscoped legacy history',
    () async {
      container.dispose();
      final db = AppDatabase(NativeDatabase.memory());
      addTearDown(db.close);
      final repo = ManagedConversationRepository(db);
      final pluginStorage = DelayedSecureStorage();
      container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
          pluginCredentialsStoreProvider.overrideWithValue(
            PluginCredentialsStore(storage: pluginStorage),
          ),
          managedConversationRepositoryProvider.overrideWithValue(repo),
          settingsStoreProvider.overrideWithValue(
            FakeSettingsStore(
              stored: const BackendSettings(host: 'example.com'),
            ),
          ),
          // The real accountLifecycleProvider builds the graph, so the chat
          // store it invalidates must be faked.
          chatStoreProvider.overrideWithValue(FakeChatStore()),
        ],
      );
      await container.read(authCredentialsProvider.future);

      final scopeA = credentials('a').accountScope!;
      final scopeB = credentials('b').accountScope!;
      Future<void> seed(
        AuthAccountScope scope,
        String id,
      ) async {
        await repo.access(scope, repo.epoch(scope), () {}, (store) async {
          await store.saveConversation(
            Conversation(
              id: id,
              title: 'T',
              createdAt: DateTime(2024),
              updatedAt: DateTime(2024),
              messages: const [
                Message(id: 'm1', role: MessageRole.user, content: 'hi'),
              ],
            ),
          );
        });
        await repo.savePending(id, scope, 'msg-$id', {'model': 'openrouter'});
      }

      await seed(scopeA, 'c-a');
      await seed(scopeB, 'c-b');
      // Unscoped legacy history must survive a scoped logout untouched.
      final legacyStore = DriftChatStore(db);
      final legacy = Conversation(
        id: 'legacy',
        title: 'Legacy',
        createdAt: DateTime(2024),
        updatedAt: DateTime(2024),
        messages: const [
          Message(id: 'lm1', role: MessageRole.user, content: 'old'),
        ],
      );
      await legacyStore.saveConversation(legacy);

      final epochBefore = repo.epoch(scopeA);
      await container.read(authCredentialsProvider.notifier).clear();

      expect(repo.epoch(scopeA), greaterThan(epochBefore));
      expect(await repo.pending(scopeA, 'c-a'), isNull);
      final listA = await repo.access(
        scopeA,
        repo.epoch(scopeA),
        () {},
        (s) => s.watchConversations().first,
      );
      expect(listA, isEmpty);

      // A different owner's conversation is not collateral.
      expect(await repo.pending(scopeB, 'c-b'), isNotNull);
      final listB = await repo.access(
        scopeB,
        repo.epoch(scopeB),
        () {},
        (s) => s.watchConversations().first,
      );
      expect(listB.single.id, 'c-b');

      // Unscoped legacy history is retained.
      final legacyList = await legacyStore.watchConversations().first;
      expect(legacyList.single.id, 'legacy');
    },
  );
}
