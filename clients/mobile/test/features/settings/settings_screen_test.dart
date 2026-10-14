import 'dart:convert';
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
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/memory/data/memory_model.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/settings/data/account_export.dart';
import 'package:ai_assistant/features/settings/ui/settings_screen.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_screen.dart';
import 'package:drift/native.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;
import '../voice/voice_test_fakes.dart';

/// [FileCache] fake that performs no disk IO, recording eviction calls.
class FakeFileCache extends FileCache {
  FakeFileCache({super.scopeKey = 'test-scope'})
    : super(cacheDir: Directory.systemTemp);

  int evictExpiredCalls = 0;
  int evictAllForScopeCalls = 0;
  final List<String> evictedScopes = [];

  /// When true, [evictAllForScope] throws (simulates an unwritable cache dir).
  bool failEvictAll = false;

  @override
  Future<void> evictExpired() async {
    evictExpiredCalls++;
  }

  @override
  Future<void> evictAllForScope(String targetScope) async {
    if (targetScope != scopeKey) {
      throw StateError('File cache scope mismatch');
    }
    if (failEvictAll) {
      throw StateError('cache unavailable');
    }
    evictAllForScopeCalls++;
    evictedScopes.add(targetScope);
  }

  @override
  Future<Map<String, FileInfo>> getAllCached() async => const {};
}

/// Seeded scoped credentials matching the settings screen's default origin
/// (`localhost:17600`) so AccountLifecycle's clearLocal registrations run.
AuthCredentials scopedCredentials({
  String sessionToken = 'sess-9',
  String ownerId = 'owner-1',
}) => AuthCredentials(
  apiKey: 'stored-key',
  email: 'a@b.com',
  keyId: 'key-9',
  sessionToken: sessionToken,
  ownerId: ownerId,
  backendOrigin: 'http://localhost:17600',
);

