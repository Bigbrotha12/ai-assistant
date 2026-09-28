import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/app/theme.dart';
import 'package:ai_assistant/app/widgets/step_dots.dart';
import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_client_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/config.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/features/settings/data/prefs_store.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/features/onboarding/ui/onboarding_screen.dart';
import 'package:ai_assistant/features/voice/data/engine_manager.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/voice_settings.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';

import '../../fakes.dart';
import '../voice/voice_test_fakes.dart';

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
  const primary = Key('onboarding-primary');

  Widget onboardingApp({
    required FakeSettingsStore settings,
    required FakeAuthCredentialsStore auth,
    required FakePrefsStore prefs,
    required FakeAuthClient authClient,
    required FakeVoiceSettingsStore voiceSettings,
    required EngineManager engine,
  }) {
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(settings),
        authCredentialsStoreProvider.overrideWithValue(auth),
        appPrefsStoreProvider.overrideWithValue(prefs),
        authClientProvider.overrideWithValue(authClient),
        voiceSettingsStoreProvider.overrideWithValue(voiceSettings),
        engineManagerProvider.overrideWithValue(engine),
      ],
      child: const MaterialApp(home: OnboardingScreen()),
    );
  }

  /// Mounts [OnboardingScreen] with a fully faked provider graph. A tall
  /// viewport keeps every step's card content and the sticky action bar laid
  /// out without scrolling.
  Future<void> pumpOnboarding(
    WidgetTester tester, {
    FakeSettingsStore? settings,
    FakeAuthCredentialsStore? auth,
    FakePrefsStore? prefs,
    FakeAuthClient? authClient,
    FakeVoiceSettingsStore? voiceSettings,
    EngineManager? engine,
    Size size = const Size(800, 1800),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(onboardingApp(
      settings: settings ?? FakeSettingsStore(),
      auth: auth ?? FakeAuthCredentialsStore(),
      prefs: prefs ?? FakePrefsStore(),
      authClient: authClient ?? successfulAuthClient(),
      voiceSettings: voiceSettings ?? FakeVoiceSettingsStore(),
      engine: engine ?? FakeEngineManager(),
    ));
    await tester.pumpAndSettle();
  }

  /// The step the flow is currently showing, as the dot indicator reports it.
  int currentStep(WidgetTester tester) =>
      tester.widget<StepDots>(find.byType(StepDots)).index;

  /// Taps the sticky bar's single primary action.
  Future<void> tapPrimary(WidgetTester tester) async {
    await tester.tap(find.byKey(primary).hitTestable());
    await tester.pumpAndSettle();
  }

  /// Advances one step (Region -> Voice, Voice -> Finish).
  Future<void> tapNext(WidgetTester tester) => tapPrimary(tester);

  Future<void> tapBack(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(TextButton, 'Back').hitTestable());
    await tester.pumpAndSettle();
  }

  /// Fills the credentials form and fires the CTA. The Account step's primary
  /// action submits the form, so a successful sign-in advances to the Region
  /// step by itself.
  Future<void> signIn(WidgetTester tester) async {
    await tester.enterText(
        find.byKey(const Key('auth-email')), 'user@example.com');
    await tester.enterText(
        find.byKey(const Key('auth-password')), 'secret123');
    await tapPrimary(tester);
  }

  /// Signs in, then walks Region -> Voice -> Finish.
  Future<void> completeFlow(WidgetTester tester) async {
    await signIn(tester);
    await tapNext(tester); // Region → Voice
    await tapNext(tester); // Voice → Finish
  }

  /// Signs in, then walks Region -> Voice.
  Future<void> completeFlowToVoice(WidgetTester tester) async {
    await signIn(tester);
    await tapNext(tester); // Region → Voice
  }

  group('step defaults and gating', () {
    testWidgets('language is pre-filled from the device locale', (tester) async {
      await pumpOnboarding(tester);

      expect(currentStep(tester), 0);
      expect(find.text('STEP 1 OF 4'), findsOneWidget);

      // Region is not built until it is first shown (a PageView only builds
      // the page it needs), so walk to it before reading the dropdown.
      await signIn(tester);
      expect(find.text('STEP 2 OF 4'), findsOneWidget);

      final language = tester.widget<DropdownButton<String>>(
          find.byKey(const Key('ob-language')));
      expect(language.value, 'en');

      // Onboarding no longer asks for a date format: nothing renders dates
      // from the stored locale yet, so the picker was collecting a preference
      // for behaviour that does not exist. The override stays in Settings.
      expect(find.byKey(const Key('ob-date-format')), findsNothing);
      expect(find.text('Date format'), findsNothing);
    });

    testWidgets('the inferred date format is still persisted', (tester) async {
      // Dropping the picker must not drop the value: Settings seeds its
      // override from prefs, and a migration-friendly stored value is cheaper
      // than re-deriving it.
      final prefsStore = FakePrefsStore();
      final settingsStore = FakeSettingsStore();
      await pumpOnboarding(
        tester,
        prefs: prefsStore,
        settings: settingsStore,
        auth: FakeAuthCredentialsStore(
          stored: const AuthCredentials(apiKey: 'k', email: 'a@b.com'),
        ),
      );
      await completeFlow(tester);
      await tapPrimary(tester);

      expect(prefsStore.prefs.dateFormat, isNotEmpty);
      expect(prefsStore.prefs.onboardingComplete, isTrue);
    });

    testWidgets('entered state survives Back and Next', (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester);
      expect(currentStep(tester), 1);

      await tester.tap(find.byKey(const Key('ob-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Spanish').last);
      await tester.pumpAndSettle();

      await tapBack(tester); // → Account
      expect(currentStep(tester), 0);
      expect(find.text('STEP 1 OF 4'), findsOneWidget);
      final email = tester.widget<TextField>(find.byKey(const Key('auth-email')));
      expect(email.controller!.text, 'user@example.com');

      await tapNext(tester); // → Region again
      final language = tester.widget<DropdownButton<String>>(
          find.byKey(const Key('ob-language')));
      expect(language.value, 'es');
    });
  });

  group('card-per-step layout', () {
    testWidgets('the dot indicator tracks the visible step', (tester) async {
      await pumpOnboarding(tester);

      final dots = find.byType(StepDots);
      expect(dots, findsOneWidget);
      expect(tester.widget<StepDots>(dots).count, 4);

      await signIn(tester);
      expect(tester.widget<StepDots>(dots).index, 1);
      await tapNext(tester);
      expect(tester.widget<StepDots>(dots).index, 2);
      await tapNext(tester);
      expect(tester.widget<StepDots>(dots).index, 3);
    });

    testWidgets('only one step card is visible at a time', (tester) async {
      await pumpOnboarding(tester);

      // The Region step's fields are not in the tree while Account is showing.
      expect(find.byKey(const Key('ob-language')), findsNothing);

      await signIn(tester);
      expect(find.byKey(const Key('ob-language')), findsOneWidget);
      // ...and the Account form is gone once Region is showing.
      expect(find.byKey(const Key('auth-email')), findsNothing);
    });

    testWidgets('the primary action is inset from the screen edges',
        (tester) async {
      // Regression guard: the old vertical Stepper rendered its controls in a
      // bare Row with no padding, so buttons sat flush against the edge.
      await pumpOnboarding(tester);

      final button = tester.getRect(find.byKey(primary));
      expect(button.left, greaterThanOrEqualTo(AppSpacing.lg));
      expect(button.right, lessThanOrEqualTo(800 - AppSpacing.lg));
    });

    testWidgets('the sticky bar clears the card above it', (tester) async {
      await pumpOnboarding(tester);

      // The action bar is the last thing in the column; assert there is real
      // space between the card's bottom edge and the top of the button.
      final card = tester.getRect(find.byType(Card).last);
      final button = tester.getRect(find.byKey(primary));
      expect(button.top - card.bottom, greaterThanOrEqualTo(AppSpacing.lg));
    });

    testWidgets('the Account step shows exactly one filled primary button',
        (tester) async {
      // Two stacked filled buttons read as competing primaries, so AuthFlow's
      // own submit is suppressed in favour of the sticky CTA.
      await pumpOnboarding(tester);

      expect(find.byKey(const Key('auth-submit')), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
    });

    testWidgets('dots are tappable backwards but cannot skip ahead',
        (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester);
      await tapNext(tester);
      expect(currentStep(tester), 2);

      // Forward taps are refused: the flow must not jump past a step.
      final dots = find.byType(StepDots);
      tester.widget<StepDots>(dots).onDotTapped!(3);
      await tester.pumpAndSettle();
      expect(currentStep(tester), 2);

      // Backward taps are allowed.
      tester.widget<StepDots>(dots).onDotTapped!(0);
      await tester.pumpAndSettle();
      expect(currentStep(tester), 0);
    });

    testWidgets('swiping does not change step', (tester) async {
      await pumpOnboarding(tester);

      // The cards host a keyboard, a SegmentedButton and dropdowns; a
      // horizontal drag must not fight them.
      final view = find.byType(PageView);
      expect(
          tester.widget<PageView>(view).physics, isA<NeverScrollableScrollPhysics>());

      await tester.drag(view, const Offset(-400, 0));
      await tester.pumpAndSettle();
      expect(currentStep(tester), 0);
    });

    testWidgets('every step lays out on a small phone', (tester) async {
      // A RenderFlex overflow is reported through FlutterError, so simply
      // walking the flow at a realistic size fails this test if any step's
      // card, dots or action bar cannot fit. The other tests use a very tall
      // viewport, which would hide exactly this.
      //
      // A stored key lets the CTA advance straight away, so this measures
      // layout rather than re-testing the auth gate.
      await pumpOnboarding(
        tester,
        size: const Size(390, 844),
        auth: FakeAuthCredentialsStore(
          stored: const AuthCredentials(apiKey: 'k', email: 'a@b.com'),
        ),
      );

      for (final expected in const [
        'STEP 1 OF 4',
        'STEP 2 OF 4',
        'STEP 3 OF 4',
        'STEP 4 OF 4',
      ]) {
        expect(find.text(expected), findsOneWidget);
        await tester.tap(find.byKey(primary).hitTestable());
        await tester.pumpAndSettle();
      }
    });
  });

  group('account step', () {
    testWidgets('create-account mints and stores the key, then advances',
        (tester) async {
      final authStore = FakeAuthCredentialsStore();
      final authClient = FakeAuthClient(
        onSignUp: (name, email, password) async =>
            AuthSession(token: 'tok-2', email: email),
        onMintApiKey: (token) async =>
            const MintedApiKey(key: 'minted-key-2', id: 'minted-key-id-2'),
      );
      await pumpOnboarding(tester, auth: authStore, authClient: authClient);

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
      await tapPrimary(tester);

      expect(authStore.stored, isNotNull);
      expect(authStore.stored!.apiKey, 'minted-key-2');
      expect(authStore.stored!.email, 'ada@example.com');
      expect(authStore.stored!.keyId, 'minted-key-id-2');
      expect(authStore.stored!.sessionToken, 'tok-2');

      // The CTA drove the submit, so success is what moved us on.
      expect(currentStep(tester), 1);
    });

    testWidgets('tapping the CTA with empty fields validates without a key',
        (tester) async {
      final authStore = FakeAuthCredentialsStore();
      await pumpOnboarding(tester, auth: authStore);

      // The CTA stays enabled (it submits); an empty submit is rejected
      // in-place rather than advancing.
      expect(tester.widget<FilledButton>(find.byKey(primary)).onPressed,
          isNotNull);
      await tapPrimary(tester);

      expect(find.text('Enter your email and password'), findsOneWidget);
      expect(authStore.stored, isNull);
      expect(currentStep(tester), 0);
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
      await tapPrimary(tester);

      expect(find.text('Incorrect email or password'), findsOneWidget);
      expect(authStore.stored, isNull);
      expect(currentStep(tester), 0);
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

      await signIn(tester); // → Region
      // Pick a non-default language so the persisted value is observable.
      await tester.tap(find.byKey(const Key('ob-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Spanish').last);
      await tester.pumpAndSettle();
      await tapNext(tester); // → Voice
      await tapNext(tester); // → Finish

      expect(find.widgetWithText(FilledButton, 'Get started'), findsOneWidget);
      await tapPrimary(tester);

      expect(log, ['voice', 'prefs', 'settings']);
      expect(voiceStore.saved!.preferredLanguage, 'es');
      expect(prefsStore.prefs.dateFormat, isNotEmpty);
      expect(prefsStore.prefs.onboardingComplete, isTrue);
      expect(settingsStore.stored, isNotNull);
      expect(settingsStore.stored!.host, BackendConfig.defaultHost);
      expect(settingsStore.stored!.environment, BackendConfig.defaultEnvironment);
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

      await tapPrimary(tester); // Get started

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
    testWidgets('a stored key starts at the Account step (re-entry removed)',
        (tester) async {
      final authStore = FakeAuthCredentialsStore(
        stored: const AuthCredentials(apiKey: 'stored-key', email: 'a@b.com'),
      );
      final settingsStore = FakeSettingsStore();
      await pumpOnboarding(tester, auth: authStore, settings: settingsStore);

      // With the Backend step removed, a stored key no longer re-enters at
      // step 1 — the flow starts at Account (step 0).
      expect(currentStep(tester), 0);

      // But the account is pre-marked ready, so the CTA advances immediately
      // rather than re-submitting the form.
      await tapNext(tester); // Account → Region
      expect(currentStep(tester), 1);
      await tapNext(tester); // Region → Voice
      await tapNext(tester); // Voice → Finish
      await tapPrimary(tester); // Get started

      expect(settingsStore.stored, isNotNull);
      expect(settingsStore.stored!.host, BackendConfig.defaultHost);
      expect(settingsStore.stored!.environment, BackendConfig.defaultEnvironment);
    });
  });

  group('voice & models step', () {
    testWidgets('Next continues without downloading', (tester) async {
      final engine = _TrackingEngineManager();
      await pumpOnboarding(tester, engine: engine);
      await completeFlowToVoice(tester);

      // End-user labels, not model names: the engine jargon belongs in Voice
      // settings. Text to speech is a real, downloadable model on this build
      // (verified URLs configured), so it renders as not-yet-downloaded.
      expect(find.text('Speech to text'), findsOneWidget);
      expect(find.text('Text to speech'), findsOneWidget);
      expect(find.text('not downloaded').hitTestable(), findsOneWidget);
      expect(find.text('Whisper tiny'), findsNothing);
      expect(find.text('Supertonic 3'), findsNothing);

      // The old "Do it later" button duplicated the primary action, so the CTA
      // is the single way forward and it downloads nothing.
      expect(find.text('Do it later'), findsNothing);
      await tapNext(tester);

      expect(currentStep(tester), 3);
      expect(engine.downloadCalls, 0);
    });
  });

  group('finish step gating', () {
    testWidgets('an unauthenticated flow cannot reach the finish step',
        (tester) async {
      // Regression guard for "Get started does nothing": finishing requires an
      // account, because the startup gate only treats the app as configured
      // when a stored API key *and* a stored host are both present. There is no
      // path past step 0 without one.
      final settingsStore = FakeSettingsStore();
      await pumpOnboarding(
        tester,
        settings: settingsStore,
        auth: FakeAuthCredentialsStore(),
        authClient: FakeAuthClient(
          onSignIn: (email, password) async =>
              throw const AuthInvalidCredentials('bad'),
        ),
      );

      await tester.enterText(
          find.byKey(const Key('auth-email')), 'nobody@example.com');
      await tester.enterText(
          find.byKey(const Key('auth-password')), 'wrong-password');
      await tapPrimary(tester);

      // The CTA submits rather than advancing, and the rejection is visible.
      expect(currentStep(tester), 0);
      expect(find.text('Incorrect email or password'), findsOneWidget);

      // Forward dot taps are refused too, so the finish step is unreachable.
      final dots = find.byType(StepDots);
      tester.widget<StepDots>(dots).onDotTapped!(3);
      await tester.pumpAndSettle();
      expect(currentStep(tester), 0);
      expect(find.text('STEP 1 OF 4'), findsOneWidget);

      // Nothing was written.
      expect(settingsStore.stored, isNull);
    });

    testWidgets('the blocked-finish prompt only appears without an account',
        (tester) async {
      // With a stored key the flow completes normally, so the blocked-finish
      // prompt must never show.
      final settingsStore = FakeSettingsStore();
      await pumpOnboarding(
        tester,
        settings: settingsStore,
        auth: FakeAuthCredentialsStore(
          stored: const AuthCredentials(apiKey: 'k', email: 'a@b.com'),
        ),
      );
      await completeFlow(tester);
      await tapPrimary(tester);

      expect(settingsStore.stored, isNotNull);
      expect(find.text('Sign in to finish setting up the app.'), findsNothing);
      expect(find.text('Could not save your setup'), findsNothing);
    });
  });

  group('secrets', () {
    testWidgets('MCP and files tokens are not present in the onboarding flow',
        (tester) async {
      await pumpOnboarding(tester);
      await signIn(tester); // → Region
      // No Backend step means no secret fields exist in the tree.
      expect(find.byKey(const Key('ob-mcp')), findsNothing);
      expect(find.byKey(const Key('ob-files')), findsNothing);
    });
  });
}
