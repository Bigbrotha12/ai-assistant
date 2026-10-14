import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../attachments/data/file_cache.dart';
import '../../attachments/data/file_store.dart';
import '../../attachments/data/files_providers.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/data/database_providers.dart';
import '../../memory/data/memory_store.dart';
import 'account_deleted_state.dart';
import 'account_lifecycle.dart';
import 'auth_credentials_providers.dart';
import 'auth_credentials_store.dart';

final accountDeletedHandlerProvider = Provider<AccountDeletedHandler>(
  (ref) => AccountDeletedHandler(ref),
);

class _TerminalWipeSnapshot {
  const _TerminalWipeSnapshot({
    required this.credentials,
    required this.lifecycleEpoch,
  });

  final AuthCredentials? credentials;
  final int lifecycleEpoch;
}

class AccountDeletedHandler {
  const AccountDeletedHandler(this.ref);

  final Ref ref;

  Future<void> handle(Object? error) {
    if (!isAccountDeletedError(error)) return Future<void>.value();
    final lifecycle = ref.read(accountLifecycleProvider);
    final snapshot = _TerminalWipeSnapshot(
      credentials: ref.read(authCredentialsProvider).value,
      lifecycleEpoch: lifecycle.epoch,
    );
    return ref
        .read(accountDeletedProvider.notifier)
        .runOnceFor((run) => _wipeLocalAccount(run, snapshot));
  }

  Future<void> _wipeLocalAccount(
    AccountDeletedRun run,
    _TerminalWipeSnapshot snapshot,
  ) async {
    if (!_isCurrent(run, snapshot)) return;
    final notifier = ref.read(accountDeletedProvider.notifier);
    final lifecycle = ref.read(accountLifecycleProvider);
    var credentials = snapshot.credentials;
    if (credentials == null) {
      credentials = await _storedCredentials();
      if (!_isCurrent(run, snapshot)) return;
    }

    final scope = credentials?.accountScope;
    if (scope == null) {
      Future<void> retry() => _clearCredentials(run, snapshot, credentials);
      notifier.registerRetry(run, retry);
      await _runWithPartial(run, retry);
      return;
    }

    late final FileStore fileStore;
    late final MemoryStore memoryStore;
    late final FileCache fileCache;
    try {
      fileStore = ref.read(filesStoreProvider);
      memoryStore = ref.read(memoryStoreProvider);
      fileCache = ref.read(fileCacheProvider);
    } catch (error, stack) {
      Future<void> retry() => _wipeLocalAccount(run, snapshot);
      notifier.registerRetry(run, retry);
      try {
        await _clearCredentials(run, snapshot, credentials);
      } catch (clearError, clearStack) {
        final partial = PartialAccountWipe(clearError);
        notifier.markPartialCleanup(run, partial);
        Error.throwWithStackTrace(partial, clearStack);
      }
      final partial = PartialAccountWipe(error);
      notifier.markPartialCleanup(run, partial);
      Error.throwWithStackTrace(partial, stack);
    }

    var credentialsCleared = false;
    Future<void> clearCredentials() async {
      if (credentialsCleared || !_isCurrent(run, snapshot)) return;
      await _clearCredentials(run, snapshot, credentials);
      credentialsCleared = true;
    }

    Future<void> retry() => wipeLocalAccountData(
      scope: scope,
      lifecycle: lifecycle,
      clearCredentials: clearCredentials,
      fileStore: fileStore,
      memoryStore: memoryStore,
      fileCache: fileCache,
    );
    notifier.registerRetry(run, retry);
    await _runWithPartial(run, retry);
  }

  Future<void> _runWithPartial(
    AccountDeletedRun run,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (error, stack) {
      final partial = error is PartialAccountWipe
          ? error
          : PartialAccountWipe(error);
      ref
          .read(accountDeletedProvider.notifier)
          .markPartialCleanup(run, partial);
      Error.throwWithStackTrace(partial, stack);
    }
  }

  bool _isCurrent(AccountDeletedRun run, _TerminalWipeSnapshot snapshot) {
    final lifecycle = ref.read(accountLifecycleProvider);
    return run.isCurrent && lifecycle.epoch == snapshot.lifecycleEpoch;
  }

  Future<AuthCredentials?> _storedCredentials() async {
    final current = ref.read(authCredentialsProvider).value;
    if (current != null) return current;
    try {
      return await ref.read(authCredentialsStoreProvider).load();
    } catch (_) {
      return null;
    }
  }

  Future<void> _clearCredentials(
    AccountDeletedRun run,
    _TerminalWipeSnapshot snapshot,
    AuthCredentials? expectedCredentials,
  ) async {
    if (!_isCurrent(run, snapshot)) return;
    await ref
        .read(authCredentialsProvider.notifier)
        .clearForTerminalWipe(
          expectedCredentials: expectedCredentials,
          expectedEpoch: snapshot.lifecycleEpoch,
        );
  }
}
