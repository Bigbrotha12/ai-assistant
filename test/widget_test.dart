import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client_provider.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/core/theme_providers.dart';
import 'package:ai_assistant/core/widgets/speak_button.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';
import 'package:ai_assistant/features/settings/settings_screen.dart';
import 'package:ai_assistant/features/voice/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/voice_settings_providers.dart';
import 'package:ai_assistant/main.dart';

import 'fakes.dart';
import 'features/voice/voice_test_fakes.dart';

void main() {
  /// Full app under test. Booting the real [AiAssistantApp] lands on the
  /// voice home screen, so the voice provider graph must be resolvable too.
  Widget app({
    required FakeSettingsStore store,
    required FakeProbe probe,
    required FakeChatStore chatStore,
    required FakeChatClient client,
  }) =>
      ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(store),
          backendProbeProvider.overrideWithValue(probe),
          chatStoreProvider.overrideWithValue(chatStore),
          chatApiClientProvider.overrideWithValue(client),
          // The voice home boots the real audio stack (LiveKit, record,
          // just_audio, secure storage, path_provider); none of that exists in
          // widget tests, so every voice service is faked.
          engineManagerProvider.overrideWithValue(FakeEngineManager()),
          liveKitServiceProvider.overrideWithValue(FakeLiveKitService()),
          micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
          audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
          audioSessionManagerProvider
              .overrideWithValue(FakeAudioSessionManager()),
          vadProcessorProvider.overrideWithValue(FakeVadProcessor()),
          voiceSettingsStoreProvider
              .overrideWithValue(FakeVoiceSettingsStore()),
          appTierStoreProvider.overrideWithValue(FakeAppTierStore()),
        ],
        child: const AiAssistantApp(),
      );

  /// Settings screen pumped directly, wrapped in the minimal provider graph
  /// it needs (it does not depend on the chat providers).
  Widget settingsApp({
    required FakeSettingsStore store,
    required FakeProbe probe,
  }) =>
      ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(store),
          backendProbeProvider.overrideWithValue(probe),
          appTierStoreProvider.overrideWithValue(FakeAppTierStore()),
        ],
        child: const MaterialApp(home: SettingsScreen()),
      );

  group('voice home', () {
    /// Bounded pump: the voice home keeps idle animations running (the speak
    /// button's breathing pulse + ring repeat forever), so [`pumpAndSettle`]
    /// would time out. Fixed-duration pumps settle providers and route
    /// transitions without waiting for an idle frame.
    Future<void> pumpBounded(WidgetTester tester) async {
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    testWidgets('smoke: app boots to VoiceScreen with valid settings',
        (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
      );
      await tester.pumpWidget(app(
        store: store,
        probe: FakeProbe(),
        chatStore: FakeChatStore(),
        client: FakeChatClient(),
      ));
      await pumpBounded(tester);

      expect(find.text('AI Assistant'), findsOneWidget);
      expect(find.byType(SpeakButton), findsOneWidget);
      expect(find.text('PRESS AND HOLD TO TALK'), findsOneWidget);
      expect(find.text('Transcript'), findsOneWidget);
      expect(find.text('Backend not configured'), findsNothing);
    });

    testWidgets('smoke: app shows the Configure Backend banner when settings '
        'invalid', (tester) async {
      await tester.pumpWidget(app(
        store: FakeSettingsStore(),
        probe: FakeProbe(),
        chatStore: FakeChatStore(),
        client: FakeChatClient(),
      ));
      await pumpBounded(tester);

      expect(find.text('Backend not configured'), findsOneWidget);
      expect(find.text('Configure Backend'), findsOneWidget);
    });

    testWidgets('Settings screen opens from the app bar menu', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
      );
      await tester.pumpWidget(app(
        store: store,
        probe: FakeProbe(),
        chatStore: FakeChatStore(),
        client: FakeChatClient(),
      ));
      await pumpBounded(tester);

      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('Settings'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Backend host'), findsOneWidget);
      expect(find.text('Shared secret'), findsOneWidget);
      expect(find.text('MCP token (optional)'), findsOneWidget);
    });
  });

  group('settings screen', () {
    testWidgets('smoke: app title and settings fields render', (tester) async {
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(store: FakeSettingsStore(), probe: probe));
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
      await tester.pumpWidget(settingsApp(store: store, probe: FakeProbe()));
      await tester.pumpAndSettle();

      final hostField = tester.widget<TextField>(find.byType(TextField).at(0));
      final secretField = tester.widget<TextField>(find.byType(TextField).at(1));
      expect(hostField.controller!.text, 'myhost');
      expect(secretField.controller!.text, 's3cret');
    });

    testWidgets('save persists settings and shows a SnackBar', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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
      await tester.pumpWidget(settingsApp(store: FakeSettingsStore(), probe: probe));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'myhost');
      await tester.enterText(find.byType(TextField).at(1), 's3cret');
      await tester.tap(find.text('Test connection'));
      await tester.pumpAndSettle();

      // Probe rows are hidden in the collapsed ExpansionTile; expand it first.
      await tester.tap(find.text('Some backend services are unavailable'));
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
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
      await tester.pumpAndSettle();

      expect(probe.calls, 1);
      expect(probe.lastSettings, const BackendSettings(host: 'myhost', secret: 's3cret'));
    });

    testWidgets('Save is disabled while the secret is blank', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
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

    testWidgets('MCP token field is present and optional', (tester) async {
      final store = FakeSettingsStore();
      await tester.pumpWidget(settingsApp(store: store, probe: FakeProbe()));
      await tester.pumpAndSettle();

      expect(find.text('MCP token (optional)'), findsOneWidget);
      expect(find.text('voice-mcp bearer token (Phase 4)'), findsOneWidget);
    });

    testWidgets('MCP token field prefills from saved settings', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(
          host: 'myhost',
          secret: 's3cret',
          mcpSecret: 'mcp-token',
        ),
      );
      await tester.pumpWidget(settingsApp(store: store, probe: FakeProbe()));
      await tester.pumpAndSettle();

      final mcpField = tester.widget<TextField>(find.byType(TextField).at(2));
      expect(mcpField.controller!.text, 'mcp-token');
    });

    testWidgets('save persists the MCP token', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(store: store, probe: probe));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
      await tester.enterText(find.byType(TextField).at(1), 's3cret');
      await tester.enterText(find.byType(TextField).at(2), 'mcp-token');
      await tester.pump();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
      expect(store.stored!.host, 'tailscale.local');
      expect(store.stored!.mcpSecret, 'mcp-token');
    });

    testWidgets('Clear settings shows a dialog and clears on confirm',
        (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(
          host: 'myhost',
          secret: 's3cret',
          mcpSecret: 'mcp-token',
        ),
      );
      await tester.pumpWidget(settingsApp(store: store, probe: FakeProbe()));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Clear settings'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Clear settings'));
      await tester.pumpAndSettle();

      expect(find.text('Clear saved host, secret, MCP token, files token, and storage URL?'), findsOneWidget);

      await tester.tap(find.text('Clear'));
      await tester.pumpAndSettle();

      expect(store.stored, isNull);
      expect(find.text('Settings cleared'), findsOneWidget);
    });

    testWidgets('Clear settings cancels without clearing', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
      );
      await tester.pumpWidget(settingsApp(store: store, probe: FakeProbe()));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Clear settings'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Clear settings'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
    });
  });
}
