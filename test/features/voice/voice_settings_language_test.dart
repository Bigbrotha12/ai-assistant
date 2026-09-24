import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/engine_registry.dart';
import 'package:ai_assistant/features/voice/data/stt_engine.dart';
import 'package:ai_assistant/features/voice/data/voice_settings.dart';

/// Minimal [SttEngine] with a configurable language list.
class _Engine implements SttEngine {
  _Engine({this.supportedLanguages = kBaseSttSupportedLanguages});

  @override
  String get name => 'lang_test_engine';

  @override
  final List<({String code, String label})> supportedLanguages;

  @override
  String preferredLanguage = 'en';

  @override
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate}) =>
      Future.value('');
}

void main() {
  group('resolveSttLanguage', () {
    test('keeps a supported persisted code (never loses the choice)', () {
      final supported = kBaseSttSupportedLanguages;
      expect(resolveSttLanguage('en', supported), 'en');
    });

    test('falls back to en when the persisted code is unsupported', () {
      final supported = [
        (code: 'en', label: 'English'),
        (code: 'ja', label: '日本語'),
      ];
      expect(resolveSttLanguage('xx', supported), 'en');
      expect(resolveSttLanguage('fr', supported), 'en');
    });

    test("falls back to the engine's first entry when en is unsupported", () {
      final supported = [
        (code: 'ja', label: '日本語'),
        (code: 'ko', label: '한국어'),
      ];
      expect(resolveSttLanguage('xx', supported), 'ja');
    });

    test('returns en for an empty supported list', () {
      expect(resolveSttLanguage('fr', const []), 'en');
    });
  });

  group('applyVoiceSettingsToEngines', () {
    // EngineRegistry exposes a singleton, so each test registers under its
    // own id (registering the same id silently replaces, but unique ids keep
    // the tests independent of one another).
    test('supported persisted code is pushed through unchanged', () {
      final engine = _Engine(
        supportedLanguages: [
          (code: 'en', label: 'English'),
          (code: 'fr', label: 'Français'),
        ],
      );
      EngineRegistry.instance.registerSttEngine('lang_supported', engine);

      applyVoiceSettingsToEngines(
        const VoiceSettings(
          sttEngine: 'lang_supported',
          preferredLanguage: 'fr',
        ),
      );

      expect(engine.preferredLanguage, 'fr');
    });

    test('unsupported persisted code falls back to en before the push', () {
      final engine = _Engine(
        supportedLanguages: [
          (code: 'en', label: 'English'),
          (code: 'ja', label: '日本語'),
        ],
      );
      EngineRegistry.instance.registerSttEngine('lang_unsupported', engine);

      applyVoiceSettingsToEngines(
        const VoiceSettings(
          sttEngine: 'lang_unsupported',
          preferredLanguage: 'zh',
        ),
      );

      expect(engine.preferredLanguage, 'en');
    });

    test('unregistered engine id is a no-op (no throw)', () {
      expect(
        () => applyVoiceSettingsToEngines(
          const VoiceSettings(
            sttEngine: 'lang_missing_engine',
            preferredLanguage: 'fr',
          ),
        ),
        returnsNormally,
      );
    });
  });
}
