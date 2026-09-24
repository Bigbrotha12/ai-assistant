import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';

import '../../fakes.dart';

/// Lets the fire-and-forget get-session ping settle its verdict.
Future<void> drain() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

AuthCredentials credsWithSession({String token = 'tok-1'}) => AuthCredentials(
  apiKey: 'key-1',
  email: 'a@b.c',
  keyId: 'k1',
  sessionToken: token,
  ownerId: 'owner-1',
  backendOrigin: 'http://example.com:17600',
);

void main() {
  ProviderContainer makeContainer({
    required FakeAuthCredentialsStore store,
    required FakeAuthClient client,
  }) {
    final container = ProviderContainer(
      overrides: [
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
        authCredentialsStoreProvider.overrideWithValue(store),
        authClientProvider.overrideWithValue(client),
        authBackendOriginProvider.overrideWithValue('http://example.com:17600'),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test(
    'startup build pings get-session once and reports the session valid',
    () async {
      final store = FakeAuthCredentialsStore(stored: credsWithSession());
      final client = FakeAuthClient(
        onGetSession: (_) async =>
            const CurrentSession(userId: 'owner-1', email: 'a@b.c'),
      );
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      // The ping dispatches synchronously inside build, before it returns.
      expect(client.getSessionRequests, ['tok-1']);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.valid);
      expect(container.read(authCredentialsProvider).value, store.stored);
      expect(container.read(authCredentialsProvider).hasError, isFalse);
    },
  );

  test('a null get-session verdict reports the session invalid', () async {
    final store = FakeAuthCredentialsStore(stored: credsWithSession());
    final client = FakeAuthClient(onGetSession: (_) async => null);
    final container = makeContainer(store: store, client: client);

    await container.read(authCredentialsProvider.future);
    await drain();

    expect(container.read(sessionStatusProvider), SessionStatus.invalid);
    // Credentials survive an invalid session: C3/UI decide what to do, the
    // keep-alive ping never signs the user out itself.
    expect(container.read(authCredentialsProvider).value, store.stored);
  });

  test(
    'a get-session owner mismatch is invalid and stops key operations',
    () async {
      final store = FakeAuthCredentialsStore(stored: credsWithSession());
      final client = FakeAuthClient(
        onGetSession: (_) async =>
            const CurrentSession(userId: 'different-owner'),
        onListApiKeys: (_) async => const [],
        onMintApiKey: (_) async =>
            const MintedApiKey(key: 'new-key', id: 'new-id'),
      );
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.invalid);
      expect(client.getSessionRequests, ['tok-1']);
      expect(client.listApiKeysRequests, isEmpty);
      expect(client.mintRequests, isEmpty);
      expect(client.revokeCalls, isEmpty);
      expect(store.saveCalls, 0);
      expect(store.stored, credsWithSession());
    },
  );

  test('credentials without a session token never ping', () async {
    final withoutToken = AuthCredentials(
      apiKey: 'key-1',
      email: 'a@b.c',
      ownerId: 'owner-1',
      backendOrigin: 'http://example.com:17600',
    );
    for (final credentials in [
      withoutToken, // unverified/tokenless sign-up: no session stored
      credsWithSession(token: ''), // C1 empty-string sentinel
    ]) {
      final store = FakeAuthCredentialsStore(stored: credentials);
      final client = FakeAuthClient(
        onGetSession: (_) async => const CurrentSession(userId: 'owner-1'),
      );
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(client.getSessionRequests, isEmpty);
      expect(container.read(sessionStatusProvider), SessionStatus.unknown);
    }
  });

  test('a failed ping keeps credentials and leaves status unknown', () async {
    final store = FakeAuthCredentialsStore(stored: credsWithSession());
    final client = FakeAuthClient(
      onGetSession: (_) async => throw const AuthNetworkError('down'),
    );
    final container = makeContainer(store: store, client: client);

    await container.read(authCredentialsProvider.future);
    await drain();

    expect(container.read(authCredentialsProvider).hasError, isFalse);
    expect(container.read(authCredentialsProvider).value, store.stored);
    expect(store.stored, isNotNull);
    expect(container.read(sessionStatusProvider), SessionStatus.unknown);
  });

  test('clear() mid-ping discards the late result', () async {
    final store = FakeAuthCredentialsStore(stored: credsWithSession());
    final gate = Completer<CurrentSession?>();
    final client = FakeAuthClient(onGetSession: (_) => gate.future);
    final container = makeContainer(store: store, client: client);

    await container.read(authCredentialsProvider.future);
    expect(client.getSessionRequests, ['tok-1']);
    expect(gate.isCompleted, isFalse);

    // Sign out while the ping is still in flight.
    await container.read(authCredentialsProvider.notifier).clear();
    expect(container.read(authCredentialsProvider).value, isNull);

    // The ping now resolves as "valid" — far too late: it must not
    // resurrect status for a signed-out account.
    gate.complete(const CurrentSession(userId: 'owner-1'));
    await drain();

    expect(container.read(sessionStatusProvider), SessionStatus.unknown);
    expect(store.stored, isNull);
    expect(container.read(authCredentialsProvider).value, isNull);
  });

  test('origin switch mid-pass keeps the captured client and scope', () async {
    const oldOrigin = 'http://old.example:17600';
    const newOrigin = 'http://new.example:17600';
    var currentOrigin = oldOrigin;
    late final Provider<String> originSignal;
    late final ProviderContainer container;
    originSignal = Provider<String>((ref) => currentOrigin);
    final oldClient = FakeAuthClient(
      onGetSession: (_) async {
        currentOrigin = newOrigin;
        container.invalidate(originSignal);
        return const CurrentSession(userId: 'owner-1');
      },
      onListApiKeys: (_) async => const [],
      onMintApiKey: (_) async =>
          const MintedApiKey(key: 'new-key', id: 'new-id'),
    );
    final newClient = FakeAuthClient(
      onListApiKeys: (_) async => const [],
      onMintApiKey: (_) async =>
          const MintedApiKey(key: 'wrong-client-key', id: 'wrong-id'),
    );
    final original = const AuthCredentials(
      apiKey: 'key-1',
      sessionToken: 'tok-1',
    );
    final store = FakeAuthCredentialsStore(stored: original);
    container = ProviderContainer(
      overrides: [
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWith(
          (ref) => ref.watch(originSignal),
        ),
        authClientProvider.overrideWith((ref) {
          return ref.watch(authBackendOriginProvider) == oldOrigin
              ? oldClient
              : newClient;
        }),
      ],
    );
    addTearDown(container.dispose);

    await container.read(authCredentialsProvider.future);
    await drain();

    expect(oldClient.getSessionRequests, ['tok-1']);
    expect(oldClient.listApiKeysRequests, isEmpty);
    expect(newClient.getSessionRequests, isEmpty);
    expect(newClient.listApiKeysRequests, isEmpty);
    expect(newClient.mintRequests, isEmpty);
    expect(store.saveCalls, 0);
    expect(store.stored, original);
  });

  test(
    're-invalidating the provider neither stacks nor repeats the ping',
    () async {
      final store = FakeAuthCredentialsStore(stored: credsWithSession());
      final gate = Completer<CurrentSession?>();
      final client = FakeAuthClient(onGetSession: (_) => gate.future);
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      expect(client.getSessionRequests, ['tok-1']);

      // Rebuild while the first ping is still in flight: no second request.
      container.invalidate(authCredentialsProvider);
      await container.read(authCredentialsProvider.future);
      await drain();
      expect(client.getSessionRequests, hasLength(1));

      gate.complete(const CurrentSession(userId: 'owner-1'));
      await drain();
      expect(container.read(sessionStatusProvider), SessionStatus.valid);

      // A later rebuild after the ping completed is latched too.
      container.invalidate(authCredentialsProvider);
      await container.read(authCredentialsProvider.future);
      await drain();
      expect(client.getSessionRequests, hasLength(1));
      expect(container.read(sessionStatusProvider), SessionStatus.valid);
    },
  );

  group('startup key pass (M12)', () {
    DateTime ago(Duration age) => DateTime.now().subtract(age);

    AuthCredentials oldKey({DateTime? mintedAt}) => AuthCredentials(
      apiKey: 'sk_old_legacy_key',
      email: 'a@b.c',
      keyId: 'old-id',
      sessionToken: 'tok-1',
      ownerId: 'owner-1',
      backendOrigin: 'http://example.com:17600',
      mintedAt: mintedAt ?? ago(const Duration(days: 61)),
    );

    FakeAuthClient validClient({
      Future<List<ApiKeyListEntry>> Function(String token)? list,
      Future<MintedApiKey> Function(String token)? mint,
      Future<void> Function(String token, String keyId)? revoke,
    }) {
      return FakeAuthClient(
        onGetSession: (_) async =>
            const CurrentSession(userId: 'owner-1', email: 'a@b.c'),
        onListApiKeys:
            list ??
            (_) async => [
              ApiKeyListEntry(
                id: 'old-id',
                start: 'sk_old',
                enabled: true,
                createdAt: ago(const Duration(days: 61)),
              ),
            ],
        onMintApiKey:
            mint ??
            (_) async => const MintedApiKey(key: 'sk_new_key', id: 'new-id'),
        onRevokeApiKey: revoke ?? (String _, String _) async {},
      );
    }

    test('age >60d + valid session: list, mint, persist, revoke old and stale '
        'in order', () async {
      final log = <String>[];
      final store = FakeAuthCredentialsStore(stored: oldKey());
      final saved = _LoggingAuthStore(store, log);
      final staleCreatedAt = ago(const Duration(days: 70));
      final client = validClient(
        list: (_) async {
          log.add('list');
          return [
            ApiKeyListEntry(
              id: 'old-id',
              start: 'sk_old',
              enabled: true,
              createdAt: ago(const Duration(days: 61)),
            ),
            ApiKeyListEntry(
              id: 'stale-id',
              start: 'sk_st',
              enabled: true,
              createdAt: staleCreatedAt,
            ),
            ApiKeyListEntry(
              id: 'fresh-id',
              start: 'sk_fr',
              enabled: true,
              createdAt: ago(const Duration(days: 5)),
            ),
          ];
        },
        mint: (_) async {
          log.add('mint');
          return const MintedApiKey(key: 'sk_new_key', id: 'new-id');
        },
        revoke: (_, keyId) async {
          log.add('revoke:$keyId');
        },
      );
      final container = ProviderContainer(
        overrides: [
          accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
          authCredentialsStoreProvider.overrideWithValue(saved),
          authClientProvider.overrideWithValue(client),
          authBackendOriginProvider.overrideWithValue(
            'http://example.com:17600',
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authCredentialsProvider.future);
      await drain();

      // list → mint → save → revoke old, then stale (fresh key untouched).
      expect(log, ['list', 'mint', 'save', 'revoke:old-id', 'revoke:stale-id']);
      final persisted = store.stored!;
      expect(persisted.apiKey, 'sk_new_key');
      expect(persisted.keyId, 'new-id');
      expect(persisted.mintedAt, isNotNull);
      expect(
        DateTime.now().difference(persisted.mintedAt!),
        lessThan(const Duration(minutes: 1)),
      );
      expect(container.read(authCredentialsProvider).value, persisted);
      expect(container.read(sessionStatusProvider), SessionStatus.valid);
    });

    test(
      'age <60d with valid session: no mint, no revoke, no extra save',
      () async {
        final store = FakeAuthCredentialsStore(
          stored: oldKey(
            mintedAt: DateTime.now().subtract(const Duration(days: 10)),
          ),
        );
        final client = validClient();
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(client.mintRequests, isEmpty);
        expect(client.revokeCalls, isEmpty);
        expect(client.listApiKeysRequests, isEmpty);
        expect(store.saveCalls, 0);
      },
    );

    test('invalid session: key kept, no list/mint/revoke', () async {
      final original = oldKey();
      final store = FakeAuthCredentialsStore(stored: original);
      final client = FakeAuthClient(onGetSession: (_) async => null);
      // list/mint/revoke left unstubbed — any call would throw and the pass
      // swallows it, but we assert the call counts stay at zero instead.
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.invalid);
      expect(client.listApiKeysRequests, isEmpty);
      expect(client.mintRequests, isEmpty);
      expect(client.revokeCalls, isEmpty);
      expect(store.saveCalls, 0);
      expect(store.stored, original);
    });

    test(
      'unknown session (ping transport failure): key kept, no rotation',
      () async {
        final original = oldKey();
        final store = FakeAuthCredentialsStore(stored: original);
        final client = FakeAuthClient(
          onGetSession: (_) async => throw const AuthNetworkError('down'),
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(container.read(sessionStatusProvider), SessionStatus.unknown);
        expect(client.listApiKeysRequests, isEmpty);
        expect(client.mintRequests, isEmpty);
        expect(store.saveCalls, 0);
        expect(store.stored, original);
      },
    );

    test(
      'AuthEmailNotVerified from list aborts silently (key kept, no throw)',
      () async {
        final original = oldKey();
        final store = FakeAuthCredentialsStore(stored: original);
        final client = validClient(
          list: (_) async =>
              throw const AuthEmailNotVerified('not verified', statusCode: 403),
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(container.read(authCredentialsProvider).hasError, isFalse);
        expect(client.mintRequests, isEmpty);
        expect(client.revokeCalls, isEmpty);
        expect(store.saveCalls, 0);
        expect(store.stored, original);
        expect(container.read(sessionStatusProvider), SessionStatus.valid);
      },
    );

    test(
      'network failure from mint aborts silently (key kept, no throw)',
      () async {
        final original = oldKey();
        final store = FakeAuthCredentialsStore(stored: original);
        final client = validClient(
          mint: (_) async => throw const AuthNetworkError('down'),
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(container.read(authCredentialsProvider).hasError, isFalse);
        expect(client.revokeCalls, isEmpty);
        expect(store.saveCalls, 0);
        expect(store.stored, original);
      },
    );

    test(
      'legacy backfill matches by keyId and stamps mintedAt from createdAt',
      () async {
        final serverCreatedAt = ago(const Duration(days: 5));
        final store = FakeAuthCredentialsStore(
          stored: AuthCredentials(
            apiKey: 'sk_local_key',
            email: 'a@b.c',
            keyId: 'local-id',
            sessionToken: 'tok-1',
            ownerId: 'owner-1',
            backendOrigin: 'http://example.com:17600',
            // mintedAt null = legacy install
          ),
        );
        final client = validClient(
          list: (_) async => [
            ApiKeyListEntry(
              id: 'local-id',
              start: 'sk_loc',
              enabled: true,
              createdAt: serverCreatedAt,
            ),
          ],
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        // Stamped but NOT rotated: age is only 5d.
        expect(store.saveCalls, 1);
        final persisted = store.stored!;
        expect(persisted.mintedAt, serverCreatedAt);
        expect(persisted.apiKey, 'sk_local_key');
        expect(client.mintRequests, isEmpty);
        expect(client.revokeCalls, isEmpty);
        expect(container.read(authCredentialsProvider).value, persisted);
      },
    );

    test(
      'legacy backfill falls back to start-prefix match when keyId absent',
      () async {
        final serverCreatedAt = ago(const Duration(days: 5));
        final store = FakeAuthCredentialsStore(
          stored: const AuthCredentials(
            apiKey: 'sk_local_key',
            email: 'a@b.c',
            sessionToken: 'tok-1',
            ownerId: 'owner-1',
            backendOrigin: 'http://example.com:17600',
          ),
        );
        final client = validClient(
          list: (_) async => [
            ApiKeyListEntry(
              id: 'other-id',
              start: 'sk_other',
              enabled: true,
              createdAt: ago(const Duration(days: 30)),
            ),
            ApiKeyListEntry(
              id: 'match-id',
              start: 'sk_local',
              enabled: true,
              createdAt: serverCreatedAt,
            ),
          ],
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(store.stored!.mintedAt, serverCreatedAt);
        expect(store.stored!.keyId, 'match-id');
        expect(client.mintRequests, isEmpty);
      },
    );

    test(
      'legacy backfill leaves an unmatched multi-key list ambiguous',
      () async {
        final store = FakeAuthCredentialsStore(
          stored: const AuthCredentials(
            apiKey: 'sk_unmatched_local_key_with_no_prefix_hit',
            email: 'a@b.c',
            sessionToken: 'tok-1',
            ownerId: 'owner-1',
            backendOrigin: 'http://example.com:17600',
          ),
        );
        final client = validClient(
          list: (_) async => [
            ApiKeyListEntry(
              id: 'old-id',
              start: 'sk_zzz',
              enabled: true,
              createdAt: ago(const Duration(days: 40)),
            ),
            ApiKeyListEntry(
              id: 'disabled-id',
              start: 'sk_dis',
              enabled: false,
              createdAt: ago(const Duration(days: 1)),
            ),
            ApiKeyListEntry(
              id: 'other-active-id',
              start: 'sk_other',
              enabled: true,
              createdAt: ago(const Duration(days: 2)),
            ),
          ],
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(store.saveCalls, 0);
        expect(store.stored!.mintedAt, isNull);
        expect(store.stored!.keyId, isNull);
        expect(client.mintRequests, isEmpty);
        expect(client.revokeCalls, isEmpty);
      },
    );

    test(
      'legacy backfill accepts the only active key without a prefix match',
      () async {
        final createdAt = ago(const Duration(days: 4));
        final store = FakeAuthCredentialsStore(
          stored: const AuthCredentials(
            apiKey: 'sk_unmatched_local_key',
            sessionToken: 'tok-1',
            ownerId: 'owner-1',
            backendOrigin: 'http://example.com:17600',
          ),
        );
        final client = validClient(
          list: (_) async => [
            ApiKeyListEntry(
              id: 'only-active-id',
              start: 'sk_unrelated',
              enabled: true,
              createdAt: createdAt,
            ),
          ],
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(store.stored!.keyId, 'only-active-id');
        expect(store.stored!.mintedAt, createdAt);
        expect(client.mintRequests, isEmpty);
      },
    );

    test('empty list: mintedAt stays null, no rotation', () async {
      final store = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'sk_legacy_key',
          email: 'a@b.c',
          keyId: 'legacy-id',
          sessionToken: 'tok-1',
          ownerId: 'owner-1',
          backendOrigin: 'http://example.com:17600',
          // mintedAt null (legacy) + empty server list → nothing to stamp
        ),
      );
      final client = validClient(list: (_) async => const []);
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(store.stored!.mintedAt, isNull);
      expect(client.mintRequests, isEmpty);
      expect(store.saveCalls, 0);
    });
  });

  group('keyExpiryWarningProvider', () {
    test('true when session invalid and mintedAt is within 7d of the 90d '
        'horizon', () async {
      final mintedAt = DateTime.now().subtract(const Duration(days: 85));
      final store = FakeAuthCredentialsStore(
        stored: AuthCredentials(
          apiKey: 'key-1',
          email: 'a@b.c',
          keyId: 'k1',
          sessionToken: 'tok-1',
          ownerId: 'owner-1',
          backendOrigin: 'http://example.com:17600',
          mintedAt: mintedAt,
        ),
      );
      final client = FakeAuthClient(onGetSession: (_) async => null);
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.invalid);
      expect(container.read(keyExpiryWarningProvider), isTrue);
    });

    test('false when session invalid but key is nowhere near expiry', () async {
      final store = FakeAuthCredentialsStore(
        stored: AuthCredentials(
          apiKey: 'key-1',
          email: 'a@b.c',
          keyId: 'k1',
          sessionToken: 'tok-1',
          ownerId: 'owner-1',
          backendOrigin: 'http://example.com:17600',
          mintedAt: DateTime.now().subtract(const Duration(days: 10)),
        ),
      );
      final client = FakeAuthClient(onGetSession: (_) async => null);
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.invalid);
      expect(container.read(keyExpiryWarningProvider), isFalse);
    });

    test(
      'false while session is valid (rotation pass owns that case)',
      () async {
        final store = FakeAuthCredentialsStore(
          stored: AuthCredentials(
            apiKey: 'key-1',
            email: 'a@b.c',
            keyId: 'k1',
            sessionToken: 'tok-1',
            ownerId: 'owner-1',
            backendOrigin: 'http://example.com:17600',
            mintedAt: DateTime.now().subtract(const Duration(days: 85)),
          ),
        );
        final client = FakeAuthClient(
          onGetSession: (_) async =>
              const CurrentSession(userId: 'owner-1', email: 'a@b.c'),
          onListApiKeys: (_) async => const [],
        );
        final container = makeContainer(store: store, client: client);

        await container.read(authCredentialsProvider.future);
        await drain();

        expect(container.read(sessionStatusProvider), SessionStatus.valid);
        expect(container.read(keyExpiryWarningProvider), isFalse);
      },
    );

    test('false for legacy credentials without mintedAt', () async {
      final store = FakeAuthCredentialsStore(
        stored: AuthCredentials(
          apiKey: 'key-1',
          email: 'a@b.c',
          keyId: 'k1',
          sessionToken: 'tok-1',
          ownerId: 'owner-1',
          backendOrigin: 'http://example.com:17600',
        ),
      );
      final client = FakeAuthClient(onGetSession: (_) async => null);
      final container = makeContainer(store: store, client: client);

      await container.read(authCredentialsProvider.future);
      await drain();

      expect(container.read(sessionStatusProvider), SessionStatus.invalid);
      expect(container.read(keyExpiryWarningProvider), isFalse);
    });
  });
}

/// Wraps [inner] so tests can assert the exact order of startup-pass
/// persistence writes without forking the fake's other behavior.
class _LoggingAuthStore implements AuthCredentialsStore {
  _LoggingAuthStore(this.inner, this.log);

  final AuthCredentialsStore inner;
  final List<String> log;

  @override
  Future<AuthCredentials?> load() => inner.load();

  @override
  Future<void> save(AuthCredentials credentials) async {
    log.add('save');
    await inner.save(credentials);
  }

  @override
  Future<void> clear() => inner.clear();
}
