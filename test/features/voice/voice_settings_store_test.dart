import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/voice_settings.dart';
import 'package:ai_assistant/features/voice/voice_settings_store.dart';

/// In-memory [FlutterSecureStorage] double (see settings_store_test.dart for
/// the same pattern) so the store never touches a platform channel.
class InMemorySecureStorage extends FlutterSecureStorage {
  final Map<String, String> _values = {};

  Map<String, String> get values => Map.unmodifiable(_values);

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }
}

void main() {
  late InMemorySecureStorage storage;
  late SecureVoiceSettingsStore store;

  setUp(() {
    storage = InMemorySecureStorage();
    store = SecureVoiceSettingsStore(storage: storage);
  });

  test('load returns null when nothing has been saved', () async {
    expect(await store.load(), isNull);
  });

  test('save then load round-trips settings', () async {
    const settings = VoiceSettings(
      sttEngine: 'whisper_tiny',
      ttsEngine: 'supertonic_3',
      vadSensitivity: 0.75,
      preferredLanguage: 'en',
    );

    await store.save(settings);
    final loaded = await store.load();

    expect(loaded, settings);
  });

  test('stored kokoro_82m ttsEngine migrates to supertonic_3', () async {
    // Simulates settings saved before the TTS engine swap.
    await storage.write(key: 'voice_stt_engine', value: 'whisper_tiny');
    await storage.write(key: 'voice_tts_engine', value: 'kokoro_82m');

    final loaded = await store.load();

    expect(loaded, isNotNull);
    expect(loaded!.ttsEngine, 'supertonic_3');
    expect(loaded.sttEngine, 'whisper_tiny');
  });

  test('unknown stored ttsEngine ids pass through unmigrated', () async {
    await storage.write(key: 'voice_tts_engine', value: 'some_future_engine');

    final loaded = await store.load();

    expect(loaded, isNotNull);
    expect(loaded!.ttsEngine, 'some_future_engine');
  });

  test('load falls back to defaults for partial saves', () async {
    // Simulates a save interrupted after the STT key only.
    await storage.write(key: 'voice_stt_engine', value: 'whisper_tiny');

    final loaded = await store.load();
    final defaults = VoiceSettings();

    expect(
      loaded,
      VoiceSettings(
        sttEngine: 'whisper_tiny',
        ttsEngine: defaults.ttsEngine,
        vadSensitivity: defaults.vadSensitivity,
        preferredLanguage: defaults.preferredLanguage,
      ),
    );
  });

  test('clear removes every voice key', () async {
    await store.save(const VoiceSettings(vadSensitivity: 0.3));
    await store.clear();

    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
  });

  test('visionEnabled key round-trips', () async {
    await store.save(const VoiceSettings(visionEnabled: false));
    final loaded = await store.load();
    expect(loaded, isNotNull);
    expect(loaded!.visionEnabled, false);

    await store.save(const VoiceSettings(visionEnabled: true));
    final loaded2 = await store.load();
    expect(loaded2!.visionEnabled, true);
  });

  test('minTurnSeconds parses from string', () async {
    await storage.write(key: 'voice_stt_engine', value: 'whisper_tiny');
    await storage.write(key: 'voice_min_turn_seconds', value: '1.5');

    final loaded = await store.load();
    expect(loaded, isNotNull);
    expect(loaded!.minTurnSeconds, 1.5);
  });

  test('vadSensitivity parses from string', () async {
    await storage.write(key: 'voice_stt_engine', value: 'whisper_tiny');
    await storage.write(key: 'voice_vad_sensitivity', value: '0.8');

    final loaded = await store.load();
    expect(loaded, isNotNull);
    expect(loaded!.vadSensitivity, 0.8);
  });

  test('clear removes all 6 keys', () async {
    await store.save(const VoiceSettings(
      sttEngine: 'test_stt',
      ttsEngine: 'test_tts',
      vadSensitivity: 0.9,
      preferredLanguage: 'fr',
      minTurnSeconds: 1.0,
      visionEnabled: false,
    ));

    final allKeys = const [
      'voice_stt_engine',
      'voice_tts_engine',
      'voice_vad_sensitivity',
      'voice_language',
      'voice_min_turn_seconds',
      'voice_vision_enabled',
    ];
    for (final key in allKeys) {
      expect(storage.values.containsKey(key), isTrue, reason: key);
    }

    await store.clear();
    expect(storage.values, isEmpty);
    expect(await store.load(), isNull);
  });
}