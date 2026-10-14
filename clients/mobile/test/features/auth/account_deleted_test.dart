import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/attachments/data/file_cache.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/auth/data/account_deleted_handler.dart';
import 'package:ai_assistant/features/auth/data/account_deleted_state.dart';
import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_error_codes.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';

import '../../fakes.dart';

class _CountingAuthStore extends FakeAuthCredentialsStore {
  _CountingAuthStore({super.stored});

  int clearCalls = 0;

  @override
  Future<void> clear() async {
    clearCalls++;
    await super.clear();
  }
}

AuthCredentials _credentials(String owner) => AuthCredentials(
  apiKey: 'gateway-key',
  ownerId: owner,
  backendOrigin: 'http://example.com:17600',
);

class _GatedDeleteFileStore extends FakeFileStore {
  _GatedDeleteFileStore({required super.scopeKey});

  final gate = Completer<void>();
  final started = Completer<void>();

  @override
  Future<void> deleteAllForScope(String targetScope) async {
    if (!started.isCompleted) started.complete();
    await gate.future;
    await super.deleteAllForScope(targetScope);
  }
}

class _FailOnceFileStore extends FakeFileStore {
  _FailOnceFileStore({required super.scopeKey});

  bool failNext = true;

  @override
  Future<void> deleteAllForScope(String targetScope) async {
    if (failNext) {
      failNext = false;
      throw StateError('temporary file-store failure');
    }
    await super.deleteAllForScope(targetScope);
  }
}

void main() {
  test(
    'concurrent account_deleted discoveries clear credentials and wipe once',
    () async {
      final store = _CountingAuthStore(stored: _credentials('owner-a'));
      final scope = store.stored!.accountScope!;
      final root = await Directory.systemTemp.createTemp('account_deleted');
      addTearDown(() => root.delete(recursive: true));
      final fileStore = FakeFileStore(scopeKey: scope.storageId);
      final memoryStore = FakeMemoryStore(scopeKey: scope.storageId);
      final fileCache = FileCache(cacheDir: root, scopeKey: scope.storageId);
      final lifecycle = AccountLifecycle();
      final container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
          accountLifecycleProvider.overrideWithValue(lifecycle),
          filesStoreProvider.overrideWithValue(fileStore),
          memoryStoreProvider.overrideWithValue(memoryStore),
          fileCacheProvider.overrideWithValue(fileCache),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authCredentialsProvider.future);

      final error = const PluginClientException(
        ManagedErrorCodes.accountDeleted,
        statusCode: 403,
      );
      await Future.wait([
        container.read(accountDeletedHandlerProvider).handle(error),
        container.read(accountDeletedHandlerProvider).handle(error),
      ]);

      expect(container.read(accountDeletedProvider), isTrue);
      expect(container.read(authCredentialsProvider).value, isNull);
      expect(store.stored, isNull);
      expect(store.clearCalls, 1);
      expect(fileStore.deleteAllCalls, 1);
      expect(memoryStore.deleteAllCalls, 1);
    },
  );

  test('a new-account save waits for the terminal wipe and cannot be cleared by it', () async {
    final store = _CountingAuthStore(stored: _credentials('owner-a'));
    final scope = store.stored!.accountScope!;
    final root = await Directory.systemTemp.createTemp('account_deleted_race');
    addTearDown(() => root.delete(recursive: true));
    final fileStore = _GatedDeleteFileStore(scopeKey: scope.storageId);
    final lifecycle = AccountLifecycle();
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
        accountLifecycleProvider.overrideWithValue(lifecycle),
        filesStoreProvider.overrideWithValue(fileStore),
        memoryStoreProvider.overrideWithValue(
          FakeMemoryStore(scopeKey: scope.storageId),
        ),
        fileCacheProvider.overrideWithValue(
          FileCache(cacheDir: root, scopeKey: scope.storageId),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);

    final wipe = container
        .read(accountDeletedHandlerProvider)
        .handle(
          const PluginClientException(
            ManagedErrorCodes.accountDeleted,
            statusCode: 403,
          ),
        );
    await fileStore.started.future;
    final save = container
        .read(authCredentialsProvider.notifier)
        .save(_credentials('owner-b'));
    expect(store.stored?.ownerId, 'owner-a');
    expect(container.read(accountDeletedProvider), isTrue);

    fileStore.gate.complete();
    await wipe;
    await save;

    expect(store.stored?.ownerId, 'owner-b');
    expect(container.read(authCredentialsProvider).value?.ownerId, 'owner-b');
    expect(container.read(accountDeletedProvider), isFalse);
    expect(fileStore.deleteAllCalls, 1);
  });

  test('a partial terminal wipe stays latched, exposes retry, and clears credentials', () async {
    final store = _CountingAuthStore(stored: _credentials('owner-a'));
    final scope = store.stored!.accountScope!;
    final root = await Directory.systemTemp.createTemp(
      'account_deleted_partial',
    );
    addTearDown(() => root.delete(recursive: true));
    final fileStore = _FailOnceFileStore(scopeKey: scope.storageId);
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
        filesStoreProvider.overrideWithValue(fileStore),
        memoryStoreProvider.overrideWithValue(
          FakeMemoryStore(scopeKey: scope.storageId),
        ),
        fileCacheProvider.overrideWithValue(
          FileCache(cacheDir: root, scopeKey: scope.storageId),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);

    final handler = container.read(accountDeletedHandlerProvider);
    final wipeError = expectLater(
      handler.handle(
        const PluginClientException(
          ManagedErrorCodes.accountDeleted,
          statusCode: 403,
        ),
      ),
      throwsA(isA<PartialAccountWipe>()),
    );
    await wipeError;

    final notifier = container.read(accountDeletedProvider.notifier);
    expect(container.read(accountDeletedProvider), isTrue);
    expect(notifier.partialCleanup, isTrue);
    expect(store.stored, isNull);

    await notifier.retry();

    expect(notifier.partialCleanup, isFalse);
    expect(container.read(accountDeletedProvider), isTrue);
    expect(fileStore.deleteAllCalls, 1);
  });

  test(
    'an ordinary credential clear resets the terminal notice latch',
    () async {
      final store = _CountingAuthStore(stored: _credentials('owner-a'));
      final scope = store.stored!.accountScope!;
      final root = await Directory.systemTemp.createTemp(
        'account_deleted_clear',
      );
      addTearDown(() => root.delete(recursive: true));
      final container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
          accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
          filesStoreProvider.overrideWithValue(
            FakeFileStore(scopeKey: scope.storageId),
          ),
          memoryStoreProvider.overrideWithValue(
            FakeMemoryStore(scopeKey: scope.storageId),
          ),
          fileCacheProvider.overrideWithValue(
            FileCache(cacheDir: root, scopeKey: scope.storageId),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authCredentialsProvider.future);

      await container
          .read(accountDeletedHandlerProvider)
          .handle(
            const PluginClientException(
              ManagedErrorCodes.accountDeleted,
              statusCode: 403,
            ),
          );
      expect(container.read(accountDeletedProvider), isTrue);

      await container.read(authCredentialsProvider.notifier).clear();

      expect(container.read(accountDeletedProvider), isFalse);

      await container
          .read(authCredentialsProvider.notifier)
          .save(_credentials('owner-b'));
      expect(container.read(accountDeletedProvider), isFalse);
    },
  );
}
