import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/notifications/data/notif_provider.dart';
import 'package:ai_assistant/features/notifications/data/notify_admin_client.dart';
import 'package:ai_assistant/features/notifications/data/notify_credentials_store.dart';
import 'package:ai_assistant/features/settings/ui/notifications_settings_screen.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

AuthAccountScope _scope() => AuthAccountScope.fromIdentity(
  ownerId: 'owner-a',
  backendOrigin: 'https://gw.test',
)!;

/// Extends the real client so the constructor stays valid, and scripts the
/// four admin calls.
class _FakeNotifyAdminClient extends NotifyAdminClient {
  _FakeNotifyAdminClient() : super(dio: Dio(), baseUrl: 'https://gw.test');

  NotifyProvision? provisionResult;
  NotifyRotation? rotateResult;
  Object? revokeError;
  int revokeCalls = 0;

  @override
  Future<NotifyProvision> provision({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async => provisionResult!;

  @override
  Future<NotifyRotation> rotate({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async => rotateResult!;

  @override
  Future<void> revoke({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    revokeCalls++;
    final error = revokeError;
    if (error != null) throw error;
  }
}

/// Real secure-store persistence with a test-controlled gate on [save], so a
/// test can hold the write open and observe the busy state.
class _GatedNotifyCredentialsStore extends NotifyCredentialsStore {
  _GatedNotifyCredentialsStore() : super(storage: InMemorySecureStorage());

  Completer<void>? saveGate;
  int saveCalls = 0;

  @override
  Future<void> save(AuthAccountScope scope, NotifyCredentials credentials) async {
    saveCalls++;
    final gate = saveGate;
    if (gate != null) await gate.future;
    return super.save(scope, credentials);
  }
}

AuthCredentials _credentials() => const AuthCredentials(
  apiKey: 'gateway-key',
  ownerId: 'owner-a',
  backendOrigin: 'https://gw.test',
);

Widget _app({
  required NotifyCredentialsStore store,
  required _FakeNotifyAdminClient admin,
  required bool configuredBuild,
}) {
  return ProviderScope(
    overrides: [
      notifBaseUrlProvider.overrideWithValue(
        configuredBuild ? 'https://ntfy.test' : '',
      ),
      notifyAccountScopeProvider.overrideWithValue(_scope()),
      notifyCredentialsStoreProvider.overrideWithValue(store),
      notifyAdminClientProvider.overrideWithValue(admin),
      authCredentialsStoreProvider.overrideWithValue(
        FakeAuthCredentialsStore(stored: _credentials()),
      ),
      authBackendOriginProvider.overrideWithValue('https://gw.test'),
    ],
    child: const MaterialApp(home: NotificationsSettingsScreen()),
  );
}

void main() {
  testWidgets('provision reveals the token once and persists it', (
    tester,
  ) async {
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    final admin = _FakeNotifyAdminClient()
      ..provisionResult = const NotifyProvision(
        topic: 'assistant-owner-a',
        accessToken: 'tok-once',
        newlyProvisioned: true,
      );
    await tester.pumpWidget(
      _app(store: store, admin: admin, configuredBuild: true),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('notify-provision')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('notify-token-dialog')), findsOneWidget);
    expect(find.text('tok-once'), findsOneWidget);
    expect(find.text('assistant-owner-a'), findsOneWidget);
    expect(find.textContaining('won’t be shown again'), findsOneWidget);

    // Persisted before the dialog opened.
    final saved = await store.load(_scope());
    expect(saved?.accessToken, 'tok-once');

    await tester.tap(find.byKey(const Key('notify-token-done')));
    await tester.pumpAndSettle();

    // Exactly-once: the secret is gone from the surface.
    expect(find.text('tok-once'), findsNothing);
    expect(find.text('Configured'), findsOneWidget);
  });

  testWidgets('rotate reveals a new token and persists it', (tester) async {
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    await store.save(
      _scope(),
      const NotifyCredentials(topic: 'assistant-owner-a', accessToken: 'old'),
    );
    final admin = _FakeNotifyAdminClient()
      ..rotateResult = const NotifyRotation(
        topic: 'assistant-owner-a',
        accessToken: 'tok-new',
        rotated: true,
      );
    await tester.pumpWidget(
      _app(store: store, admin: admin, configuredBuild: true),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('notify-rotate')));
    await tester.pumpAndSettle();
    expect(find.text('tok-new'), findsOneWidget);

    await tester.tap(find.byKey(const Key('notify-token-done')));
    await tester.pumpAndSettle();
    expect((await store.load(_scope()))!.accessToken, 'tok-new');
  });

  testWidgets('revoke confirms and clears the stored credentials', (
    tester,
  ) async {
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    await store.save(
      _scope(),
      const NotifyCredentials(topic: 'assistant-owner-a', accessToken: 'tok'),
    );
    final admin = _FakeNotifyAdminClient();
    await tester.pumpWidget(
      _app(store: store, admin: admin, configuredBuild: true),
    );
    await tester.pumpAndSettle();

    expect(find.text('Configured'), findsOneWidget);
    await tester.tap(find.byKey(const Key('notify-revoke')));
    await tester.pumpAndSettle();

    // Confirmation dialog, then confirm.
    expect(find.text('Revoke notifications'), findsOneWidget);
    await tester.tap(find.text('Revoke').last);
    await tester.pumpAndSettle();

    expect(admin.revokeCalls, 1);
    expect(await store.load(_scope()), isNull);
    expect(find.text('Not set up on this device'), findsOneWidget);
  });

  testWidgets('without a base URL the state is explicit and actions disabled', (
    tester,
  ) async {
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    final admin = _FakeNotifyAdminClient();
    await tester.pumpWidget(
      _app(store: store, admin: admin, configuredBuild: false),
    );
    await tester.pumpAndSettle();

    expect(find.text('Not configured in this build'), findsOneWidget);
    for (final key in const [
      'notify-provision',
      'notify-rotate',
      'notify-revoke',
    ]) {
      final button = tester.widget<ButtonStyleButton>(find.byKey(Key(key)));
      expect(button.onPressed, isNull, reason: '$key should be disabled');
    }
  });

  testWidgets('provision stays busy until the token has been persisted', (
    tester,
  ) async {
    final store = _GatedNotifyCredentialsStore();
    final admin = _FakeNotifyAdminClient()
      ..provisionResult = const NotifyProvision(
        topic: 'assistant-owner-a',
        accessToken: 'tok-once',
        newlyProvisioned: true,
      );
    await tester.pumpWidget(
      _app(store: store, admin: admin, configuredBuild: true),
    );
    await tester.pumpAndSettle();

    // Hold the write open: the network call has returned but the token is not
    // stored yet.
    store.saveGate = Completer<void>();
    await tester.tap(find.byKey(const Key('notify-provision')));
    await tester.pump();

    expect(store.saveCalls, 1);
    final button = tester.widget<ButtonStyleButton>(
      find.byKey(const Key('notify-provision')),
    );
    expect(
      button.onPressed,
      isNull,
      reason: 'the action must remain disabled until persistence completes',
    );

    store.saveGate!.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('notify-token-dialog')), findsOneWidget);
  });
}
