import 'dart:async';

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../attachments/data/file_cache.dart';
import '../../attachments/data/file_store.dart';
import '../../chat/ui/chat_providers.dart';
import '../../memory/data/memory_store.dart';
import '../../plugins/data/managed_chat_providers.dart';
import '../../plugins/data/managed_conversation_repository.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../voice/ui/voice_controller_provider.dart';
import 'auth_credentials_store.dart';

class AccountLifecycleCancelled implements Exception {
  const AccountLifecycleCancelled();

  @override
  String toString() => 'Account operation is no longer current.';
}

class AttachmentDownloadCancelled implements Exception {
  const AttachmentDownloadCancelled();

  @override
  String toString() => 'Attachment download is no longer current.';
}

class _AttachmentDownloadScope {
  int epoch = 0;
  bool tombstoned = false;
  final Set<_AttachmentDownloadEntry> active = {};
}

class _AttachmentDownloadEntry {
  _AttachmentDownloadEntry({
    required this.scopeKey,
    required this.epoch,
    required this.checkExternal,
  });

  final String scopeKey;
  final int epoch;
  final void Function()? checkExternal;
  final CancelToken cancelToken = CancelToken();
  final Completer<void> completed = Completer<void>();
  bool isComplete = false;
}

class AttachmentDownloadCoordinator {
  final Map<String, _AttachmentDownloadScope> _scopes = {};
  int _nextEpoch = 0;

  AttachmentDownloadRegistration register(
    String scopeKey, {
    void Function()? checkExternal,
  }) {
    final scope = _stateFor(scopeKey);
    if (scope.tombstoned) throw const AttachmentDownloadCancelled();
    final entry = _AttachmentDownloadEntry(
      scopeKey: scopeKey,
      epoch: scope.epoch,
      checkExternal: checkExternal,
    );
    scope.active.add(entry);
    return AttachmentDownloadRegistration._(this, entry);
  }

  void invalidateAll() {
    for (final scope in _scopes.values) {
      scope.epoch = ++_nextEpoch;
      for (final entry in scope.active) {
        entry.cancelToken.cancel();
      }
    }
  }

  Future<void> cancelAndDrain(String scopeKey) {
    final scope = _stateFor(scopeKey);
    scope.tombstoned = true;
    scope.epoch = ++_nextEpoch;
    for (final entry in scope.active) {
      entry.cancelToken.cancel();
    }
    return _drainScope(scope);
  }

  Future<void> drainAll() async {
    while (true) {
      final entries = [for (final scope in _scopes.values) ...scope.active];
      if (entries.isEmpty) return;
      await Future.wait([for (final entry in entries) entry.completed.future]);
    }
  }

  void activateScope(String scopeKey) {
    final scope = _stateFor(scopeKey);
    scope.tombstoned = false;
    scope.epoch = ++_nextEpoch;
  }

  int epochFor(String scopeKey) => _stateFor(scopeKey).epoch;

  bool isCurrent(String scopeKey, int epoch) {
    final scope = _scopes[scopeKey];
    return scope != null && !scope.tombstoned && scope.epoch == epoch;
  }

  void _check(_AttachmentDownloadEntry entry) {
    final scope = _scopes[entry.scopeKey];
    if (entry.isComplete ||
        entry.cancelToken.isCancelled ||
        scope == null ||
        scope.tombstoned ||
        scope.epoch != entry.epoch) {
      throw const AttachmentDownloadCancelled();
    }
    entry.checkExternal?.call();
  }

  void _complete(_AttachmentDownloadEntry entry) {
    if (entry.isComplete) return;
    entry.isComplete = true;
    _scopes[entry.scopeKey]?.active.remove(entry);
    if (!entry.completed.isCompleted) entry.completed.complete();
  }

  _AttachmentDownloadScope _stateFor(String scopeKey) {
    if (scopeKey.isEmpty) throw ArgumentError.value(scopeKey, 'scopeKey');
    return _scopes.putIfAbsent(scopeKey, _AttachmentDownloadScope.new);
  }

  Future<void> _drainScope(_AttachmentDownloadScope scope) async {
    while (scope.active.isNotEmpty) {
      final entries = scope.active.toList();
      await Future.wait([for (final entry in entries) entry.completed.future]);
    }
  }
}

