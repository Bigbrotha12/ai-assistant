import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/engine_config.dart';
import 'package:ai_assistant/features/voice/data/engine_manager.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/engine_registry.dart';
import 'package:ai_assistant/features/voice/data/stt_engine.dart';
import 'package:ai_assistant/features/voice/data/voice_settings.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_screen.dart';

import 'voice_test_fakes.dart';

/// Minimal STT engine exposing a configurable curated language list.
class _LangSttEngine implements SttEngine {
  _LangSttEngine(this.name, this.supportedLanguages);

  @override
  final String name;

  @override
  final List<({String code, String label})> supportedLanguages;

  @override
  String preferredLanguage = 'en';

  @override
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate}) =>
      Future.value('');
}

/// Fixed-status [VoiceEngineStatusNotifier] so a widget test can pin the
/// status map independently of the engine manager. [deleteModel] is faked to
/// drop the model from the map (the real deletion is covered by
/// `engine_manager_test.dart`).
class _FixedStatusNotifier extends VoiceEngineStatusNotifier {
  _FixedStatusNotifier(this.statuses);

  final Map<String, VoiceEngineStatus> statuses;

  @override
  Map<String, VoiceEngineStatus> build() => statuses;

  @override
  Future<void> deleteModel(String modelId) async {
    statuses.remove(modelId);
    state = Map<String, VoiceEngineStatus>.unmodifiable(statuses);
  }
}