void main() {

  /// The backend form lives inside the collapsed "Advanced" tile. Tests that
  /// touch a field or read probe rows must expand it first (idempotent).
  Future<void> expandAdvanced(WidgetTester tester) async {
    if (tester.any(find.byKey(const Key('settings-host')))) return;
    await tester.scrollUntilVisible(
      find.byKey(const Key('settings-advanced')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const Key('settings-advanced')));
    await tester.pumpAndSettle();
  }

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
    FakeFileStore? filesStore,
    FakeMemoryStore? memoryStore,
    FakeChatStore? chatStore,
    AccountExporter? exporter,
    ManagedConversationRepository? managedRepo,
    PluginCredentialsStore? pluginStore,
  }) {
    // The Advanced tile and the later sections (Files & data, danger zone)
    // can exceed the viewport; a tall test screen keeps most of them built
    // — ListView builds children lazily, so off-screen widgets are absent.
    tester.view.physicalSize = const Size(800, 2200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final db = AppDatabase(NativeDatabase.memory());
    addTearDown(db.close);
    final defaultExporter = AccountExporter(
      writeEncoded: (_) async => '/tmp/ai-assistant-export.json',
    );
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(store),
        backendProbeProvider.overrideWithValue(probe ?? FakeProbe()),
        filesServiceProvider.overrideWithValue(filesClient),
        filesStoreProvider.overrideWithValue(filesStore ?? FakeFileStore()),
        fileCacheProvider.overrideWithValue(fileCache),
        authCredentialsStoreProvider.overrideWithValue(
          authStore ?? FakeAuthCredentialsStore(),
        ),
        authClientProvider.overrideWithValue(authClient ?? FakeAuthClient()),
        appPrefsStoreProvider.overrideWithValue(prefsStore ?? FakePrefsStore()),
        voiceSettingsStoreProvider.overrideWithValue(
          voiceSettingsStore ?? FakeVoiceSettingsStore(),
        ),
        memoryStoreProvider.overrideWithValue(memoryStore ?? FakeMemoryStore()),
        chatStoreProvider.overrideWithValue(chatStore ?? FakeChatStore()),
        accountExporterProvider.overrideWithValue(exporter ?? defaultExporter),
        managedConversationRepositoryProvider.overrideWithValue(
          managedRepo ?? ManagedConversationRepository(db),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(
          pluginStore ??
              PluginCredentialsStore(storage: InMemorySecureStorage()),
        ),
      ],
      child: const MaterialApp(home: SettingsScreen()),
    );
  }

  testWidgets('files token field prefills from saved settings', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', filesSecret: 'files-token'),
    );
    await tester.pumpWidget(
      settingsApp(
        tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ),
    );
    await tester.pumpAndSettle();

    await expandAdvanced(tester);
      final filesField = tester.widget<TextField>(
          find.byKey(const Key('settings-files-token')));
    expect(filesField.controller!.text, 'files-token');
  });

  testWidgets('save persists the files token', (tester) async {
    final store = FakeSettingsStore();
    await tester.pumpWidget(
      settingsApp(
        tester,
        store: store,
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ),
    );
    await tester.pumpAndSettle();

    await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'tailscale.local');
    await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-files-token')), 'files-token');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNotNull);
    expect(store.stored!.host, 'tailscale.local');
    expect(store.stored!.filesSecret, 'files-token');
  });

  testWidgets('shows Files service not configured for a no-op client', (
    tester,
  ) async {
    await tester.pumpWidget(
      settingsApp(
        tester,
        store: FakeSettingsStore(),
        filesClient: NoOpFilesClient(),
        fileCache: FakeFileCache(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Files service not configured'), findsOneWidget);
    expect(find.text('Files service connected'), findsNothing);
  });

  testWidgets('shows Files service connected for a configured client', (
    tester,
  ) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(host: 'myhost', filesSecret: 'files-token'),
    );
    await tester.pumpWidget(
      settingsApp(
        tester,
        store: store,
        filesClient: FakeFilesClient(),
        fileCache: FakeFileCache(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Files service connected'), findsOneWidget);
    expect(find.text('Files service not configured'), findsNothing);
  });

  testWidgets(
    'Clear Cache confirms, evicts expired files, and shows a SnackBar',
    (tester) async {
      final cache = FakeFileCache();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: cache,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Clear Cache'));
      await tester.tap(find.text('Clear Cache'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Clear'));
      await tester.pumpAndSettle();

      expect(cache.evictExpiredCalls, 1);
      expect(find.text('Cache cleared'), findsOneWidget);
    },
  );

  testWidgets('File Browser button pushes the FilesScreen', (tester) async {
    await tester.pumpWidget(
      settingsApp(
        tester,
        store: FakeSettingsStore(),
        filesClient: FakeFilesClient(),
        fileCache: FakeFileCache(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('File Browser'));
    await tester.tap(find.text('File Browser'));
    await tester.pumpAndSettle();

    expect(find.byType(FilesScreen), findsOneWidget);
  });

  group('backend & probe', () {
    testWidgets('app title and settings fields render', (tester) async {
      final probe = FakeProbe();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      // App bar wordmark + About footer both carry the name.
      expect(find.text('Voice Assist'), findsWidgets);
      await expandAdvanced(tester);
      expect(find.text('Backend host'), findsOneWidget);
      expect(probe.calls, 0);
    });

    testWidgets('prefills the form from saved settings', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      final hostField = tester.widget<TextField>(
          find.byKey(const Key('settings-host')));
      expect(hostField.controller!.text, 'myhost');
    });

    testWidgets('save persists settings and shows a SnackBar', (tester) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'tailscale.local');
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
        status: const BackendStatus(
          checks: [
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
          ],
        ),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'myhost');
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

    testWidgets('an unverified-email probe result shows the resend card', (
      tester,
    ) async {
      final probe = FakeProbe(
        status: const BackendStatus(
          checks: [
            CheckResult(
              check: BackendCheck.auth,
              status: ProbeStatus.emailNotVerified,
              detail: 'verify your email (403)',
            ),
          ],
        ),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'myhost');
      await tester.tap(find.text('Test connection'));
      await tester.pumpAndSettle();

      // The card renders outside the collapsed probe ExpansionTile, so no
      // expansion is needed. The stored credentials carry no email in this
      // fixture, so the card falls back to asking for the address.
      expect(find.text('Verify your email'), findsOneWidget);
      expect(find.byKey(const Key('verify-email-resend')), findsOneWidget);
    });

    testWidgets('probe failure resets busy state and leaves retry usable', (
      tester,
    ) async {
      final probe = FakeProbe(failure: StateError('probe-secret-error'));
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'myhost');
      await tester.tap(find.text('Test connection'));
      await tester.pumpAndSettle();

      final testButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Test connection'),
      );
      expect(testButton.onPressed, isNotNull);
      expect(
        find.text('Some backend services are unavailable'),
        findsOneWidget,
      );
      expect(find.text('probe-secret-error'), findsNothing);

      probe.failure = null;
      await tester.tap(find.text('Test connection'));
      await tester.pumpAndSettle();
      expect(probe.calls, 2);
    });

    testWidgets('auto-probes valid saved settings once on load', (
      tester,
    ) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      final probe = FakeProbe(
        status: const BackendStatus(
          checks: [
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
          ],
        ),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      expect(probe.calls, 1);
      expect(probe.lastSettings, const BackendSettings(host: 'myhost'));
    });

    testWidgets('Save and Test are enabled with a valid host alone', (
      tester,
    ) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'tailscale.local');
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

    testWidgets('save failure shows the could-not-save SnackBar', (
      tester,
    ) async {
      final store = FakeSettingsStore()..failNextSave = true;
      final probe = FakeProbe();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'tailscale.local');
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
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'myhost');
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
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'myhost');
      await tester.pump();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
      expect(probe.calls, 1);
      await tester.pumpAndSettle();
      expect(probe.calls, 1);
    });

    testWidgets('host validation disables the buttons and shows an error', (
      tester,
    ) async {
      final store = FakeSettingsStore();
      final probe = FakeProbe();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          probe: probe,
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.enterText(
        find.byKey(const Key('settings-host')),
        'https://evil.example',
      );
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


    testWidgets('Clear settings shows a dialog and clears on confirm', (
      tester,
    ) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost', mcpSecret: 'mcp-token'),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Clear settings'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Clear settings'));
      await tester.pumpAndSettle();

      expect(
        find.text('Clear saved host, files token, and storage URL?'),
        findsOneWidget,
      );

      await tester.tap(find.text('Clear'));
      await tester.pumpAndSettle();

      expect(store.stored, isNull);
      expect(find.text('Settings cleared'), findsOneWidget);
    });

    testWidgets('Clear settings cancels without clearing', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Clear settings'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Clear settings'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
    });
  });

  group('environment section', () {
    testWidgets('defaults to the dev environment', (tester) async {
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      final segmented = tester.widget<SegmentedButton<BackendEnvironment>>(
        find.byType(SegmentedButton<BackendEnvironment>),
      );
      expect(segmented.selected, {BackendEnvironment.dev});
      expect(find.textContaining('http/https scheme'), findsOneWidget);
    });

    testWidgets('selecting Production saves it with the backend settings', (
      tester,
    ) async {
      final store = FakeSettingsStore();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: store,
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await expandAdvanced(tester);
      await tester.tap(find.text('Production'));
      await tester.pump();
      await tester.enterText(
          find.byKey(const Key('settings-host')), 'tailscale.local');
      await tester.pump();

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(store.stored, isNotNull);
      expect(store.stored!.environment, BackendEnvironment.production);
      expect(store.stored!.host, 'tailscale.local');
    });
  });

  group('general section', () {
    testWidgets('changing the language persists to voice settings', (
      tester,
    ) async {
      final voiceStore = FakeVoiceSettingsStore();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          voiceSettingsStore: voiceStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Language'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Spanish').last);
      await tester.pumpAndSettle();

      expect(voiceStore.saved, isNotNull);
      expect(voiceStore.saved!.preferredLanguage, 'es');
    });

    testWidgets('changing the date format persists to prefs', (tester) async {
      final prefsStore = FakePrefsStore();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          prefsStore: prefsStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Date format'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-date-format')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('UK — DD/MM/YYYY').last);
      await tester.pumpAndSettle();

      expect(prefsStore.prefs.dateFormat, 'en-GB');
    });
  });

  group('account section', () {
    testWidgets('signed-out state shows Not signed in and the Sign in entry', (
      tester,
    ) async {
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Account'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Not signed in'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('signing in through AuthFlow persists a credential', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore();
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            AuthSession(token: 'tok-1', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'minted-key-1', id: 'key-id-1'),
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Sign in'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('auth-email')),
        'user@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'secret123',
      );
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
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Signed in as a@b.com'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Signed in as a@b.com'), findsOneWidget);
      expect(find.text('Not signed in'), findsNothing);
    });

    testWidgets('Sign out revokes the old key then clears the store', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'stored-key',
          email: 'a@b.com',
          keyId: 'key-9',
          sessionToken: 'tok-9',
        ),
      );
      final authClient = FakeAuthClient();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Sign out'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
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

    testWidgets('Sign out still clears locally when revocation fails', (
      tester,
    ) async {
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
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Sign out'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Sign out'));
      await tester.pumpAndSettle();

      expect(authStore.stored, isNull);
      expect(find.text('Not signed in'), findsOneWidget);
      expect(find.text('Signed out'), findsOneWidget);
    });

    testWidgets('Rotate key mints a new key and revokes the old id', (
      tester,
    ) async {
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
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Rotate key'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Rotate key'));
      await tester.pumpAndSettle();

      // Re-auth form revealed with rotation guidance.
      expect(find.text('Sign in again to mint a new key.'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('auth-email')), 'a@b.com');
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      // The fresh key replaced the old one, with a brief confirmation.
      expect(authStore.stored!.apiKey, 'new-key-2');
      expect(authStore.stored!.email, 'a@b.com');
      expect(authStore.stored!.keyId, 'new-key-id-2');
      expect(authStore.stored!.sessionToken, 'tok-2');
      expect(authStore.stored!.mintedAt, isNotNull);
      expect(
        DateTime.now().difference(authStore.stored!.mintedAt!),
        lessThan(const Duration(minutes: 1)),
      );
      expect(find.text('New API key minted'), findsOneWidget);

      // The superseded key was revoked with the NEW session token (which
      // belongs to the same account), and the old session was signed out.
      expect(authClient.revokeCalls, [('tok-2', 'old-key-id')]);
      expect(authClient.signOutTokens, ['old-session']);
    });

    testWidgets('Rotate key resolves and revokes a legacy single active key', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'legacy-old-key',
          email: 'a@b.com',
          sessionToken: 'old-session',
        ),
      );
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            AuthSession(token: 'tok-2', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'new-key-2', id: 'new-key-id-2'),
        onListApiKeys: (token) async => [
          ApiKeyListEntry(
            id: 'legacy-old-id',
            enabled: true,
            createdAt: DateTime.now().subtract(const Duration(days: 1)),
          ),
        ],
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Rotate key'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Rotate key'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-email')), 'a@b.com');
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      expect(authStore.stored!.apiKey, 'new-key-2');
      expect(authStore.stored!.mintedAt, isNotNull);
      expect(authClient.listApiKeysRequests, ['tok-2']);
      expect(authClient.revokeCalls, [('tok-2', 'legacy-old-id')]);
      expect(authClient.signOutTokens, ['old-session']);
      expect(find.text('New API key minted'), findsOneWidget);
    });

    testWidgets('Rotate key warns without revoking an ambiguous legacy key', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(
          apiKey: 'legacy-ambiguous-key',
          email: 'a@b.com',
          sessionToken: 'old-session',
        ),
      );
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            AuthSession(token: 'tok-2', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'new-key-2', id: 'new-key-id-2'),
        onListApiKeys: (token) async => [
          ApiKeyListEntry(
            id: 'active-a',
            start: 'sk_a',
            enabled: true,
            createdAt: DateTime.now().subtract(const Duration(days: 1)),
          ),
          ApiKeyListEntry(
            id: 'active-b',
            start: 'sk_b',
            enabled: true,
            createdAt: DateTime.now().subtract(const Duration(days: 2)),
          ),
        ],
      );
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Rotate key'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Rotate key'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-email')), 'a@b.com');
      await tester.enterText(
        find.byKey(const Key('auth-password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      expect(authStore.stored!.apiKey, 'new-key-2');
      expect(authClient.listApiKeysRequests, ['tok-2']);
      expect(authClient.revokeCalls, isEmpty);
      expect(authClient.signOutTokens, ['old-session']);
      expect(
        find.text(
          'New API key minted, but the old key could not be identified or '
          'revoked.',
        ),
        findsOneWidget,
      );
    });
  });

  group('export my data', () {
    testWidgets('writes conversations JSON with toolCalls and shows the path', (
      tester,
    ) async {
      String? written;
      final exporter = AccountExporter(
        writeEncoded: (encoded) async {
          written = encoded;
          return '/exports/ai-assistant-export_test.json';
        },
      );
      final chatStore = FakeChatStore(
        initial: [
          Conversation(
            id: 'c1',
            title: 'Hello',
            createdAt: DateTime(2024),
            updatedAt: DateTime(2024),
            messages: const [
              Message(id: 'm1', role: MessageRole.user, content: 'hi'),
              Message(
                id: 'm2',
                role: MessageRole.assistant,
                content: '',
                toolCalls: [
                  ToolCall(
                    id: 't1',
                    name: 'get_weather',
                    args: {'city': 'Oslo'},
                    result: 'sunny',
                  ),
                ],
              ),
            ],
          ),
        ],
      );
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          chatStore: chatStore,
          exporter: exporter,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-export-data')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-export-data')));
      await tester.pumpAndSettle();

      expect(written, isNotNull);
      final doc = jsonDecode(written!) as Map<String, dynamic>;
      expect(doc['exportedAt'], isA<String>());
      expect(doc['backendOrigin'], 'http://localhost:17600');
      expect(doc['userId'], 'owner-1');
      final conversations = doc['conversations'] as List<dynamic>;
      expect(conversations, hasLength(1));
      final messages = conversations.first['messages'] as List<dynamic>;
      final toolCalls = messages[1]['toolCalls'] as List<dynamic>;
      expect(toolCalls.first['name'], 'get_weather');
      expect(toolCalls.first['args'], {'city': 'Oslo'});

      expect(
        find.text('Export saved to /exports/ai-assistant-export_test.json'),
        findsOneWidget,
      );
    });

    testWidgets('export failure shows the could-not-export SnackBar', (
      tester,
    ) async {
      final exporter = AccountExporter(
        writeEncoded: (_) async => throw StateError('disk full'),
      );
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          exporter: exporter,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-export-data')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-export-data')));
      await tester.pumpAndSettle();

      expect(find.text('Could not export conversations'), findsOneWidget);
    });
  });

  group('delete account', () {
    testWidgets('wrong password keeps the dialog open and store intact', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      final authClient = FakeAuthClient(
        onDeleteAccount: (sessionToken, password) async =>
            throw const AuthInvalidCredentials(
              'Invalid password',
              statusCode: 400,
              code: 'INVALID_PASSWORD',
            ),
      );
      final filesStore = FakeFileStore();
      final memoryStore = FakeMemoryStore();
      final fileCache = FakeFileCache();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: fileCache,
          authStore: authStore,
          authClient: authClient,
          filesStore: filesStore,
          memoryStore: memoryStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-delete-account')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-delete-account')));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Only this account’s conversations, attachments, memories, and '
          'cached files are removed. Data belonging to other accounts on '
          'this device is kept.',
        ),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const Key('delete-account-password')),
        'wrong-password',
      );
      await tester.tap(find.byKey(const Key('delete-account-submit')));
      await tester.pumpAndSettle();

      // Inline rejection: dialog stays open for a retry.
      expect(find.text('Incorrect password'), findsOneWidget);
      expect(find.byKey(const Key('delete-account-password')), findsOneWidget);
      expect(authClient.deleteAccountCalls, [('sess-9', 'wrong-password')]);
      // Fail-closed: local wipe never ran.
      expect(authStore.stored, isNotNull);
      expect(filesStore.deleteAllCalls, 0);
      expect(memoryStore.deleteAllCalls, 0);
      expect(fileCache.evictAllForScopeCalls, 0);
    });

    testWidgets('success wipes files, memories, cache, and credentials', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      final authClient = FakeAuthClient(
        onDeleteAccount: (sessionToken, password) async {},
      );
      final scope = scopedCredentials().accountScope!;
      final filesStore = FakeFileStore(scopeKey: scope.storageId);
      final memoryStore = FakeMemoryStore(
        scopeKey: scope.storageId,
        initial: [
          Memory(
            id: 'mem-1',
            content: 'remember me',
            createdAt: DateTime(2024),
            updatedAt: DateTime(2024),
          ),
        ],
      );
      final fileCache = FakeFileCache(scopeKey: scope.storageId);
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: fileCache,
          authStore: authStore,
          authClient: authClient,
          filesStore: filesStore,
          memoryStore: memoryStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-delete-account')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-delete-account')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('delete-account-password')),
        'correct-horse',
      );
      await tester.tap(find.byKey(const Key('delete-account-submit')));
      await tester.pumpAndSettle();

      expect(authClient.deleteAccountCalls, [('sess-9', 'correct-horse')]);
      expect(filesStore.deleteAllCalls, 1);
      expect(memoryStore.deleteAllCalls, 1);
      expect(fileCache.evictAllForScopeCalls, 1);
      expect(filesStore.deletedScopes, [scope.storageId]);
      expect(memoryStore.deletedScopes, [scope.storageId]);
      expect(fileCache.evictedScopes, [scope.storageId]);
      expect(authStore.stored, isNull);
      expect(find.text('Account deleted'), findsOneWidget);
      expect(find.text('Not signed in'), findsOneWidget);
    });

    testWidgets('network failure keeps local data and reports the failure', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      final authClient = FakeAuthClient(
        onDeleteAccount: (sessionToken, password) async =>
            throw const AuthNetworkError('unreachable'),
      );
      final filesStore = FakeFileStore();
      final memoryStore = FakeMemoryStore();
      final fileCache = FakeFileCache();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: fileCache,
          authStore: authStore,
          authClient: authClient,
          filesStore: filesStore,
          memoryStore: memoryStore,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-delete-account')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-delete-account')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('delete-account-password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('delete-account-submit')));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Could not reach the server. The account was not deleted — try again.',
        ),
        findsOneWidget,
      );
      // Fail-closed: nothing local was destroyed.
      expect(authStore.stored, isNotNull);
      expect(filesStore.deleteAllCalls, 0);
      expect(memoryStore.deleteAllCalls, 0);
      expect(fileCache.evictAllForScopeCalls, 0);
    });

    testWidgets('empty password shows an inline error without a request', (
      tester,
    ) async {
      final authStore = FakeAuthCredentialsStore(stored: scopedCredentials());
      final authClient = FakeAuthClient();
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
          authStore: authStore,
          authClient: authClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-delete-account')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('settings-delete-account')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('delete-account-submit')));
      await tester.pumpAndSettle();

      expect(find.text('Enter your password'), findsOneWidget);
      expect(authClient.deleteAccountCalls, isEmpty);
      expect(authStore.stored, isNotNull);
    });

    testWidgets('signed-out state hides the Delete account button', (
      tester,
    ) async {
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Clear settings'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Delete account'), findsNothing);
      expect(find.byKey(const Key('settings-delete-account')), findsNothing);
    });
  });

  group('voice section', () {
    testWidgets('Voice entry opens the VoiceSettingsScreen', (tester) async {
      await tester.pumpWidget(
        settingsApp(
          tester,
          store: FakeSettingsStore(),
          filesClient: NoOpFilesClient(),
          fileCache: FakeFileCache(),
        ),
      );
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
