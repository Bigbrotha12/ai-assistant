import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'account_lifecycle.dart';
import 'auth_client_provider.dart';
import 'auth_credentials_store.dart';

final authCredentialsStoreProvider = Provider<AuthCredentialsStore>(
  (ref) => SecureAuthCredentialsStore(),
);

final authCredentialsProvider =
    AsyncNotifierProvider<AuthCredentialsNotifier, AuthCredentials?>(
      AuthCredentialsNotifier.new,
    );

class AuthCredentialsNotifier extends AsyncNotifier<AuthCredentials?> {
  Future<void> _pending = Future.value();
  Future<AuthCredentials?>? _loaded;
  AuthCredentials? _persisted;
  final Set<AuthAccountScope> _cleanupScopes = {};

  @override
  Future<AuthCredentials?> build() async {
    final lifecycle = ref.read(accountLifecycleProvider);
    ref.listen(authBackendOriginProvider, (previous, next) {
      final scope = _persisted?.accountScope;
      if (previous != null &&
          previous != next &&
          scope != null &&
          scope.backendOrigin != normalizeBackendOrigin(next)) {
        unawaited(clear().catchError((Object _) {}));
      }
    });
    _loaded ??= (() async {
      try {
        final value = await ref.read(authCredentialsStoreProvider).load();
        _persisted = value;
        return value;
      } catch (error, stack) {
        // A failed read is transient storage unavailability, not a fact about
        // the account. Never memoize it: `_loaded` is cleared so a later
        // build (e.g. the gate's Retry) re-reads the store instead of
        // replaying the same error forever.
        _loaded = null;
        Error.throwWithStackTrace(error, stack);
      }
    })();
    final credentials = await _loaded;
    if (lifecycle.epoch != 0 || lifecycle.blocked) return null;
    final scope = credentials?.accountScope;
    if (scope != null &&
        scope.backendOrigin !=
            normalizeBackendOrigin(ref.read(authBackendOriginProvider))) {
      return null;
    }
    return credentials;
  }

  bool get hasCredentials =>
      !state.hasError &&
      !state.isLoading &&
      (state.value?.apiKey.isNotEmpty ?? false);

  int captureEpoch() => ref.read(accountLifecycleProvider).epoch;

  Future<void> save(AuthCredentials credentials, {int? expectedEpoch}) {
    final lifecycle = ref.read(accountLifecycleProvider);
    if (expectedEpoch != null) {
      try {
        lifecycle.checkCurrent(expectedEpoch);
      } catch (error, stack) {
        return Future.error(error, stack);
      }
    }
    final scope = credentials.accountScope;
    if (scope != null &&
        scope.backendOrigin !=
            normalizeBackendOrigin(ref.read(authBackendOriginProvider))) {
      return Future.error(const AccountLifecycleCancelled());
    }
    return _transition(credentials);
  }

  Future<void> clear() => _transition(null);

  Future<void> _transition(AuthCredentials? next) {
    final lifecycle = ref.read(accountLifecycleProvider);
    final epoch = lifecycle.begin();
    state = const AsyncData(null);
    if (next == null ||
        (_persisted != null && _persisted?.accountScope != next.accountScope)) {
      lifecycle.resetActiveConversation?.call();
    }
    final cancellation = lifecycle.cancelPending();
    final cancellationResult = cancellation.then<Object?>(
      (_) => null,
      onError: (Object error, StackTrace _) => error,
    );
    final result = _pending.then((_) async {
      try {
        await _loaded;
        final cancellationError = await cancellationResult;
        if (cancellationError != null) throw cancellationError;
        final previousScope = _persisted?.accountScope;
        if (previousScope != null &&
            (next == null || previousScope != next.accountScope)) {
          _cleanupScopes.add(previousScope);
        }
        for (final scope in _cleanupScopes.toList()) {
          await lifecycle.clearLocal(scope);
          _cleanupScopes.remove(scope);
        }
        final store = ref.read(authCredentialsStoreProvider);
        if (next == null) {
          await store.clear();
          _persisted = null;
        } else {
          if (epoch != lifecycle.epoch) {
            throw const AccountLifecycleCancelled();
          }
          final scope = next.accountScope;
          if (scope != null &&
              scope.backendOrigin !=
                  normalizeBackendOrigin(ref.read(authBackendOriginProvider))) {
            throw const AccountLifecycleCancelled();
          }
          await store.save(next);
          _persisted = next;
          if (epoch != lifecycle.epoch) {
            throw const AccountLifecycleCancelled();
          }
        }
        if (epoch == lifecycle.epoch) {
          lifecycle.complete(epoch);
          if (ref.mounted) {
            state = AsyncData(next);
          }
        }
      } catch (error, stack) {
        // Fail closed only while a previous-owner scope remains uncleared: a
        // failed cleanup keeps the lifecycle blocked (no new credentials can
        // publish; the scope is retried on the next transition). Failures
        // after cleanup succeeded leave nothing pending, so the lifecycle
        // unblocks and a plain retry can proceed.
        if (epoch == lifecycle.epoch && _cleanupScopes.isEmpty) {
          lifecycle.complete(epoch);
        }
        if (epoch == lifecycle.epoch && ref.mounted) {
          state = AsyncError(error, stack);
        }
        rethrow;
      }
    });
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }
}