class AttachmentDownloadRegistration {
  AttachmentDownloadRegistration._(this._coordinator, this._entry);

  final AttachmentDownloadCoordinator _coordinator;
  final _AttachmentDownloadEntry _entry;

  String get scopeKey => _entry.scopeKey;
  int get epoch => _entry.epoch;
  CancelToken get cancelToken => _entry.cancelToken;

  void checkCurrent() => _coordinator._check(_entry);

  Future<T> run<T>(Future<T> Function() operation) async {
    try {
      checkCurrent();
      final result = await operation();
      checkCurrent();
      return result;
    } finally {
      complete();
    }
  }

  void complete() => _coordinator._complete(_entry);
}

/// Thrown by [wipeLocalAccountData] when local data could not be fully
/// removed even though [wipeLocalAccountData]'s credential clear was
/// attempted (or itself failed). The server-side account is already gone by
/// the time the wipe runs — the caller reports the partial state rather than
/// pretending the wipe fully succeeded.
class PartialAccountWipe implements Exception {
  const PartialAccountWipe([this.cause]);

  final Object? cause;

  @override
  String toString() =>
      'PartialAccountWipe: local account data not fully cleared';
}

/// M12 account-deletion local wipe — the one cleanup path after the server
/// confirmed `POST /api/auth/delete-user`.
///
/// Order: drain and tombstone attachment downloads, then account data (file
/// rows, memories, file cache), then [clearCredentials] — normally
/// `authCredentialsProvider.notifier.clear()`, which runs the shared sign-out
/// ceremony (AccountLifecycle `cancelPending` + `clearLocal`: scoped plugin
/// credentials, conversations + pending turns, the credential store). A
/// data-wipe failure never skips the credential clear (fail-closed: the
/// server-side account is already deleted); a failed clear or a failed data
/// wipe surfaces as [PartialAccountWipe].
///
/// Sign-out keeps scoped files, memories, and cache bytes. Account deletion
/// removes only [scope]'s rows and cache directory.
Future<void> wipeLocalAccountData({
  required AuthAccountScope scope,
  required AccountLifecycle lifecycle,
  required Future<void> Function() clearCredentials,
  required FileStore fileStore,
  required MemoryStore memoryStore,
  required FileCache fileCache,
}) async {
  Object? dataError;
  try {
    await lifecycle.cancelAndDrain(scope.storageId);
  } catch (e) {
    dataError = e;
  }
  if (dataError == null) {
    try {
      await fileStore.deleteAllForScope(scope.storageId);
    } catch (e) {
      dataError = e;
    }
    try {
      await memoryStore.deleteAllMemoriesForScope(scope.storageId);
    } catch (e) {
      dataError ??= e;
    }
    try {
      await fileCache.evictAllForScope(scope.storageId);
    } catch (e) {
      dataError ??= e;
    }
  }
  try {
    await clearCredentials();
  } catch (e) {
    throw PartialAccountWipe(e);
  }
  if (dataError != null) throw PartialAccountWipe(dataError);
}

class AccountCleanupRegistration {
  const AccountCleanupRegistration({
    required this.cancelPending,
    required this.clearLocal,
  });

  final FutureOr<void> Function() cancelPending;
  final Future<void> Function(AuthAccountScope scope) clearLocal;
}

