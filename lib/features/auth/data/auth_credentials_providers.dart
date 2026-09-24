import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'account_lifecycle.dart';
import 'auth_client.dart';
import 'auth_client_provider.dart';
import 'auth_credentials_store.dart';

/// When a stored API key is considered stale and eligible for the startup
/// rotation pass (M12): `mintedAt` older than this → mint + persist + revoke.
const Duration _rotationAge = Duration(days: 60);

/// Server-side API-key lifetime (`defaultExpiresIn`, applies at create only).
const Duration _keyLifetime = Duration(days: 90);

/// How far before expiry the settings screen surfaces the re-auth nudge.
const Duration _expiryWarnWindow = Duration(days: 7);

class ApiKeyMatchResult {
  const ApiKeyMatchResult({this.entry, this.ambiguous = false});

  final ApiKeyListEntry? entry;
  final bool ambiguous;

  bool get matched => entry != null;
}

ApiKeyMatchResult matchStoredApiKey(
  AuthCredentials credentials,
  List<ApiKeyListEntry> keys,
) {
  final now = DateTime.now();
  bool isActive(ApiKeyListEntry key) {
    if (key.enabled == false) return false;
    final expiresAt = key.expiresAt;
    return expiresAt == null || !expiresAt.isBefore(now);
  }

  final keyId = credentials.keyId;
  if (keyId != null && keyId.isNotEmpty) {
    final idMatches = keys.where((key) => key.id == keyId).toList();
    if (idMatches.length == 1) {
      return ApiKeyMatchResult(entry: idMatches.single);
    }
    if (idMatches.length > 1) {
      return const ApiKeyMatchResult(ambiguous: true);
    }
    final prefixMatches = keys
        .where(
          (key) =>
              isActive(key) &&
              (key.start?.isNotEmpty ?? false) &&
              credentials.apiKey.startsWith(key.start!),
        )
        .toList();
    if (prefixMatches.length == 1) {
      return ApiKeyMatchResult(entry: prefixMatches.single);
    }
    if (prefixMatches.length > 1) {
      return const ApiKeyMatchResult(ambiguous: true);
    }
    if (keys.where(isActive).length > 1) {
      return const ApiKeyMatchResult(ambiguous: true);
    }
    return const ApiKeyMatchResult();
  }

  final prefixMatches = keys
      .where(
        (key) =>
            isActive(key) &&
            (key.start?.isNotEmpty ?? false) &&
            credentials.apiKey.startsWith(key.start!),
      )
      .toList();
  if (prefixMatches.length == 1) {
    return ApiKeyMatchResult(entry: prefixMatches.single);
  }
  if (prefixMatches.length > 1) {
    return const ApiKeyMatchResult(ambiguous: true);
  }

  final activeKeys = keys.where(isActive).toList();
  if (activeKeys.length == 1) {
    return ApiKeyMatchResult(entry: activeKeys.single);
  }
  if (activeKeys.length > 1) {
    return const ApiKeyMatchResult(ambiguous: true);
  }
  return const ApiKeyMatchResult();
}

final authCredentialsStoreProvider = Provider<AuthCredentialsStore>(
  (ref) => SecureAuthCredentialsStore(),
);

/// Validity of the stored better-auth session as last observed by the
/// startup `get-session` ping (H2). The C3 API-key-rotation gate reads this
/// via [sessionStatusProvider] and must only rotate on
/// [SessionStatus.valid] — [SessionStatus.unknown] never authorizes a
/// rotation.
///
/// Lifecycle: starts [unknown]; a successful ping → [valid]; an
/// absent/expired session (null from `getSession`) → [invalid]; a ping that
/// fails at the transport level leaves it [unknown] (best-effort keep-alive:
/// a network failure is not evidence about the session). Any credentials
/// transition (sign-out, account switch, key save) resets it to [unknown]
/// until the next app-start ping observes the session again; a ping result
/// that races a `clear()`/sign-out is discarded via the lifecycle epoch and
/// never applied.
enum SessionStatus {
  /// Not yet observed this app session: initial state, no session token
  /// (tokenless sign-up), or the last ping failed before a verdict.
  unknown,

