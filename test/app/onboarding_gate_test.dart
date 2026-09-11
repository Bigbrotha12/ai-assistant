import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/features/settings/data/prefs_store.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_store.dart';
import 'package:ai_assistant/app/theme_providers.dart';
import 'package:ai_assistant/app/widgets/speak_button.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/onboarding/ui/onboarding_screen.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:ai_assistant/app/widgets/launcher_shortcuts.dart';
import 'package:ai_assistant/main.dart';

import '../fakes.dart';
import '../features/voice/voice_test_fakes.dart';

/// Settings store whose [load] never completes (drives the splash state).
class _HangingSettingsStore implements SettingsStore {
  final Completer<BackendSettings?> completer = Completer<BackendSettings?>();

  @override
  Future<BackendSettings?> load() => completer.future;

  @override
  Future<void> save(BackendSettings settings) async {}

  @override
  Future<void> clear() async {}
}

/// Auth store whose [load] throws once, then recovers, with a clear counter.
class _FlakyAuthStore extends FakeAuthCredentialsStore {
  _FlakyAuthStore({super.stored, this.failFirstLoad = false});

  bool failFirstLoad;
  int clearCalls = 0;

  @override
  Future<AuthCredentials?> load() async {
    if (failFirstLoad) {
      failFirstLoad = false;
      throw StateError('storage unavailable');
    }
    return stored;
  }

  @override
  Future<void> clear() async {
    clearCalls++;
    await super.clear();
  }
}

/// Settings store whose [load] throws once, then recovers.
class _FlakySettingsStore extends FakeSettingsStore {
  _FlakySettingsStore({super.stored, this.failFirstLoad = false});

  /// When true, the next [load] throws; cleared after the throw.
  bool failFirstLoad;

  /// Number of [clear] calls (the gate must never call it on this path).
  int clearCalls = 0;

  @override
  Future<BackendSettings?> load() async {
    if (failFirstLoad) {
      failFirstLoad = false;
      throw StateError('storage unavailable');
    }
    return stored;
  }

  @override
  Future<void> clear() async {
    clearCalls++;
    await super.clear();
  }
}

/// Auth store with a [clear] call counter (the gate must never call it).
class _CountingAuthStore extends FakeAuthCredentialsStore {
  _CountingAuthStore({super.stored});

  int clearCalls = 0;

  @override
  Future<void> clear() async {
    clearCalls++;
    await super.clear();
  }
}

