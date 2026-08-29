import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/auth_client.dart';
import 'package:ai_assistant/core/auth_client_provider.dart';
import 'package:ai_assistant/core/auth_credentials_providers.dart';
import 'package:ai_assistant/core/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/config.dart';
import 'package:ai_assistant/core/prefs_providers.dart';
import 'package:ai_assistant/core/prefs_store.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/onboarding/onboarding_screen.dart';
import 'package:ai_assistant/features/voice/engine_manager.dart';
import 'package:ai_assistant/features/voice/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/voice_settings.dart';
import 'package:ai_assistant/features/voice/voice_settings_providers.dart';

import 'fakes.dart';
import 'features/voice/voice_test_fakes.dart';

/// A [FakeAuthClient] whose sign-in and key-mint succeed.
FakeAuthClient successfulAuthClient() => FakeAuthClient(
      onSignIn: (email, password) async =>
          AuthSession(token: 'tok-signin', email: email),
      onMintApiKey: (token) async =>
          const MintedApiKey(key: 'minted-key', id: 'minted-key-id'),
    );

/// Engine manager double that records [ensureModelsDownloaded] calls.
class _TrackingEngineManager extends FakeEngineManager {
  int downloadCalls = 0;

  @override
  Future<bool> ensureModelsDownloaded({
    void Function(String modelId)? progress,
  }) async {
    downloadCalls++;
    return super.ensureModelsDownloaded(progress: progress);
  }
}

/// Records the order of `save` calls across the three finish-step stores.
class _RecordingVoiceStore extends FakeVoiceSettingsStore {
  _RecordingVoiceStore(this.log);

  final List<String> log;

  @override
  Future<void> save(VoiceSettings settings) async {
    log.add('voice');
    await super.save(settings);
  }
}

class _RecordingPrefsStore extends FakePrefsStore {
  _RecordingPrefsStore(this.log);

  final List<String> log;

  @override
  Future<void> save(AppPrefs value) async {
    log.add('prefs');
    await super.save(value);
  }
}

class _RecordingSettingsStore extends FakeSettingsStore {
  _RecordingSettingsStore(this.log);

  final List<String> log;

  @override
  Future<void> save(BackendSettings settings) async {
    log.add('settings');
    await super.save(settings);
  }
}

