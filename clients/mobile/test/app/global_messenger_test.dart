import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/app/global_messenger.dart';

void main() {
  testWidgets(
      'showGlobalSnack surfaces a snackbar on the root messenger when the '
      'key is attached', (tester) async {
    // Harness equivalent of the app root: MaterialApp wired with the same
    // scaffoldMessengerKey lib/main.dart uses (a real screen hosts a Scaffold,
    // which is what the messenger presents snackbars through).
    await tester.pumpWidget(
      MaterialApp(
        scaffoldMessengerKey: scaffoldMessengerKey,
        home: const Scaffold(body: SizedBox.shrink()),
      ),
    );
    expect(scaffoldMessengerKey.currentState, isNotNull);

    showGlobalSnack('Root notice');
    await tester.pump(); // build the SnackBar
    await tester.pump(const Duration(milliseconds: 300)); // entrance

    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.text('Root notice'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink()); // detach the key
  });

  testWidgets('showGlobalSnack no-ops safely when the key is not attached',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: SizedBox.shrink())),
    );
    expect(scaffoldMessengerKey.currentState, isNull);

    expect(() => showGlobalSnack('dropped'), returnsNormally);
    await tester.pump();

    expect(find.byType(SnackBar), findsNothing);
  });
}
