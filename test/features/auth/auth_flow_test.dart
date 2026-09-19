import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/auth/ui/auth_flow.dart';

import '../../fakes.dart';

class GatedAuthStore extends FakeAuthCredentialsStore {
  final gate = Completer<void>();

  @override
  Future<void> save(AuthCredentials credentials) async {
    await gate.future;
    await super.save(credentials);
  }
}

void main() {
  testWidgets('AuthFlow persists the new session identity before publication', (
    tester,
  ) async {
    final store = GatedAuthStore();
    store.stored = const AuthCredentials(
      apiKey: 'old',
      ownerId: 'old-user',
      backendOrigin: 'https://old.example',
    );
    final client = FakeAuthClient(
      onSignIn: (email, password) async => AuthSession(
        token: 'session',
        email: email,
        ownerId: 'actual-user',
        backendOrigin: 'https://accounts.example',
      ),
      onMintApiKey: (_) async =>
          const MintedApiKey(key: 'new-key', id: 'key-record-id'),
    );
    AuthSession? successful;
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authClientProvider.overrideWithValue(client),
        authBackendOriginProvider.overrideWithValue('https://accounts.example'),
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            body: AuthFlow(onSuccess: (session) => successful = session),
          ),
        ),
      ),
    );
    await tester.enterText(
      find.byKey(const Key('auth-email')),
      'user@example.com',
    );
    await tester.enterText(
      find.byKey(const Key('auth-password')),
      'test-password',
    );
    await tester.tap(find.byKey(const Key('auth-submit')));
    await tester.pump();
    expect(successful, isNull);
    expect(container.read(authCredentialsProvider).value, isNull);
    store.gate.complete();
    await tester.pumpAndSettle();
    expect(successful!.ownerId, 'actual-user');
    expect(store.stored!.apiKey, 'new-key');
    expect(store.stored!.keyId, 'key-record-id');
    expect(store.stored!.ownerId, 'actual-user');
    expect(store.stored!.backendOrigin, 'https://accounts.example');
    expect(container.read(authCredentialsProvider).value, store.stored);
  });

  test('failed auth persistence does not publish a new owner', () async {
    final store = FakeAuthCredentialsStore(
      stored: const AuthCredentials(apiKey: 'old'),
    );
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authBackendOriginProvider.overrideWithValue('https://example.com'),
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    store.failNextSave = true;
    await expectLater(
      container
          .read(authCredentialsProvider.notifier)
          .save(
            const AuthCredentials(
              apiKey: 'new',
              ownerId: 'new-user',
              backendOrigin: 'https://example.com',
            ),
          ),
      throwsStateError,
    );
    expect(container.read(authCredentialsProvider).hasError, isTrue);
    expect(store.stored!.apiKey, 'old');
  });
}