void main() {
  /// Boots the real [AiAssistantApp] (theme + paper builder + [OnboardingGate])
  /// with a fully faked provider graph. The voice home is reachable, so every
  /// voice service is faked exactly as in `test/widget_test.dart`.
  Widget gateApp({
    required SettingsStore settingsStore,
    required AuthCredentialsStore authStore,
    AppPrefsStore? prefsStore,
  }) {
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(settingsStore),
        authCredentialsStoreProvider.overrideWithValue(authStore),
        appPrefsStoreProvider.overrideWithValue(prefsStore ?? FakePrefsStore()),
        appTierStoreProvider.overrideWithValue(FakeAppTierStore()),
        backendProbeProvider.overrideWithValue(FakeProbe()),
        chatStoreProvider.overrideWithValue(FakeChatStore()),
        chatApiClientProvider.overrideWithValue(FakeChatClient()),
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
        micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
        audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
        audioSessionManagerProvider
            .overrideWithValue(FakeAudioSessionManager()),
        vadProcessorProvider.overrideWithValue(FakeVadProcessor()),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
      ],
      child: const AiAssistantApp(),
    );
  }

  const apiKey = AuthCredentials(apiKey: 'test-key');
  const validHost = BackendSettings(host: 'myhost');
  const blankHost = BackendSettings(host: '');

  /// Bounded pump: VoiceScreen keeps idle animations running (the speak
  /// button's breathing pulse repeats forever), so `pumpAndSettle` would time
  /// out while it is mounted. Fixed-duration pumps settle providers and route
  /// transitions without waiting for an idle frame.
  Future<void> pumpGate(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  group('OnboardingGate splash', () {
    testWidgets('loading shows the branded splash', (tester) async {
      final store = _HangingSettingsStore();
      addTearDown(() => store.completer.complete(null));
      await tester.pumpWidget(gateApp(
        settingsStore: store,
        authStore: FakeAuthCredentialsStore(),
      ));
      await tester.pump();

      expect(find.text('Voice Assist'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byType(SpeakButton), findsNothing);
      expect(find.byType(OnboardingScreen), findsNothing);
    });
  });

  group('OnboardingGate not configured', () {
    testWidgets('no API key routes to onboarding even with a valid host',
        (tester) async {
      await tester.pumpWidget(gateApp(
        settingsStore: FakeSettingsStore(stored: validHost),
        authStore: FakeAuthCredentialsStore(),
      ));
      await pumpGate(tester);

      expect(find.byType(OnboardingScreen), findsOneWidget);
      // The first Stepper step title is a stable marker for the real flow.
      expect(find.text('Account'), findsOneWidget);
      expect(find.byType(SpeakButton), findsNothing);
    });

    testWidgets('API key but no usable host routes to onboarding',
        (tester) async {
      // "Configured" requires an explicitly stored, valid host: a blank host
      // (or no store at all) never counts, even though the compile-time
      // default host is non-blank in tests.
      await tester.pumpWidget(gateApp(
        settingsStore: FakeSettingsStore(stored: blankHost),
        authStore: FakeAuthCredentialsStore(stored: apiKey),
      ));
      await pumpGate(tester);

      expect(find.byType(OnboardingScreen), findsOneWidget);
      expect(find.text('Account'), findsOneWidget);
      expect(find.byType(SpeakButton), findsNothing);
    });
  });

  group('OnboardingGate configured', () {
    testWidgets('stored settings + key route to the voice home', (tester) async {
      await tester.pumpWidget(gateApp(
        settingsStore: FakeSettingsStore(stored: validHost),
        authStore: FakeAuthCredentialsStore(stored: apiKey),
      ));
      await pumpGate(tester);

      expect(find.byType(SpeakButton), findsOneWidget);
      expect(find.byType(OnboardingScreen), findsNothing);
    });

    testWidgets('key without stored settings routes to onboarding',
        (tester) async {
      // dart-define defaults alone do NOT count as configured: an explicitly
      // stored host is required, so a define-only build (no stored settings)
      // is still guided through onboarding (which prefills the defaults).
      await tester.pumpWidget(gateApp(
        settingsStore: FakeSettingsStore(),
        authStore: FakeAuthCredentialsStore(stored: apiKey),
      ));
      await pumpGate(tester);

      expect(find.byType(OnboardingScreen), findsOneWidget);
      expect(find.text('Account'), findsOneWidget);
      expect(find.byType(SpeakButton), findsNothing);
      // The unconfigured banner only renders on the voice/chat homes, never
      // on the onboarding screen.
      expect(find.text('Backend not configured'), findsNothing);
    });
  });

  group('launcher shortcut routing', () {
    // The gate forwards the resolved target (see OnboardingGate): `open_chat`
    // must land on ChatScreen, everything else on the voice home. `targetForUri`
    // is a pure function and fully unit-testable; the end-to-end path through
    // `resolveInitialTarget` reads the engine-static `PlatformDispatcher.instance`
    // (`initialRoute`), which cannot be swapped in widget tests, so the widget
    // layer above only covers the voice default.
    test('open_chat maps to the chat target', () {
      expect(targetForUri('aiassistant://open_chat'), LauncherShortcutTarget.chat);
    });

    test('open_voice maps to the voice target', () {
      expect(
        targetForUri('aiassistant://open_voice'),
        LauncherShortcutTarget.voice,
      );
    });

    test('unknown, empty, or malformed URIs map to null', () {
      expect(targetForUri(null), isNull);
      expect(targetForUri('aiassistant://bogus'), isNull);
      expect(targetForUri('https://example.com'), isNull);
      expect(targetForUri(''), isNull);
      expect(targetForUri('  aiassistant://open_chat  '),
          LauncherShortcutTarget.chat);
    });
  });

  group('OnboardingGate AsyncError', () {
    testWidgets('read failure shows the error card and Retry recovers without '
        'wiping stores', (tester) async {
      final settingsStore = _FlakySettingsStore(
        stored: validHost,
        failFirstLoad: true,
      );
      final authStore = _CountingAuthStore(stored: apiKey);
      await tester.pumpWidget(gateApp(
        settingsStore: settingsStore,
        authStore: authStore,
      ));
      await pumpGate(tester);

      // A read failure must never be treated as "not configured".
      expect(find.text('Could not read your saved setup'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byType(OnboardingScreen), findsNothing);
      expect(find.byType(SpeakButton), findsNothing);

      // No store was wiped on the error path.
      expect(settingsStore.clearCalls, 0);
      expect(authStore.clearCalls, 0);
      expect(settingsStore.stored, validHost);

      // Retry re-reads the failed provider; the store recovers → voice home.
      await tester.tap(find.text('Retry'));
      await pumpGate(tester);

      expect(find.byType(SpeakButton), findsOneWidget);
      expect(find.byType(OnboardingScreen), findsNothing);
      expect(settingsStore.clearCalls, 0);
      expect(authStore.clearCalls, 0);
      expect(settingsStore.stored, validHost);
    });

    testWidgets('an auth-store read failure recovers to onboarding (no wipe)',
        (tester) async {
      // The auth store fails on load but has no stored key once recovered, so
      // retry lands on onboarding rather than a home screen — and never wipes.
      final authStore = _FlakyAuthStore(stored: null, failFirstLoad: true);
      await tester.pumpWidget(gateApp(
        settingsStore: FakeSettingsStore(stored: validHost),
        authStore: authStore,
      ));
      await pumpGate(tester);

      expect(find.text('Could not read your saved setup'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(authStore.clearCalls, 0);

      await tester.tap(find.text('Retry'));
      await pumpGate(tester);

      expect(find.byType(OnboardingScreen), findsOneWidget);
      expect(authStore.clearCalls, 0);
    });
  });
}