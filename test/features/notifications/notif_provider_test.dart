import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/notifications/data/notif_client.dart';
import 'package:ai_assistant/features/notifications/data/notif_provider.dart';
import 'package:ai_assistant/features/notifications/data/notify_credentials_store.dart';

import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

/// Records subscribe/unsubscribe calls for the subscription-lifecycle tests.
class _RecordingNotifClient implements NotifClient {
  final List<String> subscribed = [];
  final List<String> unsubscribed = [];

  @override
  Future<void> subscribe(String topic) async => subscribed.add(topic);

  @override
  Future<void> unsubscribe(String topic) async => unsubscribed.add(topic);
}

/// Mutable account scope for the scope-switch tests. Riverpod 3 removed
/// `StateProvider`, so a tiny [Notifier] stands in for it.
class _MutableScope extends Notifier<AuthAccountScope?> {
  _MutableScope(this.initial);

  final AuthAccountScope? initial;

  @override
  AuthAccountScope? build() => initial;

  void set(AuthAccountScope? scope) => state = scope;
}

final _scopeStateProvider =
    NotifierProvider<_MutableScope, AuthAccountScope?>(() => _MutableScope(null));

AuthAccountScope _scope([String owner = 'owner-a']) =>
    AuthAccountScope.fromIdentity(
      ownerId: owner,
      backendOrigin: 'https://gw.test',
    )!;