void main() {
  Widget onboardingApp({
    required FakeSettingsStore settings,
    required FakeAuthCredentialsStore auth,
    required FakePrefsStore prefs,
    required FakeAuthClient authClient,
    required FakeProbe probe,
    required FakeVoiceSettingsStore voiceSettings,
    required EngineManager engine,
  }) {
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(settings),
        authCredentialsStoreProvider.overrideWithValue(auth),
        appPrefsStoreProvider.overrideWithValue(prefs),
        authClientProvider.overrideWithValue(authClient),
        backendProbeProvider.overrideWithValue(probe),
        voiceSettingsStoreProvider.overrideWithValue(voiceSettings),
        engineManagerProvider.overrideWithValue(engine),
      ],
      child: const MaterialApp(home: OnboardingScreen()),
    );
  }

  /// Mounts [OnboardingScreen] with a fully faked provider graph. A tall
  /// viewport keeps every step's content and the Next/Back controls laid out.
  Future<void> pumpOnboarding(
    WidgetTester tester, {
    FakeSettingsStore? settings,
    FakeAuthCredentialsStore? auth,
    FakePrefsStore? prefs,
    FakeAuthClient? authClient,
    FakeProbe? probe,
    FakeVoiceSettingsStore? voiceSettings,
    EngineManager? engine,
  }) async {
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(onboardingApp(
      settings: settings ?? FakeSettingsStore(),
      auth: auth ?? FakeAuthCredentialsStore(),
      prefs: prefs ?? FakePrefsStore(),
      authClient: authClient ?? successfulAuthClient(),
      probe: probe ?? FakeProbe(),
      voiceSettings: voiceSettings ?? FakeVoiceSettingsStore(),
      engine: engine ?? FakeEngineManager(),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> tapNext(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, 'Next').hitTestable());
    await tester.pumpAndSettle();
  }

  Future<void> tapBack(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(TextButton, 'Back').hitTestable());
    await tester.pumpAndSettle();
  }

  Future<void> signIn(WidgetTester tester) async {
    await tester.enterText(
        find.byKey(const Key('auth-email')), 'user@example.com');
    await tester.enterText(
        find.byKey(const Key('auth-password')), 'secret123');
    await tester.tap(find.byKey(const Key('auth-submit')));
    await tester.pumpAndSettle();
  }

  Future<void> completeFlow(WidgetTester tester) async {
    await signIn(tester);
    await tapNext(tester); // Account → Backend
    await tapNext(tester); // Backend → Region
    await tapNext(tester); // Region → Voice
    await tapNext(tester); // Voice → Finish
  }

  Future<void> completeFlowToVoice(WidgetTester tester) async {
    await signIn(tester);
    await tapNext(tester); // Account → Backend
    await tapNext(tester); // Backend → Region
    await tapNext(tester); // Region → Voice
  }

  group('step defaults and gating', () {
    testWidgets('defaults are pre-filled (host, env, language, date)',
        (tester) async {
      await pumpOnboarding(tester);

      final host = tester.widget<TextField>(find.byKey(const Key('ob-host')));
      expect(host.controller!.text, BackendConfig.defaultHost);

      final stepper = tester.widget<Stepper>(find.byType(Stepper));
      expect(stepper.currentStep, 0);

      final language = tester.widget<DropdownButton<String>>(
          find.byKey(const Key('ob-language')));
      expect(language.value, 'en');

      final dateFormat = tester.widget<DropdownButton<String>>(
          find.byKey(const Key('ob-date-format')));
      expect(dateFormat.value, 'en-US');
    });

    testWidgets('probe failure is advisory and does not block Next',
        (tester) async {
      final probe = FakeProbe(
        status: const BackendStatus(checks: [
          CheckResult(
              check: BackendCheck.auth,
              status: ProbeStatus.error,
              detail: 'unreachable'),
          CheckResult(
              check: BackendCheck.inference,
              status: ProbeStatus.error,
              detail: 'unreachable'),
          CheckResult(
              check: BackendCheck.vision,
              status: ProbeStatus.error,
              detail: 'unreachable'),
        ]),
      );
      await pumpOnboarding(tester, probe: probe);
      await signIn(tester);
      await tapNext(tester); // → Backend (auto-probe fires)

      // No re-auth affordance for a plain failure.
      expect(find.text('Re-authenticate').hitTestable(), findsNothing);

      // Next stays enabled: only structural validity gates it.
      final next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNotNull);
      expect(probe.calls, 1);

      await tapNext(tester); // still advances
      expect(tester.widget<Stepper>(find.byType(Stepper)).currentStep, 2);
    });

    testWidgets('probe 401 shows the re-authenticate affordance',
        (tester) async {
      final probe = FakeProbe(
        status: const BackendStatus(checks: [
          CheckResult(
              check: BackendCheck.auth,
              status: ProbeStatus.unauthorized,
              detail: 'API key rejected (401)'),
          CheckResult(
              check: BackendCheck.inference,
              status: ProbeStatus.unauthorized,
              detail: 'API key rejected (401)'),
          CheckResult(
              check: BackendCheck.vision,
              status: ProbeStatus.unauthorized,
              detail: 'API key rejected (401)'),
        ]),
      );
      await pumpOnboarding(tester, probe: probe);
      await signIn(tester);
      await tapNext(tester); // → Backend

      expect(find.text('Re-authenticate').hitTestable(), findsOneWidget);

      await tester.tap(find.text('Re-authenticate').hitTestable());
      await tester.pumpAndSettle();

      // Back to Account; Next is re-gated until a fresh key is minted.
      expect(tester.widget<Stepper>(find.byType(Stepper)).currentStep, 0);
      final next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNull);
    });

    testWidgets('host validation gates Next structurally', (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester);
      await tapNext(tester); // → Backend

      await tester.enterText(
          find.byKey(const Key('ob-host')), 'https://evil.example');
      await tester.pump();

      // Unique to the Backend step, so no hit-test scoping is needed.
      expect(find.text('Enter a host name, not a URL'), findsOneWidget);
      final next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNull);
    });

    testWidgets('entered state survives Back and Next', (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester);
      await tapNext(tester); // → Backend

      await tester.enterText(find.byKey(const Key('ob-host')), 'my.tailnet');
      await tester.pump();

      await tapBack(tester); // → Account
      expect(tester.widget<Stepper>(find.byType(Stepper)).currentStep, 0);
      final email = tester.widget<TextField>(find.byKey(const Key('auth-email')));
      expect(email.controller!.text, 'user@example.com');

      await tapNext(tester); // → Backend again
      final host = tester.widget<TextField>(find.byKey(const Key('ob-host')));
      expect(host.controller!.text, 'my.tailnet');
    });
  });

  group('account step', () {
    testWidgets('create-account mints and stores the key; Next gated until then',
        (tester) async {
      final authStore = FakeAuthCredentialsStore();
      final authClient = FakeAuthClient(
        onSignUp: (name, email, password) async =>
            AuthSession(token: 'tok-2', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'minted-key-2', id: 'minted-key-id-2'),
      );
      await pumpOnboarding(tester, auth: authStore, authClient: authClient);

      // Next disabled until the key is minted and stored.
      var next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNull);

      await tester.tap(find.descendant(
        of: find.byType(SegmentedButton<bool>),
        matching: find.text('Create account'),
      ));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('auth-name')), 'Ada');
      await tester.enterText(
          find.byKey(const Key('auth-email')), 'ada@example.com');
      await tester.enterText(
          find.byKey(const Key('auth-password')), 'pw-123456');
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      expect(authStore.stored, isNotNull);
      expect(authStore.stored!.apiKey, 'minted-key-2');
      expect(authStore.stored!.email, 'ada@example.com');
      expect(authStore.stored!.keyId, 'minted-key-id-2');
      expect(authStore.stored!.sessionToken, 'tok-2');

      next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNotNull);
    });

    testWidgets('auth failure shows an error and stores no key',
        (tester) async {
      final authStore = FakeAuthCredentialsStore();
      final authClient = FakeAuthClient(
        onSignIn: (email, password) async =>
            throw const AuthInvalidCredentials('bad'),
      );
      await pumpOnboarding(tester, auth: authStore, authClient: authClient);

      await tester.enterText(
          find.byKey(const Key('auth-email')), 'user@example.com');
      await tester.enterText(find.byKey(const Key('auth-password')), 'wrong');
      await tester.tap(find.byKey(const Key('auth-submit')));
      await tester.pumpAndSettle();

      expect(find.text('Incorrect email or password'), findsOneWidget);
      expect(authStore.stored, isNull);
      final next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNull);
    });
  });

  group('finish step persistence', () {
    testWidgets('Get started writes voice settings, prefs, then backend last',
        (tester) async {
      final log = <String>[];
      final voiceStore = _RecordingVoiceStore(log);
      final prefsStore = _RecordingPrefsStore(log);
      final settingsStore = _RecordingSettingsStore(log);
      await pumpOnboarding(
        tester,
        settings: settingsStore,
        auth: FakeAuthCredentialsStore(),
        prefs: prefsStore,
        voiceSettings: voiceStore,
      );

      await signIn(tester);
      await tapNext(tester); // → Backend
      await tapNext(tester); // → Region
      // Pick a non-default language so the persisted value is observable.
      await tester.tap(find.byKey(const Key('ob-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Spanish').last);
      await tester.pumpAndSettle();
      await tapNext(tester); // → Voice
      await tapNext(tester); // → Finish

      await tester
          .tap(find.widgetWithText(FilledButton, 'Get started').hitTestable());
      await tester.pumpAndSettle();

      expect(log, ['voice', 'prefs', 'settings']);
      expect(voiceStore.saved!.preferredLanguage, 'es');
      expect(prefsStore.prefs.dateFormat, isNotEmpty);
      expect(prefsStore.prefs.onboardingComplete, isTrue);
      expect(settingsStore.stored, isNotNull);
      expect(settingsStore.stored!.host, BackendConfig.defaultHost);
      expect(settingsStore.stored!.environment, BackendEnvironment.dev);
    });

    testWidgets('a mid-sequence failure keeps the user in onboarding with Retry',
        (tester) async {
      final settingsStore = FakeSettingsStore();
      final prefsStore = FakePrefsStore()..failNextSave = true;
      await pumpOnboarding(
        tester,
        settings: settingsStore,
        prefs: prefsStore,
      );
      await completeFlow(tester);

      await tester
          .tap(find.widgetWithText(FilledButton, 'Get started').hitTestable());
      await tester.pumpAndSettle();

      // Backend was never written and the user stays in onboarding.
      expect(settingsStore.stored, isNull);
      expect(find.byType(OnboardingScreen), findsOneWidget);
      expect(find.textContaining('Could not save your setup'), findsOneWidget);
      expect(find.text('Retry').hitTestable(), findsOneWidget);

      // Retry re-runs the idempotent writes to completion.
      await tester.tap(find.text('Retry').hitTestable());
      await tester.pumpAndSettle();

      expect(settingsStore.stored, isNotNull);
      expect(prefsStore.prefs.onboardingComplete, isTrue);
    });
  });

  group('partial-finish entry', () {
    testWidgets('a stored key with no host re-enters at the Backend step',
        (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(apiKey: 'stored-key', email: 'a@b.com'),
      );
      final settingsStore = FakeSettingsStore();
      await pumpOnboarding(tester, auth: authStore, settings: settingsStore);

      expect(tester.widget<Stepper>(find.byType(Stepper)).currentStep, 1);
      // Host prefilled from the effective defaults — structurally valid, so
      // the partial finish can proceed without re-entering the host.
      final host = tester.widget<TextField>(find.byKey(const Key('ob-host')));
      expect(host.controller!.text, BackendConfig.defaultHost);
      final next = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Next').hitTestable());
      expect(next.onPressed, isNotNull);

      // Completing from the re-entry point persists the backend settings
      // last, which is what flips the gate to "configured".
      await tapNext(tester); // Backend → Region
      await tapNext(tester); // Region → Voice
      await tapNext(tester); // Voice → Finish
      await tester
          .tap(find.widgetWithText(FilledButton, 'Get started').hitTestable());
      await tester.pumpAndSettle();

      expect(settingsStore.stored, isNotNull);
      expect(settingsStore.stored!.host, BackendConfig.defaultHost);
      expect(settingsStore.stored!.environment, BackendEnvironment.dev);
    });
  });

  group('voice & models step', () {
    testWidgets('Do it later continues without downloading', (tester) async {
      final engine = _TrackingEngineManager();
      await pumpOnboarding(tester, engine: engine);
      await completeFlowToVoice(tester);

      // Kokoro is surfaced as unavailable on this build.
      expect(find.text('Kokoro 82M').hitTestable(), findsOneWidget);
      expect(find.text('unavailable').hitTestable(), findsOneWidget);

      await tester.tap(find.text('Do it later').hitTestable());
      await tester.pumpAndSettle();

      expect(tester.widget<Stepper>(find.byType(Stepper)).currentStep, 4);
      expect(engine.downloadCalls, 0);
    });
  });

  group('secrets', () {
    testWidgets('MCP and files tokens are obscured', (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester);
      await tapNext(tester); // → Backend
      // The advanced fields only exist in the tree once expanded.
      await tester.tap(find.text('Advanced').hitTestable());
      await tester.pumpAndSettle();

      final mcp = tester.widget<TextField>(find.byKey(const Key('ob-mcp')));
      expect(mcp.obscureText, isTrue);
      final files = tester.widget<TextField>(find.byKey(const Key('ob-files')));
      expect(files.obscureText, isTrue);
    });
  });
}