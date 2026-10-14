import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/attachments/data/file_cache.dart';
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/data/file_store.dart';
import 'package:ai_assistant/features/attachments/data/upload_queue.dart';
import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/memory/data/memory_model.dart';
import 'package:ai_assistant/features/memory/data/memory_store.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';

import '../../fakes.dart';
import '../plugins/plugin_credentials_store_test.dart'
    show DelayedSecureStorage;
import 'auth_credentials_store_test.dart' show InMemorySecureStorage;

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

AuthAccountScope accountScope(String owner) => AuthAccountScope.fromIdentity(
  backendOrigin: 'http://example.com:17600',
  ownerId: owner,
)!;

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

  test('logout drains plugin writes and rejects retained mutation handles', () async {
    container.dispose();
    final storage = DelayedSecureStorage();
    final plugins = PluginCredentialsStore(storage: storage);
    container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
        pluginCredentialsStoreProvider.overrideWithValue(plugins),
        // The real lifecycle's managed-conversation registration clears the
        // scoped Drift data on logout; keep that DB out of the host filesystem.
        managedConversationRepositoryProvider.overrideWithValue(
          ManagedConversationRepository(AppDatabase(NativeDatabase.memory())),
        ),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
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
  });

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

  test('logout clears the scoped managed conversations + pending rows via the '
      'lifecycle, keeping other scopes and unscoped legacy history', () async {
    container.dispose();
    final db = AppDatabase(NativeDatabase.memory());
    addTearDown(db.close);
    final repo = ManagedConversationRepository(db);
    final pluginStorage = DelayedSecureStorage();
    container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
        pluginCredentialsStoreProvider.overrideWithValue(
          PluginCredentialsStore(storage: pluginStorage),
        ),
        managedConversationRepositoryProvider.overrideWithValue(repo),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        // The real accountLifecycleProvider builds the graph, so the chat
        // store it invalidates must be faked.
        chatStoreProvider.overrideWithValue(FakeChatStore()),
      ],
    );
    await container.read(authCredentialsProvider.future);

    final scopeA = credentials('a').accountScope!;
    final scopeB = credentials('b').accountScope!;
    Future<void> seed(AuthAccountScope scope, String id) async {
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
  });

  test(
    'account deletion invalidates the managed poller for the deleted scope',
    () async {
      container.dispose();
      final db = AppDatabase(NativeDatabase.memory());
      addTearDown(db.close);
      final repo = ManagedConversationRepository(db);
      final plugins = PluginCredentialsStore(storage: InMemorySecureStorage());
      final pollers = <LedgerPoller>[];
      LedgerPoller pollerFactory({
        required AuthAccountScope scope,
        required LedgerCredentialsResolver credentials,
      }) {
        final dio = Dio();
        final poller = LedgerPoller(
          client: LedgerClient(dio: dio, scope: scope),
          credentials: credentials,
        );
        pollers.add(poller);
        addTearDown(() {
          poller.dispose();
          dio.close(force: true);
        });
        return poller;
      }

      container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
          pluginCredentialsStoreProvider.overrideWithValue(plugins),
          managedConversationRepositoryProvider.overrideWithValue(repo),
          managedChatPollerFactoryProvider.overrideWithValue(pollerFactory),
          settingsStoreProvider.overrideWithValue(
            FakeSettingsStore(
              stored: const BackendSettings(host: 'example.com'),
            ),
          ),
          chatStoreProvider.overrideWithValue(FakeChatStore()),
        ],
      );
      await container.read(authCredentialsProvider.future);
      await container.read(settingsProvider.future);
      final scope = container.read(pluginAccountScopeProvider);
      final poller = container.read(managedChatAdapterProvider).poller;
      final handle = poller.watch(const LedgerLookup.byTaskId('task'));
      final lifecycle = container.read(accountLifecycleProvider);

      await lifecycle.clearLocal(scope);
      expect((await handle.done).end, LedgerPollEnd.cancelled);
      expect(
        () => poller.watch(const LedgerLookup.byTaskId('after-clear')),
        returnsNormally,
      );
      final deletionHandle = poller.watch(
        const LedgerLookup.byTaskId('during-delete'),
      );

      await wipeLocalAccountData(
        scope: scope,
        lifecycle: lifecycle,
        clearCredentials: () =>
            container.read(authCredentialsProvider.notifier).clear(),
        fileStore: FakeFileStore(scopeKey: scope.storageId),
        memoryStore: FakeMemoryStore(scopeKey: scope.storageId),
        fileCache: _CountingFileCache(scopeKey: scope.storageId),
      );

      expect((await deletionHandle.done).end, LedgerPollEnd.cancelled);
      expect(container.read(authCredentialsProvider).value, isNull);
      expect(
        () => poller.watch(const LedgerLookup.byTaskId('after-delete')),
        throwsA(isA<PluginClientException>()),
      );
    },
  );

  group('wipeLocalAccountData', () {
    test(
      'drains gated uploads and downloads before wiping local account data',
      () async {
        final scope = accountScope('a');
        final order = <String>[];
        final fileStore = _OrderFileStore(order, scopeKey: scope.storageId);
        final memoryStore = _OrderMemoryStore(order, scopeKey: scope.storageId);
        final fileCache = _OrderFileCache(order, scopeKey: scope.storageId);
        final uploadGate = Completer<FileInfo>();
        final uploadSettled = Completer<void>();
        final uploadFiles = FakeFilesClient(
          uploadCompleter: uploadGate,
          honorCancellation: false,
          onUploadSettled: () {
            order.add('uploads');
            if (!uploadSettled.isCompleted) uploadSettled.complete();
          },
        );
        final uploadQueue = UploadQueue(
          filesService: uploadFiles,
          maxConcurrent: 1,
        );
        lifecycle.registerUploadQueue(uploadQueue);
        await uploadQueue.enqueue(
          path: '/tmp/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        );
        while (uploadFiles.uploadCalls.isEmpty) {
          await Future<void>.delayed(Duration.zero);
        }

        final drainGate = Completer<void>();
        final drainStarted = Completer<void>();
        final downloadCancelled = Completer<void>();
        var credentialsCleared = false;
        final download = lifecycle.runAttachmentDownload(scope.storageId, (
          registration,
        ) async {
          registration.cancelToken.whenCancel.then((_) {
            if (!downloadCancelled.isCompleted) downloadCancelled.complete();
          });
          drainStarted.complete();
          await drainGate.future;
          order.add('drain');
          registration.checkCurrent();
        });
        final downloadFailure = expectLater(
          download,
          throwsA(isA<AttachmentDownloadCancelled>()),
        );
        await drainStarted.future;

        var wipeCompleted = false;
        final wipe = wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async {
            credentialsCleared = true;
            order.add('credentials');
          },
          fileStore: fileStore,
          memoryStore: memoryStore,
          fileCache: fileCache,
        ).whenComplete(() => wipeCompleted = true);
        await Future<void>.delayed(Duration.zero);
        expect(order, isEmpty);
        expect(wipeCompleted, isFalse);
        expect(fileStore.deleteAllCalls, 0);

        uploadGate.complete(
          const FileInfo(
            id: 'uploaded',
            filename: 'a.jpg',
            sizeBytes: 1,
            mimeType: 'image/jpeg',
          ),
        );
        await uploadSettled.future;
        expect(order, ['uploads']);
        expect(wipeCompleted, isFalse);
        await downloadCancelled.future;
        drainGate.complete();
        await downloadFailure;
        await wipe;

        expect(order, [
          'uploads',
          'drain',
          'files',
          'memories',
          'cache',
          'credentials',
        ]);
        expect(credentialsCleared, isTrue);
        expect(uploadQueue.jobs.value.single.status, UploadStatus.failed);
        expect(fileStore.deleteAllCalls, 1);
        expect(memoryStore.deleteAllCalls, 1);
        expect(fileCache.evictAllForScopeCalls, 1);
        expect(fileStore.deletedScopes, [scope.storageId]);
        expect(memoryStore.deletedScopes, [scope.storageId]);
        expect(fileCache.evictedScopes, [scope.storageId]);
      },
    );

    test(
      'rejects upload registration and enqueue while deletion is draining',
      () async {
        final scope = accountScope('a');
        final lifecycle = AccountLifecycle();
        final gate = Completer<FileInfo>();
        final uploadFiles = FakeFilesClient(
          honorCancellation: false,
          uploadCompleter: gate,
        );
        final queue = UploadQueue(filesService: uploadFiles, maxConcurrent: 1);
        lifecycle.registerUploadQueue(queue);
        await queue.enqueue(
          path: '/tmp/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        );
        while (uploadFiles.uploadCalls.isEmpty) {
          await Future<void>.delayed(Duration.zero);
        }

        final wipe = wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async {},
          fileStore: FakeFileStore(scopeKey: scope.storageId),
          memoryStore: FakeMemoryStore(scopeKey: scope.storageId),
          fileCache: _CountingFileCache(scopeKey: scope.storageId),
        );
        final newQueue = UploadQueue(filesService: FakeFilesClient());
        expect(
          () => lifecycle.registerUploadQueue(newQueue),
          throwsA(isA<AccountLifecycleCancelled>()),
        );
        final id = await queue.enqueue(
          path: '/tmp/b.jpg',
          filename: 'b.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        );
        expect(uploadFiles.uploadCalls, hasLength(1));
        expect(
          queue.jobs.value.singleWhere((job) => job.id == id).status,
          UploadStatus.failed,
        );

        gate.complete(
          const FileInfo(
            id: 'uploaded',
            filename: 'a.jpg',
            sizeBytes: 1,
            mimeType: 'image/jpeg',
          ),
        );
        await wipe;
      },
    );

    test(
      're-collects upload queues that are registered between drain passes',
      () async {
        final lifecycle = AccountLifecycle();
        final first = _CountingUploadQueue();
        final second = _CountingUploadQueue();
        lifecycle.registerUploadQueue(first);
        lifecycle.registerUploadQueue(second);
        var registered = false;
        second.onDrain = () {
          if (!registered) {
            registered = true;
            lifecycle.registerUploadQueue(_CountingUploadQueue());
          }
        };

        await lifecycle.cancelAndDrainUploads();

        expect(first.drainCalls, 1);
        expect(second.drainCalls, 1);
      },
    );

    test(
      'refuses a new attachment registration after scope invalidation',
      () async {
        final lifecycle = AccountLifecycle();
        final scope = accountScope('a');

        await lifecycle.cancelAndDrain(scope.storageId);

        expect(
          () => lifecycle.registerAttachmentDownload(scope.storageId),
          throwsA(isA<AttachmentDownloadCancelled>()),
        );
      },
    );

    test(
      'waits for an in-progress cache write before the scoped sweep',
      () async {
        final scope = accountScope('a');
        final lifecycle = AccountLifecycle();
        final root = await Directory.systemTemp.createTemp('cache_write_drain');
        addTearDown(() => root.delete(recursive: true));
        final writeGate = Completer<void>();
        final writeStarted = Completer<void>();
        final cache = _GatedFileCache(
          cacheDir: root,
          scopeKey: scope.storageId,
          gate: writeGate,
          started: writeStarted,
        );
        final download = lifecycle.runAttachmentDownload(scope.storageId, (
          registration,
        ) {
          registration.checkCurrent();
          return cache.cacheFile('late', '.bin', Uint8List.fromList([9]));
        });
        final downloadFailure = expectLater(
          download,
          throwsA(isA<AttachmentDownloadCancelled>()),
        );
        await writeStarted.future;
        var wipeCompleted = false;
        final wipe = wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async {},
          fileStore: FakeFileStore(scopeKey: scope.storageId),
          memoryStore: FakeMemoryStore(scopeKey: scope.storageId),
          fileCache: cache,
        ).whenComplete(() => wipeCompleted = true);

        await Future<void>.delayed(Duration.zero);
        expect(wipeCompleted, isFalse);
        writeGate.complete();
        await downloadFailure;
        await wipe;
        expect(await cache.totalBytes, 0);
      },
    );

    test(
      'times out a scope download drain and tombstones the operation',
      () async {
        final scope = accountScope('a');
        final lifecycle = AccountLifecycle(
          downloadCoordinator: AttachmentDownloadCoordinator(
            drainTimeout: const Duration(milliseconds: 20),
          ),
        );
        final started = Completer<void>();
        final gate = Completer<void>();
        final download = lifecycle.runAttachmentDownload(scope.storageId, (
          registration,
        ) async {
          started.complete();
          await gate.future;
          registration.checkCurrent();
        });

        await started.future;
        await expectLater(
          lifecycle.cancelAndDrain(scope.storageId),
          throwsA(isA<AttachmentDownloadDrainTimeout>()),
        );
        gate.complete();
        await expectLater(
          download,
          throwsA(isA<AttachmentDownloadCancelled>()),
        );
      },
    );

    test('a data-wipe failure still clears credentials then throws '
        'PartialAccountWipe', () async {
      final scope = accountScope('a');
      final fileStore = FakeFileStore(scopeKey: scope.storageId)
        ..failDeleteAll = true;
      final memoryStore = FakeMemoryStore(scopeKey: scope.storageId);
      final fileCache = _CountingFileCache(scopeKey: scope.storageId);
      var credentialsCleared = false;

      await expectLater(
        wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async => credentialsCleared = true,
          fileStore: fileStore,
          memoryStore: memoryStore,
          fileCache: fileCache,
        ),
        throwsA(isA<PartialAccountWipe>()),
      );

      // Fail-closed: the server-side account is already gone, so the
      // credential clear (and the rest of the data wipe) still runs.
      expect(credentialsCleared, isTrue);
      expect(memoryStore.deleteAllCalls, 1);
      expect(fileCache.evictAllForScopeCalls, 1);
    });

    test('a failed credential clear throws PartialAccountWipe', () async {
      final scope = accountScope('a');
      await expectLater(
        wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async => throw StateError('clear failed'),
          fileStore: FakeFileStore(scopeKey: scope.storageId),
          memoryStore: FakeMemoryStore(scopeKey: scope.storageId),
          fileCache: _CountingFileCache(scopeKey: scope.storageId),
        ),
        throwsA(
          isA<PartialAccountWipe>().having(
            (e) => e.cause,
            'cause',
            isA<StateError>(),
          ),
        ),
      );
    });

    test('a file-cache eviction failure surfaces PartialAccountWipe', () async {
      final scope = accountScope('a');
      final fileStore = FakeFileStore(scopeKey: scope.storageId);
      final memoryStore = FakeMemoryStore(scopeKey: scope.storageId);
      var credentialsCleared = false;

      await expectLater(
        wipeLocalAccountData(
          scope: scope,
          lifecycle: lifecycle,
          clearCredentials: () async => credentialsCleared = true,
          fileStore: fileStore,
          memoryStore: memoryStore,
          fileCache: _ThrowingFileCache(scopeKey: scope.storageId),
        ),
        throwsA(
          isA<PartialAccountWipe>().having(
            (e) => e.cause,
            'cause',
            isA<StateError>(),
          ),
        ),
      );

      expect(credentialsCleared, isTrue);
      expect(fileStore.deleteAllCalls, 1);
      expect(memoryStore.deleteAllCalls, 1);
    });

    test(
      'account A deletion leaves account B files, memories, and cache intact',
      () async {
        final scopeA = accountScope('a');
        final scopeB = accountScope('b');
        final db = AppDatabase(NativeDatabase.memory());
        addTearDown(db.close);
        final filesA = DriftFileStore(db, scopeKey: scopeA.storageId);
        final filesB = DriftFileStore(db, scopeKey: scopeB.storageId);
        final memoriesA = DriftMemoryStore(db, scopeKey: scopeA.storageId);
        final memoriesB = DriftMemoryStore(db, scopeKey: scopeB.storageId);
        final root = await Directory.systemTemp.createTemp(
          'account_wipe_cache',
        );
        addTearDown(() => root.delete(recursive: true));
        final cacheA = FileCache(cacheDir: root, scopeKey: scopeA.storageId);
        final cacheB = FileCache(cacheDir: root, scopeKey: scopeB.storageId);

        await filesA.saveFile(
          const FileInfo(
            id: 'shared',
            filename: 'a.jpg',
            sizeBytes: 1,
            mimeType: 'image/jpeg',
          ),
        );
        await filesB.saveFile(
          const FileInfo(
            id: 'shared',
            filename: 'b.jpg',
            sizeBytes: 1,
            mimeType: 'image/jpeg',
          ),
        );
        await memoriesA.saveMemory(
          Memory(
            id: 'shared',
            content: 'memory A',
            createdAt: DateTime(2024),
            updatedAt: DateTime(2024),
          ),
        );
        await memoriesB.saveMemory(
          Memory(
            id: 'shared',
            content: 'memory B',
            createdAt: DateTime(2024),
            updatedAt: DateTime(2024),
          ),
        );
        final pathA = await cacheA.cacheFile(
          'shared',
          '.jpg',
          Uint8List.fromList([1]),
        );
        final pathB = await cacheB.cacheFile(
          'shared',
          '.jpg',
          Uint8List.fromList([2]),
        );
        var credentialsCleared = false;

        await wipeLocalAccountData(
          scope: scopeA,
          lifecycle: lifecycle,
          clearCredentials: () async => credentialsCleared = true,
          fileStore: filesA,
          memoryStore: memoriesA,
          fileCache: cacheA,
        );

        expect(credentialsCleared, isTrue);
        expect(await filesA.getFileById('shared'), isNull);
        expect((await filesB.getFileById('shared'))!.filename, 'b.jpg');
        expect(await memoriesA.getMemory('shared'), isNull);
        expect((await memoriesB.getMemory('shared'))!.content, 'memory B');
        expect(File(pathA).existsSync(), isFalse);
        expect(File(pathB).readAsBytesSync().toList(), [2]);
        expect(await cacheB.getCached('shared'), isNotNull);
      },
    );
  });
}

