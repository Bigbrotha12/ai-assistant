import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/app/widgets/probe_status_row.dart';
import 'package:ai_assistant/core/backend_probe.dart';

void main() {
  Future<void> pumpRow(
    WidgetTester tester,
    CheckResult result, {
    bool dense = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProbeStatusRow(result: result, label: 'Health', dense: dense),
        ),
      ),
    );
  }

  testWidgets('renders the gatewayDegraded status without throwing',
      (tester) async {
    await pumpRow(
      tester,
      const CheckResult(
        check: BackendCheck.health,
        status: ProbeStatus.gatewayDegraded,
        detail: 'gateway degraded: ledgerDb (HTTP 503)',
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.byIcon(Icons.warning_amber_outlined), findsOneWidget);
    expect(find.text('Health'), findsOneWidget);
    expect(find.text('gateway degraded: ledgerDb (HTTP 503)'), findsOneWidget);
  });

  testWidgets('renders the gatewayDegraded status in the dense variant',
      (tester) async {
    await pumpRow(
      tester,
      const CheckResult(
        check: BackendCheck.health,
        status: ProbeStatus.gatewayDegraded,
        detail: 'gateway degraded (HTTP 503)',
      ),
      dense: true,
    );

    expect(tester.takeException(), isNull);
    expect(find.byIcon(Icons.warning_amber_outlined), findsOneWidget);
    expect(find.text('Health'), findsOneWidget);
  });
}
