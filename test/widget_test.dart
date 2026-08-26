import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/main.dart';

import 'fakes.dart';

void main() {
  Widget app({required FakeSettingsStore store, required FakeProbe probe}) =>
      ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(store),
          backendProbeProvider.overrideWithValue(probe),
        ],
        child: const AiAssistantApp(),
      );

  testWidgets('smoke: app title and settings fields render', (tester) async {
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: FakeSettingsStore(), probe: probe));
    await tester.pumpAndSettle();

    expect(find.text('AI Assistant'), findsOneWidget);
    expect(find.text('Backend host'), findsOneWidget);
    expect(find.text('Shared secret'), findsOneWidget);
    expect(probe.calls, 0);
  });

  testWidgets('prefills the form from saved settings', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    await tester.pumpWidget(app(store: store, probe: FakeProbe()));
    await tester.pumpAndSettle();

    final hostField = tester.widget<TextField>(find.byType(TextField).at(0));
    final secretField = tester.widget<TextField>(find.byType(TextField).at(1));
    expect(hostField.controller!.text, 'myhost');
    expect(secretField.controller!.text, 's3cret');
  });

  testWidgets('save persists settings and shows a SnackBar', (tester) async {
    final store = FakeSettingsStore();
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNotNull);
    expect(store.stored!.host, 'tailscale.local');
    expect(find.text('Settings saved'), findsOneWidget);
    expect(probe.calls, 1);
  });

  testWidgets('shows per-check probe result rows', (tester) async {
    final probe = FakeProbe(
      status: const BackendStatus(checks: [
        CheckResult(
          check: BackendCheck.tokenMint,
          status: ProbeStatus.ok,
          detail: 'reachable',
        ),
        CheckResult(
          check: BackendCheck.tokenMintAuth,
          status: ProbeStatus.error,
          detail: 'shared secret rejected (401)',
        ),
        CheckResult(
          check: BackendCheck.liveKit,
          status: ProbeStatus.ok,
          detail: 'signaling reachable',
        ),
        CheckResult(
          check: BackendCheck.llmProxy,
          status: ProbeStatus.ok,
          detail: 'inference ready',
        ),
      ]),
    );
    await tester.pumpWidget(app(store: FakeSettingsStore(), probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'myhost');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.tap(find.text('Test connection'));
    await tester.pumpAndSettle();

    expect(find.text('Token mint'), findsOneWidget);
    expect(find.text('reachable'), findsOneWidget);
    // 'Shared secret' appears both as the secret field's label and the
    // tokenMintAuth row label; the row is proven by its detail text below.
    expect(find.text('Shared secret'), findsWidgets);
    expect(find.text('shared secret rejected (401)'), findsOneWidget);
    expect(probe.calls, 1);
  });

  testWidgets('auto-probes valid saved settings once on load', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
    );
    final probe = FakeProbe(
      status: const BackendStatus(checks: [
        CheckResult(
          check: BackendCheck.tokenMint,
          status: ProbeStatus.ok,
          detail: 'reachable',
        ),
        CheckResult(
          check: BackendCheck.tokenMintAuth,
          status: ProbeStatus.ok,
          detail: 'shared secret valid',
        ),
        CheckResult(
          check: BackendCheck.liveKit,
          status: ProbeStatus.ok,
          detail: 'signaling reachable',
        ),
        CheckResult(
          check: BackendCheck.llmProxy,
          status: ProbeStatus.ok,
          detail: 'inference ready',
        ),
      ]),
    );
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    expect(probe.calls, 1);
    expect(probe.lastSettings, const BackendSettings(host: 'myhost', secret: 's3cret'));
  });

  testWidgets('Save is disabled while the secret is blank', (tester) async {
    final store = FakeSettingsStore();
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
    await tester.pump();

    final saveButton = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Save'),
    );
    expect(saveButton.onPressed, isNull);

    // A valid host alone still allows probing (produces an informative 401).
    final testButton = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Test connection'),
    );
    expect(testButton.onPressed, isNotNull);
  });

  testWidgets('save failure shows the could-not-save SnackBar',
      (tester) async {
    final store = FakeSettingsStore()..failNextSave = true;
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNull);
    expect(find.text('Could not save settings'), findsOneWidget);
    expect(probe.calls, 0);
  });

  testWidgets('Test then Save on first launch runs exactly two probes and '
      'never auto-probes again', (tester) async {
    final store = FakeSettingsStore();
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'myhost');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.pump();

    await tester.tap(find.text('Test connection'));
    await tester.pumpAndSettle();
    expect(probe.calls, 1);

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(probe.calls, 2);

    // The settings-listener must not schedule a follow-up auto-probe.
    await tester.pumpAndSettle();
    expect(probe.calls, 2);
  });

  testWidgets('Save on first launch probes exactly once', (tester) async {
    final store = FakeSettingsStore();
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'myhost');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNotNull);
    expect(probe.calls, 1);
    await tester.pumpAndSettle();
    expect(probe.calls, 1);
  });

  testWidgets('host validation disables the buttons and shows an error',
      (tester) async {
    final store = FakeSettingsStore();
    final probe = FakeProbe();
    await tester.pumpWidget(app(store: store, probe: probe));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'https://evil.example');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.pump();

    expect(find.text('Enter a host name, not a URL'), findsOneWidget);
    final saveButton = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Save'),
    );
    final testButton = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Test connection'),
    );
    expect(saveButton.onPressed, isNull);
    expect(testButton.onPressed, isNull);
  });
}