class _CountingUploadQueue extends UploadQueue {
  _CountingUploadQueue() : super(filesService: FakeFilesClient());

  int drainCalls = 0;
  void Function()? onDrain;

  @override
  Future<void> cancelAndDrain() async {
    drainCalls++;
    await super.cancelAndDrain();
    onDrain?.call();
  }
}

class _GatedFileCache extends FileCache {
  _GatedFileCache({
    required super.cacheDir,
    required super.scopeKey,
    required this.gate,
    required this.started,
  });

  final Completer<void> gate;
  final Completer<void> started;

  @override
  Future<String> cacheFile(
    String fileId,
    String extension,
    Uint8List data,
  ) async {
    if (!started.isCompleted) started.complete();
    await gate.future;
    return super.cacheFile(fileId, extension, data);
  }
}

class _OrderFileCache extends FileCache {
  _OrderFileCache(this.events, {super.scopeKey = 'test-scope'})
    : super(cacheDir: Directory.systemTemp);

  final List<String> events;
  int evictAllForScopeCalls = 0;
  final List<String> evictedScopes = [];

  @override
  Future<void> evictAllForScope(String targetScope) async {
    if (targetScope != scopeKey) {
      throw StateError('File cache scope mismatch');
    }
    evictAllForScopeCalls++;
    evictedScopes.add(targetScope);
    events.add('cache');
  }
}

