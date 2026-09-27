import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/account_deleted_state.dart';
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
    expect(store.stored!.mintedAt, isNotNull);
    expect(
      DateTime.now().difference(store.stored!.mintedAt!),
      lessThan(const Duration(minutes: 1)),
    );
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

  testWidgets('forgot-password sub-flow sends the reset request and confirms', (
    tester,
  ) async {
    final store = FakeAuthCredentialsStore();
    final client = FakeAuthClient();
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authClientProvider.overrideWithValue(client),
        authBackendOriginProvider.overrideWithValue('https://example.com'),
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(
          home: Scaffold(body: AuthFlow(onSuccess: _noop)),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('auth-forgot-link')));
    await tester.pumpAndSettle();
    expect(find.text('Reset your password'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('auth-forgot-email')),
      'user@example.com',
    );
    await tester.tap(find.byKey(const Key('auth-forgot-submit')));
    await tester.pumpAndSettle();

    // The request went out one time and the confirmation replaced the form.
    expect(client.passwordResetRequests, ['user@example.com']);
    expect(find.textContaining('reset link is on its way'), findsOneWidget);

    // Back to sign in keeps the addressed email prefilled.
    await tester.tap(find.byKey(const Key('auth-forgot-back')));
    await tester.pumpAndSettle();
    final emailField = tester.widget<TextField>(
      find.byKey(const Key('auth-email')),
    );
    expect(emailField.controller!.text, 'user@example.com');
  });

  testWidgets('a failed reset request shows an error and stays on the form', (
    tester,
  ) async {
    final store = FakeAuthCredentialsStore();
    final client = FakeAuthClient(
      onRequestPasswordReset: (email) async =>
          throw const AuthNetworkError('unreachable'),
    );
    final container = ProviderContainer(
      overrides: [
        authCredentialsStoreProvider.overrideWithValue(store),
        authClientProvider.overrideWithValue(client),
        authBackendOriginProvider.overrideWithValue('https://example.com'),
        accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(
          home: Scaffold(body: AuthFlow(onSuccess: _noop)),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('auth-forgot-link')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('auth-forgot-email')),
      'user@example.com',
    );
    await tester.tap(find.byKey(const Key('auth-forgot-submit')));
    await tester.pumpAndSettle();

    expect(find.textContaining('Could not reach the server'), findsOneWidget);
    expect(find.byKey(const Key('auth-forgot-submit')), findsOneWidget);
  });

  testWidgets(
    'a duplicate-email sign-up offers Sign in instead and prefills it',
    (tester) async {
      final store = FakeAuthCredentialsStore();
      final client = FakeAuthClient(
        onSignUp: (name, email, password) async =>
            throw const AuthEmailTaken('already exists'),
      );
      final container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authClientProvider.overrideWithValue(client),
          authBackendOriginProvider.overrideWithValue('https://example.com'),
          accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authCredentialsProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: AuthFlow(onSuccess: _noop)),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-name')), 'Ada');
      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'user@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'password1',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      // The duplicate-email error explains itself and offers the escape hatch.
      expect(
        find.text('An account already exists for this email'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('auth-signin-instead')), findsOneWidget);

      // Switching lands in sign-in mode with the email carried over.
      await tester.tap(find.byKey(const Key('auth-signin-instead')));
      await tester.pumpAndSettle();
      final emailField = tester.widget<TextField>(
        find.byKey(const Key('auth-email')),
      );
      expect(emailField.controller!.text, 'user@example.com');
      expect(find.byKey(const Key('auth-forgot-link')), findsOneWidget);
    },
  );

  group('email verification (C2)', () {
    /// Mounts [AuthFlow] on a container with the standard fake overrides.
    Future<void> pumpAuthFlow(
      WidgetTester tester, {
      required FakeAuthCredentialsStore store,
      required FakeAuthClient client,
      required ValueChanged<AuthSession> onSuccess,
    }) async {
      final container = ProviderContainer(
        overrides: [
          authCredentialsStoreProvider.overrideWithValue(store),
          authClientProvider.overrideWithValue(client),
          authBackendOriginProvider.overrideWithValue('https://example.com'),
          accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authCredentialsProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(body: AuthFlow(onSuccess: onSuccess)),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'tokenless sign-up shows check-inbox, never mints a key, stores nothing',
      (tester) async {
        final store = FakeAuthCredentialsStore();
        // C2: the server answers token: null (no session). onMintApiKey is
        // deliberately NOT stubbed — a mint attempt would throw UnimplementedError.
        final client = FakeAuthClient(
          onSignUp: (name, email, password) async => AuthSession(
            token: '',
            email: email,
            ownerId: 'owner-1',
            backendOrigin: 'https://example.com',
          ),
        );
        AuthSession? successful;
        await pumpAuthFlow(
          tester,
          store: store,
          client: client,
          onSuccess: (session) => successful = session,
        );

        await tester.tap(find.text('Create account'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const Key('auth-name')), 'Ada');
        await tester.enterText(
          find.byKey(const Key('auth-email')),
          'user@example.com',
        );
        await tester.enterText(
          find.byKey(const Key('auth-password')),
          'password1',
        );
        await tester.tap(find.byKey(const Key('auth-submit')));
        await tester.pumpAndSettle();

        expect(
          find.text('Verify your email — check your inbox'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('auth-verify-email')), findsOneWidget);
        expect(
          tester.widget<Text>(find.byKey(const Key('auth-verify-email'))).data,
          'user@example.com',
        );
        // No key mint, no credential write, no success publication.
        expect(successful, isNull);
        expect(store.stored, isNull);
        expect(store.saveCalls, 0);
      },
    );

    testWidgets('the check-inbox Resend action posts the verification email', (
      tester,
    ) async {
      final store = FakeAuthCredentialsStore();
      final client = FakeAuthClient(
        onSignUp: (name, email, password) async =>
            AuthSession(token: '', email: email),
      );
      await pumpAuthFlow(
        tester,
        store: store,
        client: client,
        onSuccess: _noop,
      );

      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-name')), 'Ada');
      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'user@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'password1',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('auth-resend')), findsOneWidget);

      await tester.tap(find.byKey(const Key('auth-resend')));
      await tester.pumpAndSettle();

      expect(client.verificationEmailRequests, ['user@example.com']);
      expect(
        find.text('Verification email sent again to user@example.com.'),
        findsOneWidget,
      );

      // Back to sign in restores the form with the address prefilled.
      await tester.tap(find.byKey(const Key('auth-verify-back')));
      await tester.pumpAndSettle();
      final emailField = tester.widget<TextField>(
        find.byKey(const Key('auth-email')),
      );
      expect(emailField.controller!.text, 'user@example.com');
      expect(find.byKey(const Key('auth-submit')), findsOneWidget);
    });

    testWidgets('a rate-limited resend surfaces the retry-after wait', (
      tester,
    ) async {
      final store = FakeAuthCredentialsStore();
      final client = FakeAuthClient(
        onSignUp: (name, email, password) async =>
            AuthSession(token: '', email: email),
        onSendVerificationEmail: (email) async => throw const AuthRateLimited(
          'Too many verification emails requested for this address.',
          statusCode: 429,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 60,
        ),
      );
      await pumpAuthFlow(
        tester,
        store: store,
        client: client,
        onSuccess: _noop,
      );

      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-name')), 'Ada');
      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'user@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'password1',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('auth-resend')));
      await tester.pumpAndSettle();

      expect(client.verificationEmailRequests, ['user@example.com']);
      expect(
        find.text('Too many requests — try again in 60 seconds.'),
        findsOneWidget,
      );
      // Still on the check-inbox state, able to retry later.
      expect(find.byKey(const Key('auth-resend')), findsOneWidget);
    });

    testWidgets(
      'AuthAccountDeleted latches the terminal notice and clears creds',
      (tester) async {
        final store = FakeAuthCredentialsStore();
        final client = FakeAuthClient(
          onSignIn: (email, password) async => throw const AuthAccountDeleted(
            'account deleted',
            statusCode: 403,
            code: 'account_deleted',
          ),
        );
        final container = ProviderContainer(
          overrides: [
            authCredentialsStoreProvider.overrideWithValue(store),
            authClientProvider.overrideWithValue(client),
            authBackendOriginProvider.overrideWithValue('https://example.com'),
            accountLifecycleProvider.overrideWithValue(AccountLifecycle()),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const MaterialApp(
              home: Scaffold(body: AuthFlow(onSuccess: _noop)),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('auth-email')),
          'user@example.com',
        );
        await tester.enterText(
          find.byKey(const Key('auth-password')),
          'password1',
        );
        await tester.tap(find.byKey(const Key('auth-submit')));
        await tester.pumpAndSettle();

        expect(container.read(accountDeletedProvider), isTrue);
        expect(container.read(authCredentialsProvider).value, isNull);
        expect(find.text(accountDeletedNotice), findsOneWidget);
        expect(find.text('Verify your email — check your inbox'), findsNothing);
      },
    );

    testWidgets(
      'sign-in rejected with EMAIL_NOT_VERIFIED routes to check-inbox',
      (tester) async {
        final store = FakeAuthCredentialsStore();
        final client = FakeAuthClient(
          onSignIn: (email, password) async => throw const AuthEmailNotVerified(
            'Email not verified',
            statusCode: 403,
            code: 'EMAIL_NOT_VERIFIED',
          ),
        );
        AuthSession? successful;
        await pumpAuthFlow(
          tester,
          store: store,
          client: client,
          onSuccess: (session) => successful = session,
        );

        await tester.enterText(
          find.byKey(const Key('auth-email')),
          'user@example.com',
        );
        await tester.enterText(
          find.byKey(const Key('auth-password')),
          'password1',
        );
        await tester.tap(find.byKey(const Key('auth-submit')));
        await tester.pumpAndSettle();

        expect(
          find.text('Verify your email — check your inbox'),
          findsOneWidget,
        );
        expect(
          tester.widget<Text>(find.byKey(const Key('auth-verify-email'))).data,
          'user@example.com',
        );
        expect(successful, isNull);
        expect(store.stored, isNull);

        // Resend is pre-filled with the address the sign-in attempted.
        await tester.tap(find.byKey(const Key('auth-resend')));
        await tester.pumpAndSettle();
        expect(client.verificationEmailRequests, ['user@example.com']);
      },
    );

    testWidgets('sign-in form offers a direct resend-verification link', (
      tester,
    ) async {
      final store = FakeAuthCredentialsStore();
      final client = FakeAuthClient();
      await pumpAuthFlow(
        tester,
        store: store,
        client: client,
        onSuccess: _noop,
      );

      // No address yet: the link surfaces the same validation as the button.
      await tester.tap(
        find.byKey(const Key('auth-resend-verification-link')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Enter your email address'), findsOneWidget);
      expect(client.verificationEmailRequests, isEmpty);

      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'user@example.com',
      );
      await tester.tap(
        find.byKey(const Key('auth-resend-verification-link')),
      );
      await tester.pumpAndSettle();

      expect(client.verificationEmailRequests, ['user@example.com']);
      expect(
        find.text('Verify your email — check your inbox'),
        findsOneWidget,
      );
      expect(
        find.text('Verification email sent again to user@example.com.'),
        findsOneWidget,
      );
    });
  });
}

void _noop(AuthSession session) {}
