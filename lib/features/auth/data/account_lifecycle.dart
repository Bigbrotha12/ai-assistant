import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../chat/ui/chat_providers.dart';
import '../../plugins/data/managed_conversation_repository.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../voice/ui/voice_controller_provider.dart';
import 'auth_credentials_store.dart';

class AccountLifecycleCancelled implements Exception {
  const AccountLifecycleCancelled();

  @override
  String toString() => 'Account operation is no longer current.';
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
  int _epoch = 0;
  bool _blocked = false;

  int get epoch => _epoch;
  bool get blocked => _blocked;

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
    return ++_epoch;
  }

  void complete(int epoch) {
    if (epoch == _epoch) _blocked = false;
  }

  Future<void> cancelPending() async {
    await Future.wait([
      for (final registration in _registrations.toList())
        Future.sync(registration.cancelPending),
    ]);
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
