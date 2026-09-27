import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/ui/verify_email_card.dart';

import '../../fakes.dart';

void main() {
  Future<void> pumpCard(
    WidgetTester tester,
    FakeAuthClient client, {
    String? email,
    VoidCallback? onDismiss,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [authClientProvider.overrideWithValue(client)],
        child: MaterialApp(
          home: Scaffold(
            body: VerifyEmailCard(email: email, onDismiss: onDismiss),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('resends to the provided address and confirms', (tester) async {
    final client = FakeAuthClient();
    await pumpCard(tester, client, email: 'user@example.com');

    await tester.tap(find.byKey(const Key('verify-email-resend')));
    await tester.pumpAndSettle();

    expect(client.verificationEmailRequests, ['user@example.com']);
    expect(
      find.text('Verification email sent to user@example.com.'),
      findsOneWidget,
    );
  });

  testWidgets('surfaces a rate-limited resend with the retry wait', (
    tester,
  ) async {
    final client = FakeAuthClient(
      onSendVerificationEmail: (email) async => throw const AuthRateLimited(
        'Too many verification emails requested for this address.',
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 60,
      ),
    );
    await pumpCard(tester, client, email: 'user@example.com');

    await tester.tap(find.byKey(const Key('verify-email-resend')));
    await tester.pumpAndSettle();

    expect(
      find.text('Too many requests — try again in 60 seconds.'),
      findsOneWidget,
    );
  });

  testWidgets('asks for an address when none is provided', (tester) async {
    final client = FakeAuthClient();
    await pumpCard(tester, client);

    expect(find.byKey(const Key('verify-email-address')), findsOneWidget);

    await tester.tap(find.byKey(const Key('verify-email-resend')));
    await tester.pumpAndSettle();
    expect(find.text('Enter your email address'), findsOneWidget);
    expect(client.verificationEmailRequests, isEmpty);

    await tester.enterText(
      find.byKey(const Key('verify-email-address')),
      'a@b.c',
    );
    await tester.tap(find.byKey(const Key('verify-email-resend')));
    await tester.pumpAndSettle();
    expect(client.verificationEmailRequests, ['a@b.c']);
  });

  testWidgets('dismiss invokes the callback', (tester) async {
    final client = FakeAuthClient();
    var dismissed = 0;
    await pumpCard(
      tester,
      client,
      email: 'user@example.com',
      onDismiss: () => dismissed += 1,
    );

    await tester.tap(find.byKey(const Key('verify-email-dismiss')));
    await tester.pumpAndSettle();
    expect(dismissed, 1);
  });
}