final accountLifecycleProvider = Provider<AccountLifecycle>((ref) {
  final lifecycle = AccountLifecycle(
    resetActiveConversation: () => ref.invalidate(activeConversationIdProvider),
  );
  lifecycle.register(
    AccountCleanupRegistration(
      cancelPending: () async {
        ref.read(pluginCredentialsEpochProvider.notifier).invalidate();
        Future<void>? voiceWrites;
        if (ref.exists(voiceControllerProvider)) {
          voiceWrites = ref
              .read(voiceControllerProvider.notifier)
              .flushPersistence();
          ref.invalidate(voiceControllerProvider);
        }
        ref.invalidate(conversationProvider);
        ref.invalidate(conversationsProvider);
        await voiceWrites;
      },
      clearLocal: (scope) =>
          ref.read(pluginCredentialsStoreProvider).clearScope(scope),
    ),
  );
  // Managed conversations live in the shared Drift DB and are account-scoped.
  // This registration is owned by the persistent lifecycle (NOT by any staged
  // adapter instance, which may not be alive at logout), so a sign-out can
  // always drop the scope's conversations and pending turns. Writers are
  // cancelled before deletion so a concurrent send can never land a late
  // write; the remote thread is never touched. Legacy unscoped rows
  // (scopeKey null) are NOT retained: chatStoreProvider's one-shot cleanup
  // (`nullScopeCleanupProvider`) deletes them the first time the account
  // scope becomes ready — plan decision: delete, don't backfill null-scope
  // legacy rows. This hook itself only ever deletes this scope's rows.
  lifecycle.register(
    AccountCleanupRegistration(
      cancelPending: () async {},
      clearLocal: (scope) async {
        try {
          final adapter = ref.read(managedChatAdapterProvider);
          if (adapter.scope == scope) {
            adapter.poller.invalidateScope();
          }
        } catch (_) {}
      },
    ),
  );
  lifecycle.register(
    AccountCleanupRegistration(
      cancelPending: () async {},
      clearLocal: (scope) async {
        final repo = ref.read(managedConversationRepositoryProvider);
        repo.cancelScope(scope);
        await repo.clearScope(scope);
      },
    ),
  );
  ref.onDispose(lifecycle.dispose);
  return lifecycle;
});

class AccountLifecycle {
  AccountLifecycle({this.resetActiveConversation});

  final void Function()? resetActiveConversation;
  final Set<AccountCleanupRegistration> _registrations = {};
  final AttachmentDownloadCoordinator _downloads =
      AttachmentDownloadCoordinator();
  int _epoch = 0;
  bool _blocked = false;

  int get epoch => _epoch;
  bool get blocked => _blocked;
  AttachmentDownloadCoordinator get downloadCoordinator => _downloads;

  void Function() register(AccountCleanupRegistration registration) {
    _registrations.add(registration);
    return () => _registrations.remove(registration);
  }

  void checkCurrent(int epoch) {
    if (_blocked || epoch != _epoch) {
      throw const AccountLifecycleCancelled();
    }
  }

  int begin() {
    _blocked = true;
    final epoch = ++_epoch;
    _downloads.invalidateAll();
    return epoch;
  }

  void complete(int epoch) {
    if (epoch == _epoch) _blocked = false;
  }

  AttachmentDownloadRegistration registerAttachmentDownload(String scopeKey) {
    final epoch = _epoch;
    checkCurrent(epoch);
    return _downloads.register(
      scopeKey,
      checkExternal: () => checkCurrent(epoch),
    );
  }

  Future<T> runAttachmentDownload<T>(
    String scopeKey,
    Future<T> Function(AttachmentDownloadRegistration registration) operation,
  ) {
    final registration = registerAttachmentDownload(scopeKey);
    return registration.run(() => operation(registration));
  }

  int captureAttachmentScopeEpoch(String scopeKey) =>
      _downloads.epochFor(scopeKey);

  void checkAttachmentScopeCurrent(String scopeKey, int epoch) {
    if (!_downloads.isCurrent(scopeKey, epoch)) {
      throw const AttachmentDownloadCancelled();
    }
  }

  Future<void> cancelAndDrain(String scopeKey) =>
      _downloads.cancelAndDrain(scopeKey);

  void activateScope(String scopeKey) => _downloads.activateScope(scopeKey);

  Future<void> cancelPending() async {
    _downloads.invalidateAll();
    Object? cancellationError;
    StackTrace? cancellationStack;
    try {
      await Future.wait([
        for (final registration in _registrations.toList())
          Future.sync(registration.cancelPending),
      ]);
    } catch (error, stack) {
      cancellationError = error;
      cancellationStack = stack;
    }
    try {
      await _downloads.drainAll();
    } catch (error, stack) {
      cancellationError ??= error;
      cancellationStack ??= stack;
    }
    if (cancellationError != null) {
      Error.throwWithStackTrace(
        cancellationError,
        cancellationStack ?? StackTrace.current,
      );
    }
  }

  Future<void> clearLocal(AuthAccountScope scope) async {
    for (final registration in _registrations.toList()) {
      await registration.clearLocal(scope);
    }
  }

  void dispose() {
    begin();
    _registrations.clear();
  }
}
