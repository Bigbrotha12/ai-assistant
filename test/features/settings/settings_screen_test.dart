import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/features/attachments/data/file_cache.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/ui/files_screen.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/settings/ui/settings_screen.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_screen.dart';

import '../../fakes.dart';
import '../voice/voice_test_fakes.dart';

/// [FileCache] fake that performs no disk IO, recording eviction calls.
class FakeFileCache extends FileCache {
  FakeFileCache() : super(cacheDir: Directory.systemTemp);

  int evictExpiredCalls = 0;

  @override
  Future<void> evictExpired() async {
    evictExpiredCalls++;
  }

  @override
  Future<Map<String, FileInfo>> getAllCached() async => const {};
}

void main() {
  Widget settingsApp(
    WidgetTester tester, {
    required FakeSettingsStore store,
    required FilesClient filesClient,
    required FileCache fileCache,
    FakeProbe? probe,
    FakeAuthCredentialsStore? authStore,
    FakeAuthClient? authClient,
    FakePrefsStore? prefsStore,
    FakeVoiceSettingsStore? voiceSettingsStore,
  }) {
    // The settings form is tall (host, environment, MCP, files token, storage
    // URL, probe results, Files section, danger zone). Use a tall test
    // viewport so most sections are laid out without scrolling — ListView
    // builds children lazily, so off-screen widgets are absent from the tree.
    tester.view.physicalSize = const Size(800, 2200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(store),
        backendProbeProvider.overrideWithValue(probe ?? FakeProbe()),
        filesServiceProvider.overrideWithValue(filesClient),
        filesStoreProvider.overrideWithValue(FakeFileStore()),
        fileCacheProvider.overrideWithValue(fileCache),
        authCredentialsStoreProvider
            .overrideWithValue(authStore ?? FakeAuthCredentialsStore()),
        authClientProvider.overrideWithValue(authClient ?? FakeAuthClient()),
        appPrefsStoreProvider.overrideWithValue(prefsStore ?? FakePrefsStore()),
        voiceSettingsStoreProvider
            .overrideWithValue(voiceSettingsStore ?? FakeVoiceSettingsStore()),
      ],
      child: const MaterialApp(home: SettingsScreen()),
    );
  }

  testWidgets('files token field prefills from saved settings', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(
        host: 'myhost',
        filesSecret: 'files-token',
      ),
    );
    await tester.pumpWidget(settingsApp(tester,
      store: store,
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    final filesField = tester.widget<TextField>(find.byType(TextField).at(2));
    expect(filesField.controller!.text, 'files-token');
  });

  testWidgets('save persists the files token', (tester) async {
    final store = FakeSettingsStore();
    await tester.pumpWidget(settingsApp(tester,
      store: store,
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
    await tester.enterText(find.byType(TextField).at(2), 'files-token');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNotNull);
    expect(store.stored!.host, 'tailscale.local');
    expect(store.stored!.filesSecret, 'files-token');
  });

  testWidgets('shows Files service not configured for a no-op client',
      (tester) async {
    await tester.pumpWidget(settingsApp(tester,
      store: FakeSettingsStore(),
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Files service not configured'), findsOneWidget);
    expect(find.text('Files service connected'), findsNothing);
  });

  testWidgets('shows Files service connected for a configured client',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(
        host: 'myhost',
        filesSecret: 'files-token',
      ),
    );
    await tester.pumpWidget(settingsApp(tester,
      store: store,
      filesClient: FakeFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Files service connected'), findsOneWidget);
    expect(find.text('Files service not configured'), findsNothing);
  });

  testWidgets('Clear Cache confirms, evicts expired files, and shows a SnackBar',
      (tester) async {
    final cache = FakeFileCache();
    await tester.pumpWidget(settingsApp(tester,
      store: FakeSettingsStore(),
      filesClient: NoOpFilesClient(),
      fileCache: cache,
    ));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Clear Cache'));
    await tester.tap(find.text('Clear Cache'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(cache.evictExpiredCalls, 1);
    expect(find.text('Cache cleared'), findsOneWidget);
  });

  testWidgets('File Browser button pushes the FilesScreen', (tester) async {
    await tester.pumpWidget(settingsApp(tester,
      store: FakeSettingsStore(),
      filesClient: FakeFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('File Browser'));
    await tester.tap(find.text('File Browser'));
    await tester.pumpAndSettle();

    expect(find.byType(FilesScreen), findsOneWidget);
  });

  group('backend & probe', () {
    testWidgets('app title and settings fields render', (tester) async {
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      expect(find.text('Voice Assist'), findsOneWidget);
      expect(find.text('Backend host'), findsOneWidget);
      expect(probe.calls, 0);
    });

    testWidgets('prefills the form from saved settings', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      final hostField = tester.widget<TextField>(find.byType(TextField).at(0));
      final mcpField = tester.widget<TextField>(find.byType(TextField).at(1));
      expect(hostField.controller!.text, 'myhost');
      expect(mcpField.controller!.text, '');
    });

    testWidgets('save persists settings and shows a SnackBar', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
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
            check: BackendCheck.auth,
            status: ProbeStatus.ok,
            detail: 'API key valid',
          ),
          CheckResult(
            check: BackendCheck.inference,
            status: ProbeStatus.ok,
            detail: 'inference ready',
          ),
          CheckResult(
            check: BackendCheck.vision,
            status: ProbeStatus.unreachable,
            detail: 'model.vl not found',
          ),
        ]),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'myhost');
      await tester.tap(find.text('Test connection'));
      await tester.pumpAndSettle();

      // Probe rows are hidden in the collapsed ExpansionTile; expand it first.
      await tester.tap(find.text('Some backend services are unavailable'));
      await tester.pumpAndSettle();

      expect(find.text('Auth'), findsOneWidget);
      expect(find.text('API key valid'), findsOneWidget);
      expect(find.text('Inference'), findsOneWidget);
      expect(find.text('inference ready'), findsOneWidget);
      expect(find.text('Vision (VL)'), findsOneWidget);
      expect(find.text('model.vl not found'), findsOneWidget);
      expect(probe.calls, 1);
    });

    testWidgets('auto-probes valid saved settings once on load', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      final probe = FakeProbe(
        status: const BackendStatus(checks: [
          CheckResult(
            check: BackendCheck.auth,
            status: ProbeStatus.ok,
            detail: 'API key valid',
          ),
          CheckResult(
            check: BackendCheck.inference,
            status: ProbeStatus.ok,
            detail: 'inference ready',
          ),
          CheckResult(
            check: BackendCheck.vision,
            status: ProbeStatus.ok,
            detail: 'model.vl available',
          ),
        ]),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      expect(probe.calls, 1);
      expect(probe.lastSettings, const BackendSettings(host: 'myhost'));
    });

    testWidgets('Save and Test are enabled with a valid host alone',
        (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
      await tester.pump();

      final saveButton = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Save'),
      );
      expect(saveButton.onPressed, isNotNull);

      final testButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Test connection'),
      );
      expect(testButton.onPressed, isNotNull);
    });

    testWidgets('save failure shows the could-not-save SnackBar',
        (tester) async {
      final store = FakeSettingsStore()..failNextSave = true;
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
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
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'myhost');
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
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'myhost');
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
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'https://evil.example');
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
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      expect(find.text('MCP token (optional)'), findsOneWidget);
      expect(find.text('voice-mcp bearer token (Phase 4)'), findsOneWidget);
    });

    testWidgets('MCP token field prefills from saved settings', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(
          host: 'myhost',
          mcpSecret: 'mcp-token',
        ),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      final mcpField = tester.widget<TextField>(find.byType(TextField).at(1));
      expect(mcpField.controller!.text, 'mcp-token');
    });

    testWidgets('save persists the MCP token', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        probe: probe,
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
      await tester.enterText(find.byType(TextField).at(1), 'mcp-token');
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
          mcpSecret: 'mcp-token',
        ),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Clear settings'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Clear settings'));
      await tester.pumpAndSettle();

      expect(find.text('Clear saved host, MCP token, files token, and storage URL?'), findsOneWidget);

      await tester.tap(find.text('Clear'));
      await tester.pumpAndSettle();

      expect(store.stored, isNull);
      expect(find.text('Settings cleared'), findsOneWidget);
    });

    testWidgets('Clear settings cancels without clearing', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
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

  group('environment section', () {
    testWidgets('defaults to the dev environment', (tester) async {
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      final segmented = tester.widget<SegmentedButton<BackendEnvironment>>(
        find.byType(SegmentedButton<BackendEnvironment>),
      );
      expect(segmented.selected, {BackendEnvironment.dev});
      expect(find.textContaining('http/https scheme'), findsOneWidget);
    });

    testWidgets('selecting Production saves it with the backend settings',
        (tester) async {
      final store = FakeSettingsStore();
      await tester.pumpWidget(settingsApp(tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Production'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
      await tester.pump();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
      expect(store.stored!.environment, BackendEnvironment.production);
      expect(store.stored!.host, 'tailscale.local');
    });
  });

  group('general section', () {
    testWidgets('changing the language persists to voice settings',
        (tester) async {
      final voiceStore = FakeVoiceSettingsStore();
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        voiceSettingsStore: voiceStore,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Language'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.byKey(const Key('settings-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Spanish').last);
      await tester.pumpAndSettle();

      expect(voiceStore.saved, isNotNull);
      expect(voiceStore.saved!.preferredLanguage, 'es');
    });

    testWidgets('changing the date format persists to prefs', (tester) async {
      final prefsStore = FakePrefsStore();
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        prefsStore: prefsStore,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Date format'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.byKey(const Key('settings-date-format')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('UK — DD/MM/YYYY').last);
      await tester.pumpAndSettle();

      expect(prefsStore.prefs.dateFormat, 'en-GB');
    });
  });

  group('account section', () {
    testWidgets('signed-out state shows Not signed in and the Sign in entry',
        (tester) async {
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Account'), 200,
          scrollable: find.byType(Scrollable).first);
      expect(find.text('Not signed in'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('signing in through AuthFlow persists a credential',
        (tester) async {
      final authStore = FakeAuthCredentialsStore();
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            AuthSession(token: 'tok-1', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'minted-key-1', id: 'key-id-1'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        authStore: authStore,
        authClient: authClient,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Sign in'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('auth-email')), 'user@example.com');
      await tester.enterText(find.byKey(const Key('auth-password')), 'secret123');
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      expect(authStore.stored, isNotNull);
      expect(authStore.stored!.apiKey, 'minted-key-1');
      expect(authStore.stored!.email, 'user@example.com');
      expect(authStore.stored!.keyId, 'key-id-1');
      expect(authStore.stored!.sessionToken, 'tok-1');
      expect(find.text('Signed in as user@example.com'), findsOneWidget);
    });

    testWidgets('signed-in state shows the account email', (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(apiKey: 'stored-key', email: 'a@b.com'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        authStore: authStore,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Signed in as a@b.com'), 200,
          scrollable: find.byType(Scrollable).first);
      expect(find.text('Signed in as a@b.com'), findsOneWidget);
      expect(find.text('Not signed in'), findsNothing);
    });

    testWidgets('Sign out revokes the old key then clears the store',
        (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'stored-key',
          email: 'a@b.com',
          keyId: 'key-9',
          sessionToken: 'tok-9',
        ),
      );
      final authClient = FakeAuthClient();
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        authStore: authStore,
        authClient: authClient,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Sign out'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();

      // Best-effort server cleanup ran before the local store was cleared:
      // the key was revoked with the stored session token, and the session
      // was signed out.
      expect(authClient.revokeCalls, [('tok-9', 'key-9')]);
      expect(authClient.signOutTokens, ['tok-9']);
      expect(authStore.stored, isNull);
      expect(find.text('Not signed in'), findsOneWidget);
    });

    testWidgets('Sign out still clears locally when revocation fails',
        (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'stored-key',
          email: 'a@b.com',
          keyId: 'key-9',
          sessionToken: 'tok-9',
        ),
      );
      final authClient = FakeAuthClient(
        onRevokeApiKey: (sessionToken, keyId) async =>
            throw const AuthNetworkError('unreachable'),
        onSignOut: (sessionToken) async =>
            throw const AuthNetworkError('unreachable'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        authStore: authStore,
        authClient: authClient,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Sign out'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();

      expect(authStore.stored, isNull);
      expect(find.text('Not signed in'), findsOneWidget);
      expect(find.text('Signed out'), findsOneWidget);
    });

    testWidgets('Rotate key mints a new key and revokes the old id',
        (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'old-key',
          email: 'a@b.com',
          keyId: 'old-key-id',
          sessionToken: 'old-session',
        ),
      );
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            AuthSession(token: 'tok-2', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'new-key-2', id: 'new-key-id-2'),
      );
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
        authStore: authStore,
        authClient: authClient,
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Rotate key'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Rotate key'));
      await tester.pumpAndSettle();

      // Re-auth form revealed with rotation guidance.
      expect(find.text('Sign in again to mint a new key.'), findsOneWidget);

      await tester.enterText(
          find.byKey(const Key('auth-email')), 'a@b.com');
      await tester.enterText(find.byKey(const Key('auth-password')), 'secret123');
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      // The fresh key replaced the old one, with a brief confirmation.
      expect(authStore.stored!.apiKey, 'new-key-2');
      expect(authStore.stored!.email, 'a@b.com');
      expect(authStore.stored!.keyId, 'new-key-id-2');
      expect(authStore.stored!.sessionToken, 'tok-2');
      expect(find.text('New API key minted'), findsOneWidget);

      // The superseded key was revoked with the NEW session token (which
      // belongs to the same account), and the old session was signed out.
      expect(authClient.revokeCalls, [('tok-2', 'old-key-id')]);
      expect(authClient.signOutTokens, ['old-session']);
    });
  });

  group('voice section', () {
    testWidgets('Voice entry opens the VoiceSettingsScreen', (tester) async {
      await tester.pumpWidget(settingsApp(tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Voice conversation settings'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Voice conversation settings'));
      await tester.pumpAndSettle();

      expect(find.byType(VoiceSettingsScreen), findsOneWidget);
    });
  });
}