void main() {
  late FakeVoiceSettingsStore store;

  setUp(() {
    // Two engines with different curated sets so the language dropdown can be
    // observed switching: stt_a offers fr, stt_b does not.
    EngineRegistry.instance
      ..registerSttEngine(
        'stt_a',
        _LangSttEngine('stt_a', [
          (code: 'en', label: 'English'),
          (code: 'fr', label: 'Français'),
        ]),
      )
      ..registerSttEngine(
        'stt_b',
        _LangSttEngine('stt_b', [
          (code: 'en', label: 'English'),
          (code: 'ja', label: '日本語'),
        ]),
      );
  });

  /// Pumps [VoiceSettingsScreen] on a tall viewport (all dropdowns visible)
  /// with the settings store seeded from [initial] and a faked engine manager.
  Future<void> pumpScreen(WidgetTester tester, {VoiceSettings? initial}) async {
    tester.view.physicalSize = const Size(800, 2200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    store = FakeVoiceSettingsStore(initial ?? const VoiceSettings());
    final container = ProviderContainer(
      overrides: [
        voiceSettingsStoreProvider.overrideWithValue(store),
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceSettingsScreen()),
      ),
    );
    // Let the async settings load land (initState reads loading → listener
    // repopulates from the store once the future completes).
    await tester.pumpAndSettle();
  }

  Finder dropdownAt(int index) => find.byType(DropdownButton<String>).at(index);

  Future<void> openDropdown(WidgetTester tester, int index) async {
    await tester.tap(dropdownAt(index));
    await tester.pumpAndSettle();
  }

  Future<void> closeDropdown(WidgetTester tester) async {
    await tester.tapAt(const Offset(8, 300));
    await tester.pumpAndSettle();
  }

  testWidgets('language dropdown options come from the selected engine, '
      'not the old hardcoded list', (tester) async {
    await pumpScreen(
      tester,
      initial: const VoiceSettings(sttEngine: 'stt_a', preferredLanguage: 'fr'),
    );

    // Closed dropdown shows the engine's human-readable label.
    expect(find.text('Français'), findsWidgets);

    // Dropdown #2 is the language field (0 = STT engine, 1 = TTS engine).
    await openDropdown(tester, 2);
    // The selected label appears on the closed button *and* as its menu item.
    expect(find.text('English'), findsOneWidget);
    expect(find.text('Français'), findsWidgets);
    // The old hardcoded entries are gone.
    expect(find.text('Spanish'), findsNothing);
    expect(find.text('Chinese'), findsNothing);
    expect(find.text('French'), findsNothing);
    await closeDropdown(tester);
  });

  testWidgets(
    'switching the STT engine updates the language list and falls back '
    'when the persisted language is unsupported',
    (tester) async {
      await pumpScreen(
        tester,
        initial: const VoiceSettings(
          sttEngine: 'stt_a',
          preferredLanguage: 'fr',
        ),
      );
      expect(find.text('Français'), findsWidgets);

      // Switch to an engine that does not support fr.
      await openDropdown(tester, 0);
      await tester.tap(find.text('stt_b').last);
      await tester.pumpAndSettle();

      // Deterministic fallback at switch time: en (present) over fr (lost).
      expect(find.text('English'), findsWidgets);
      expect(find.text('Français'), findsNothing);

      // The language list now reflects stt_b's curated set.
      await openDropdown(tester, 2);
      expect(find.text('English'), findsWidgets); // button + menu item
      expect(find.text('日本語'), findsOneWidget);
      expect(find.text('Français'), findsNothing);
      await closeDropdown(tester);

      // Persisting the engine switch saves the fallback, not the stale code.
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      expect(find.text('Voice settings saved'), findsOneWidget);
      expect(store.saved, isNotNull);
      expect(store.saved!.sttEngine, 'stt_b');
      expect(store.saved!.preferredLanguage, 'en');
    },
  );

  testWidgets('a persisted language unsupported by the selected engine renders '
      'the fallback immediately', (tester) async {
    await pumpScreen(
      tester,
      initial: const VoiceSettings(sttEngine: 'stt_a', preferredLanguage: 'zh'),
    );

    // zh is not in stt_a's set — the closed dropdown shows English right away.
    expect(find.text('English'), findsWidgets);
    expect(find.text('中文'), findsNothing);

    // Saving persists the resolved fallback.
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Voice settings saved'), findsOneWidget);
    expect(store.saved!.preferredLanguage, 'en');
    expect(store.saved!.sttEngine, 'stt_a');
  });

  testWidgets('a supported persisted language is kept on save', (tester) async {
    await pumpScreen(
      tester,
      initial: const VoiceSettings(sttEngine: 'stt_a', preferredLanguage: 'fr'),
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    // fr IS supported by stt_a — the choice must not be lost.
    expect(find.text('Voice settings saved'), findsOneWidget);
    expect(store.saved!.preferredLanguage, 'fr');
  });

  testWidgets('model download progress is attributed per model, never shared', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 2200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final progressController =
        StreamController<Map<String, double>>.broadcast();
    addTearDown(progressController.close);

    final container = ProviderContainer(
      overrides: [
        voiceSettingsStoreProvider.overrideWithValue(
          FakeVoiceSettingsStore(const VoiceSettings()),
        ),
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
        voiceEngineStatusProvider.overrideWith(
          () => _FixedStatusNotifier(const {
            EngineConfig.whisperTinyId: VoiceEngineStatus.downloading,
            EngineConfig.supertonic3Id: VoiceEngineStatus.downloading,
          }),
        ),
        modelDownloadProgressProvider.overrideWith(
          (ref) => progressController.stream,
        ),
      ],
    );
    addTearDown(container.dispose);

    // A determinate progress bar animates forever, so `pumpAndSettle` would
    // never settle; pump individual frames instead.
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceSettingsScreen()),
      ),
    );
    await tester.pump();
    await tester.pump();

    // Only Whisper has progress: its chip shows the percent, Supertonic's
    // chip must show its own (indeterminate) state — never STT's 42%.
    progressController.add(const {EngineConfig.whisperTinyId: 0.42});
    await tester.pump();
    expect(find.text('downloading 42%'), findsOneWidget);
    expect(find.text('downloading…'), findsOneWidget);
    final bars = tester
        .widgetList<LinearProgressIndicator>(
          find.byType(LinearProgressIndicator),
        )
        .toList();
    expect(bars.where((bar) => bar.value == 0.42), hasLength(1));

    // Supertonic's own files advance its own bar, leaving Whisper untouched.
    progressController.add(const {
      EngineConfig.whisperTinyId: 0.42,
      EngineConfig.supertonic3Id: 0.14,
    });
    await tester.pump();
    expect(find.text('downloading 42%'), findsOneWidget);
    expect(find.text('downloading 14%'), findsOneWidget);
    expect(find.text('downloading…'), findsNothing);

    // A later artifact keeps moving TTS forward without resetting to zero.
    progressController.add(const {
      EngineConfig.whisperTinyId: 0.42,
      EngineConfig.supertonic3Id: 0.57,
    });
    await tester.pump();
    expect(find.text('downloading 57%'), findsOneWidget);
    expect(find.text('downloading 42%'), findsOneWidget);
    expect(find.text('downloading 14%'), findsNothing);
  });

  testWidgets('a ready model offers Remove and deleting resets to notStarted', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 2200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        voiceSettingsStoreProvider.overrideWithValue(
          FakeVoiceSettingsStore(const VoiceSettings()),
        ),
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
        voiceEngineStatusProvider.overrideWith(
          () => _FixedStatusNotifier({
            EngineConfig.whisperTinyId: VoiceEngineStatus.ready,
            EngineConfig.supertonic3Id: VoiceEngineStatus.notStarted,
          }),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceSettingsScreen()),
      ),
    );
    await tester.pumpAndSettle();

    final remove = find.byKey(const ValueKey('remove-model-Whisper'));
    expect(remove, findsOneWidget);
    expect(
      find.byKey(const ValueKey('remove-model-Supertonic 3')),
      findsNothing,
    );

    // Cancel keeps the model.
    await tester.tap(remove);
    await tester.pumpAndSettle();
    expect(find.text('Remove Whisper model?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('remove-model-Whisper')), findsOneWidget);

    // Confirming removes it: the chip falls back to "not downloaded".
    await tester.tap(remove);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('remove-model-Whisper')), findsNothing);
    expect(find.text('not downloaded'), findsWidgets);
  });
}