Future<void> _settle() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('notify credentials providers', () {
    test('token provider reflects the stored credentials', () async {
      final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
      final scope = _scope();
      await store.save(
        scope,
        const NotifyCredentials(topic: 'topic-a', accessToken: 'token-a'),
      );
      final container = ProviderContainer(
        overrides: [
          notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
          notifyAccountScopeProvider.overrideWithValue(scope),
          notifyCredentialsStoreProvider.overrideWithValue(store),
        ],
      );
      addTearDown(container.dispose);

      await container.read(notifyCredentialsProvider.future);
      expect(container.read(notifAccessTokenProvider), 'token-a');
    });

    test('token provider is empty when nothing is stored', () async {
      final container = ProviderContainer(
        overrides: [
          notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
          notifyAccountScopeProvider.overrideWithValue(_scope()),
          notifyCredentialsStoreProvider.overrideWithValue(
            NotifyCredentialsStore(storage: InMemorySecureStorage()),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(notifyCredentialsProvider.future);
      expect(container.read(notifAccessTokenProvider), '');
    });

    test(
      'token provider is empty and credentials null with no base URL',
      () async {
        final container = ProviderContainer(
          overrides: [
            notifBaseUrlProvider.overrideWithValue(''),
            notifyAccountScopeProvider.overrideWithValue(_scope()),
            notifyCredentialsStoreProvider.overrideWithValue(
              NotifyCredentialsStore(storage: InMemorySecureStorage()),
            ),
          ],
        );
        addTearDown(container.dispose);

        expect(await container.read(notifyCredentialsProvider.future), isNull);
        expect(container.read(notifAccessTokenProvider), '');
      },
    );

    test('NoOp client when the base URL is empty', () {
      final container = ProviderContainer(
        overrides: [notifBaseUrlProvider.overrideWithValue('')],
      );
      addTearDown(container.dispose);
      expect(container.read(notifClientProvider), isA<NoOpNotifClient>());
    });

    test('a live ntfy client once a base URL is configured', () {
      final container = ProviderContainer(
        overrides: [
          notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
          notifyAccountScopeProvider.overrideWithValue(_scope()),
          notifyCredentialsStoreProvider.overrideWithValue(
            NotifyCredentialsStore(storage: InMemorySecureStorage()),
          ),
        ],
      );
      addTearDown(container.dispose);
      expect(container.read(notifClientProvider), isA<NtfyNotifClient>());
    });
  });

  group('notif subscription lifecycle', () {
    late _RecordingNotifClient client;
    late NotifyCredentialsStore store;
    late AuthAccountScope scope;
    late ProviderContainer container;

    void create() {
      client = _RecordingNotifClient();
      store = NotifyCredentialsStore(storage: InMemorySecureStorage());
      scope = _scope();
      container = ProviderContainer(
        overrides: [
          notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
          notifyAccountScopeProvider.overrideWithValue(scope),
          notifyCredentialsStoreProvider.overrideWithValue(store),
          notifClientProvider.overrideWithValue(client),
        ],
      );
      addTearDown(container.dispose);
    }

    Future<void> write(NotifyCredentials credentials) async {
      await store.save(scope, credentials);
      container.invalidate(notifyCredentialsProvider);
      await container.read(notifyCredentialsProvider.future);
      container.read(notifSubscriptionProvider);
      await _settle();
    }

    test(
      'subscribes, resubscribes on change, unsubscribes on remove',
      () async {
        create();
        // Keeps the non-autoDispose subscription provider alive across writes.
        final listener = container.listen(notifSubscriptionProvider, (_, _) {});
        addTearDown(listener.close);

        await _settle();
        container.read(notifSubscriptionProvider);
        await _settle();
        expect(client.subscribed, isEmpty);

        await write(
          const NotifyCredentials(topic: 'topic-1', accessToken: 'token-1'),
        );
        expect(client.subscribed, ['topic-1']);
        expect(client.unsubscribed, isEmpty);

        await write(
          const NotifyCredentials(topic: 'topic-2', accessToken: 'token-2'),
        );
        expect(client.subscribed, ['topic-1', 'topic-2']);
        expect(client.unsubscribed, ['topic-1']);

        await store.remove(scope);
        container.invalidate(notifyCredentialsProvider);
        await container.read(notifyCredentialsProvider.future);
        await _settle();
        expect(client.unsubscribed, ['topic-1', 'topic-2']);
      },
    );

    test('dispose unsubscribes the active topic', () async {
      create();
      final listener = container.listen(notifSubscriptionProvider, (_, _) {});
      await _settle();

      await write(
        const NotifyCredentials(topic: 'topic-1', accessToken: 'token-1'),
      );
      expect(client.subscribed, ['topic-1']);

      listener.close();
      container.dispose();
      await _settle();
      expect(client.unsubscribed, ['topic-1']);
    });

    test('backgrounding suspends and resuming re-subscribes', () async {
      create();
      container.listen(notifSubscriptionProvider, (_, _) {});
      await _settle();

      await write(
        const NotifyCredentials(topic: 'topic-1', accessToken: 'token-1'),
      );
      expect(client.subscribed, ['topic-1']);

      container.read(notifForegroundProvider.notifier).set(false);
      container.read(notifSubscriptionProvider);
      await _settle();
      expect(client.unsubscribed, ['topic-1']);

      container.read(notifForegroundProvider.notifier).set(true);
      container.read(notifSubscriptionProvider);
      await _settle();
      expect(client.subscribed, ['topic-1', 'topic-1']);
    });
  });

  group('notif account scope changes', () {
    test(
      'the client drops the previous account token while the new one loads',
      () async {
        final store = NotifyCredentialsStore(
          storage: InMemorySecureStorage(),
        );
        await store.save(
          _scope('owner-a'),
          const NotifyCredentials(topic: 'topic-a', accessToken: 'token-a'),
        );
        await store.save(
          _scope('owner-b'),
          const NotifyCredentials(topic: 'topic-b', accessToken: 'token-b'),
        );
        final container = ProviderContainer(
          overrides: [
            notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
            _scopeStateProvider.overrideWith(
              () => _MutableScope(_scope('owner-a')),
            ),
            notifyAccountScopeProvider.overrideWith(
              (ref) => ref.watch(_scopeStateProvider),
            ),
            notifyCredentialsStoreProvider.overrideWithValue(store),
          ],
        );
        addTearDown(container.dispose);

        container.read(notifClientProvider);
        await container.read(notifyCredentialsProvider.future);
        expect(
          (container.read(notifClientProvider) as NtfyNotifClient).accessToken,
          'token-a',
        );

        container.read(_scopeStateProvider.notifier).set(_scope('owner-b'));
        // Fail quiet: the new scope's credentials are still loading, so the
        // previous account's token must not be reused.
        expect(container.read(notifAccessTokenProvider), '');
        expect(
          (container.read(notifClientProvider) as NtfyNotifClient).accessToken,
          isNull,
        );

        await container.read(notifyCredentialsProvider.future);
        expect(
          (container.read(notifClientProvider) as NtfyNotifClient).accessToken,
          'token-b',
        );
      },
    );

    test('a scope switch resubscribes the new account topic', () async {
      final client = _RecordingNotifClient();
      final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
      await store.save(
        _scope('owner-a'),
        const NotifyCredentials(topic: 'topic-a', accessToken: 'token-a'),
      );
      await store.save(
        _scope('owner-b'),
        const NotifyCredentials(topic: 'topic-b', accessToken: 'token-b'),
      );
      final container = ProviderContainer(
        overrides: [
          notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
          _scopeStateProvider.overrideWith(
            () => _MutableScope(_scope('owner-a')),
          ),
          notifyAccountScopeProvider.overrideWith(
            (ref) => ref.watch(_scopeStateProvider),
          ),
          notifyCredentialsStoreProvider.overrideWithValue(store),
          notifClientProvider.overrideWithValue(client),
        ],
      );
      addTearDown(container.dispose);
      container.listen(notifSubscriptionProvider, (_, _) {});

      await container.read(notifyCredentialsProvider.future);
      await _settle();
      expect(client.subscribed, ['topic-a']);

      container.read(_scopeStateProvider.notifier).set(_scope('owner-b'));
      await _settle();
      // The old topic is dropped before the new credentials settle.
      expect(client.unsubscribed, ['topic-a']);

      await container.read(notifyCredentialsProvider.future);
      await _settle();
      expect(client.subscribed, ['topic-a', 'topic-b']);
    });
  });
}
