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
      ttsEngine: 'kokoro_82m',
      vadSensitivity: 0.75,
      preferredLanguage: 'en',
    );

    await store.save(settings);
    final loaded = await store.load();

    expect(loaded, settings);
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
}