  /// The server confirmed the session is live (`get-session` returned one).
  valid,

  /// The server reported no session for the stored token (absent/expired).
  invalid,
}

/// Read-only surface over [SessionStatus] for the C3 rotation gate: watch
/// or read it after [authCredentialsProvider] has completed its startup
/// build to learn whether the session ping has established validity.
final sessionStatusProvider =
    NotifierProvider<SessionStatusNotifier, SessionStatus>(
      SessionStatusNotifier.new,
    );

class SessionStatusNotifier extends Notifier<SessionStatus> {
  @override
  SessionStatus build() => SessionStatus.unknown;

  /// Records a session observation. Called by the credentials notifier's
  /// epoch-guarded startup ping (a discarded ping never reaches this) and by
  /// its transitions (reset to [SessionStatus.unknown]).
  void update(SessionStatus value) => state = value;
}

/// Read-only expiry nudge for the settings screen (M12): true only while the
/// sliding session is known [SessionStatus.invalid] AND the stored key is
/// within [_expiryWarnWindow] of its end-of-life (server `expiresAt` when
/// known, else `mintedAt + _keyLifetime`). Never true while the session is
/// valid — the startup rotation pass owns that case.
final keyExpiryWarningProvider = Provider<bool>((ref) {
  final status = ref.watch(sessionStatusProvider);
  if (status != SessionStatus.invalid) return false;
  final mintedAt = ref.watch(
    authCredentialsProvider.select((value) => value.value?.mintedAt),
  );
  if (mintedAt == null) return false;
  final now = DateTime.now();
  final expiry = mintedAt.add(_keyLifetime);
  return !now.isAfter(expiry) &&
      !now.isBefore(expiry.subtract(_expiryWarnWindow));
});

final authCredentialsProvider =
    AsyncNotifierProvider<AuthCredentialsNotifier, AuthCredentials?>(
      AuthCredentialsNotifier.new,
    );

class AuthCredentialsNotifier extends AsyncNotifier<AuthCredentials?> {
  Future<void> _pending = Future.value();
  Future<AuthCredentials?>? _loaded;
  AuthCredentials? _persisted;
  final Set<AuthAccountScope> _cleanupScopes = {};

  /// Re-entrancy latch for the H2 startup session ping: non-null once a ping
  /// has started for this notifier and never cleared, so it guards both the
  /// in-flight window AND completed state — a `build()` re-run from
  /// `ref.invalidate` can neither stack a second `get-session` request nor
  /// repeat one that already finished. Lifecycle (sign-out) is handled
  /// separately by the epoch check in [_pingSession].
  Future<void>? _sessionPing;

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
    // H2 client half: best-effort sliding-window keep-alive. Fire-and-forget
    // (never awaited, never fails this build) — see [_startSessionPing].
    _startSessionPing(credentials, lifecycle);
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

  /// Starts the one-shot `get-session` ping (H2) chained with the C3 startup
  /// API-key pass. No-op when there is no session token — C1's tokenless
  /// sign-up stores no session (`null` or the empty-string sentinel),
  /// unverified accounts have nothing to refresh — or when the
  /// [_sessionPing] latch already holds a started ping. Both legs share the
  /// latch so a `build()` re-run can neither stack nor repeat either.
  void _startSessionPing(
    AuthCredentials? credentials,
    AccountLifecycle lifecycle,
  ) {
    final current = credentials;
    final token = current?.sessionToken;
    if (token == null || token.isEmpty) return;
    if (_sessionPing != null) return;
    final dispatchEpoch = lifecycle.epoch;
    final client = ref.read(authClientProvider);
    final expectedOrigin = normalizeBackendOrigin(
      ref.read(authBackendOriginProvider),
    );
    final expectedScope = current?.accountScope;
    final expectedOwner = _credentialOwner(current);
    _sessionPing =
        _pingSession(
              token,
              lifecycle,
              client: client,
              expectedEpoch: dispatchEpoch,
              expectedScope: expectedScope,
              expectedOrigin: expectedOrigin,
              expectedOwner: expectedOwner,
            )
            .then(
              (_) => _runStartupKeyPass(
                current,
                token,
                lifecycle,
                client: client,
                expectedEpoch: dispatchEpoch,
                expectedScope: expectedScope,
                expectedOrigin: expectedOrigin,
              ),
            )
            .catchError((Object _) {});
  }