/// [FileCache] double whose scoped eviction always throws.
class _ThrowingFileCache extends FileCache {
  _ThrowingFileCache({super.scopeKey = 'test-scope'})
    : super(cacheDir: Directory.systemTemp);

  @override
  Future<void> evictAllForScope(String targetScope) async =>
      throw StateError('disk unavailable');
}

/// [FileCache] double that only counts successful scoped eviction calls.
class _CountingFileCache extends FileCache {
  _CountingFileCache({super.scopeKey = 'test-scope'})
    : super(cacheDir: Directory.systemTemp);

  int evictAllForScopeCalls = 0;

  @override
  Future<void> evictAllForScope(String targetScope) async {
    if (targetScope != scopeKey) {
      throw StateError('File cache scope mismatch');
    }
    evictAllForScopeCalls++;
  }
}

/// [FakeFileStore] that records wipe order via [events].
class _OrderFileStore extends FakeFileStore {
  _OrderFileStore(this.events, {required super.scopeKey});

  final List<String> events;

  @override
  Future<void> deleteAllForScope(String scopeKey) async {
    await super.deleteAllForScope(scopeKey);
    events.add('files');
  }
}

/// [FakeMemoryStore] that records wipe order via [events].
class _OrderMemoryStore extends FakeMemoryStore {
  _OrderMemoryStore(this.events, {required super.scopeKey});

  final List<String> events;

  @override
  Future<void> deleteAllMemoriesForScope(String scopeKey) async {
    await super.deleteAllMemoriesForScope(scopeKey);
    events.add('memories');
  }
}