  /// C3 startup API-key pass (M12), chained after the H2 ping inside the
  /// same [_sessionPing] latch. Reads the just-published [SessionStatus]:
  ///
  ///  - [SessionStatus.valid] → backfill `mintedAt` from `listApiKeys` when
  ///    missing (legacy installs), then when the key is older than
  ///    [_rotationAge]: mint → persist (`mintedAt = now`) → revoke the old
  ///    key plus any other stale active keys (sweep).
  ///  - [SessionStatus.invalid] / [SessionStatus.unknown] → no-op; the key
  ///    is kept untouched.
  ///
  /// [start] is the credentials snapshot from the startup build (captured
  /// before any await so the pass never re-enters [authCredentialsProvider]
  /// while its own build chain is still settling).
  ///
  /// Any [AuthApiError] (including `AuthEmailNotVerified` / `AuthRateLimited`)
  /// or transport failure aborts silently: the stored key is never cleared,
  /// nothing is thrown, and lifecycle state is left alone. Every await is
  /// followed by an epoch/scope/mounted guard so a mid-pass sign-out or
  /// account switch discards the remainder instead of writing a stale key.
  Future<void> _runStartupKeyPass(
    AuthCredentials? start,
    String sessionToken,
    AccountLifecycle lifecycle, {
    required AuthClient client,
    required int expectedEpoch,
    required AuthAccountScope? expectedScope,
    required String? expectedOrigin,
  }) async {
    try {
      if (!_isCurrentStartupDispatch(
        lifecycle,
        expectedEpoch: expectedEpoch,
        expectedScope: expectedScope,
        expectedOrigin: expectedOrigin,
      )) {
        return;
      }
      final status = ref.read(sessionStatusProvider);
      if (status != SessionStatus.valid) return;
      final current = start;
      if (current == null || current.apiKey.isEmpty) return;

      var credentials = current;
      List<ApiKeyListEntry>? keys;

      if (credentials.mintedAt == null) {
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
        keys = await client.listApiKeys(sessionToken: sessionToken);
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
        final match = matchStoredApiKey(credentials, keys);
        if (match.ambiguous) {
          debugPrint('AuthCredentials: legacy API key match is ambiguous.');
          return;
        }
        final entry = match.entry;
        final hasStoredKeyId = credentials.keyId?.trim().isNotEmpty ?? false;
        if (entry != null && (!hasStoredKeyId || entry.createdAt != null)) {
          final backfilled = await _persistStartupUpdate(
            credentials.copyWith(keyId: entry.id, mintedAt: entry.createdAt),
            expectedEpoch,
            expectedScope,
            expectedOrigin,
          );
          if (backfilled == null) return;
          credentials = backfilled;
        }
        if (credentials.mintedAt == null) return;
      }

      final age = DateTime.now().difference(credentials.mintedAt!);
      if (age <= _rotationAge) return;

      if (keys == null) {
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
        keys = await client.listApiKeys(sessionToken: sessionToken);
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
      }
      if (!_isCurrentStartupDispatch(
        lifecycle,
        expectedEpoch: expectedEpoch,
        expectedScope: expectedScope,
        expectedOrigin: expectedOrigin,
      )) {
        return;
      }
      final minted = await client.mintApiKey(sessionToken: sessionToken);
      if (!_isCurrentStartupDispatch(
        lifecycle,
        expectedEpoch: expectedEpoch,
        expectedScope: expectedScope,
        expectedOrigin: expectedOrigin,
      )) {
        return;
      }

      final rotated = await _persistStartupUpdate(
        credentials.copyWith(
          apiKey: minted.key,
          keyId: minted.id,
          mintedAt: DateTime.now(),
        ),
        expectedEpoch,
        expectedScope,
        expectedOrigin,
      );
      if (rotated == null) return;

      final now = DateTime.now();
      final toRevoke = <String>{
        if (credentials.keyId != null) credentials.keyId!,
        for (final key in keys)
          if (key.id != minted.id &&
              (key.enabled ?? true) &&
              (key.createdAt == null ||
                  now.difference(key.createdAt!) > _rotationAge))
            key.id,
      };
      for (final keyId in toRevoke) {
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
        await client.revokeApiKey(sessionToken: sessionToken, keyId: keyId);
        if (!_isCurrentStartupDispatch(
          lifecycle,
          expectedEpoch: expectedEpoch,
          expectedScope: expectedScope,
          expectedOrigin: expectedOrigin,
        )) {
          return;
        }
      }
    } catch (_) {}
  }

  bool _isCurrentStartupDispatch(
    AccountLifecycle lifecycle, {
    required int expectedEpoch,
    required AuthAccountScope? expectedScope,
    required String? expectedOrigin,
  }) {
    if (!ref.mounted || lifecycle.epoch != expectedEpoch || lifecycle.blocked) {
      return false;
    }
    if (_persisted?.accountScope != expectedScope) return false;
    return normalizeBackendOrigin(ref.read(authBackendOriginProvider)) ==
        expectedOrigin;
  }

  String? _credentialOwner(AuthCredentials? credentials) {
    final owner = credentials?.ownerId?.trim();
    if (owner != null && owner.isNotEmpty) return owner;
    final scopeOwner = credentials?.accountScope?.ownerId.trim();
    if (scopeOwner != null && scopeOwner.isNotEmpty) return scopeOwner;
    return null;
  }

  Future<AuthCredentials?> _persistStartupUpdate(
    AuthCredentials next,
    int expectedEpoch,
    AuthAccountScope? expectedScope,
    String? expectedOrigin,
  ) {
    final result = _pending.then<AuthCredentials?>((_) async {
      final lifecycle = ref.read(accountLifecycleProvider);
      if (lifecycle.epoch != expectedEpoch || lifecycle.blocked) return null;
      if (_persisted?.accountScope != expectedScope) return null;
      final scope = next.accountScope;
      if (scope != expectedScope) return null;
      if (normalizeBackendOrigin(ref.read(authBackendOriginProvider)) !=
          expectedOrigin) {
        return null;
      }
      await ref.read(authCredentialsStoreProvider).save(next);
      _persisted = next;
      if (lifecycle.epoch != expectedEpoch || lifecycle.blocked) return null;
      if (normalizeBackendOrigin(ref.read(authBackendOriginProvider)) !=
          expectedOrigin) {
        return null;
      }
      if (!ref.mounted) return null;
      state = AsyncData(next);
      return next;
    });
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> _pingSession(
    String sessionToken,
    AccountLifecycle lifecycle, {
    required AuthClient client,
    required int expectedEpoch,
    required AuthAccountScope? expectedScope,
    required String? expectedOrigin,
    required String? expectedOwner,
  }) async {
    try {
      if (!_isCurrentStartupDispatch(
        lifecycle,
        expectedEpoch: expectedEpoch,
        expectedScope: expectedScope,
        expectedOrigin: expectedOrigin,
      )) {
        return;
      }
      final session = await client.getSession(sessionToken: sessionToken);
      if (!_isCurrentStartupDispatch(
        lifecycle,
        expectedEpoch: expectedEpoch,
        expectedScope: expectedScope,
        expectedOrigin: expectedOrigin,
      )) {
        return;
      }
      final status = session == null
          ? SessionStatus.invalid
          : expectedOwner != null && session.userId != expectedOwner
          ? SessionStatus.invalid
          : SessionStatus.valid;
      ref.read(sessionStatusProvider.notifier).update(status);
    } catch (_) {}
  }

  Future<void> _transition(AuthCredentials? next) {
    final lifecycle = ref.read(accountLifecycleProvider);
    final epoch = lifecycle.begin();
    state = const AsyncData(null);
    // The previous session observation (if any) belongs to the credentials
    // being replaced — reset so a later reader never sees a stale verdict
    // for a signed-out or switched account.
    ref.read(sessionStatusProvider.notifier).update(SessionStatus.unknown);
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
          final nextScope = next?.accountScope;
          if (nextScope != null) {
            lifecycle.activateScope(nextScope.storageId);
          }
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
