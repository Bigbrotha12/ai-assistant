import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'voice_settings.dart';

/// Persistence for runtime voice settings.
abstract interface class VoiceSettingsStore {
  /// Returns saved settings, or null when nothing usable has been saved.
  Future<VoiceSettings?> load();

  /// Persists [settings] for later retrieval.
  Future<void> save(VoiceSettings settings);

  /// Removes any previously saved settings.
  Future<void> clear();
}

/// [FlutterSecureStorage]-backed store for voice settings. The storage
/// instance is injectable so tests can substitute a fake.
///
/// Lives in the voice feature (rather than core) so core settings persistence
/// never depends on a feature's model.
class SecureVoiceSettingsStore implements VoiceSettingsStore {
  /// Creates a store. When [storage] is null a default [FlutterSecureStorage]
  /// is used whose iOS keychain items are scoped to this device
  /// (`first_unlock_this_device`) so they never sync across devices.
  SecureVoiceSettingsStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
            );

  static const _kVoiceSttEngine = 'voice_stt_engine';
  static const _kVoiceTtsEngine = 'voice_tts_engine';
  static const _kVoiceVadSensitivity = 'voice_vad_sensitivity';
  static const _kVoiceLanguage = 'voice_language';
  static const _kMinTurnSeconds = 'voice_min_turn_seconds';
  static const _kVisionEnabled = 'voice_vision_enabled';

  final FlutterSecureStorage _storage;

  @override
  Future<VoiceSettings?> load() async {
    final sttEngine = await _storage.read(key: _kVoiceSttEngine);
    final ttsEngine = await _storage.read(key: _kVoiceTtsEngine);
    // If nothing has been saved, return null so the provider falls back
    // to the in-code defaults.
    if (sttEngine == null && ttsEngine == null) return null;

    final vadStr = await _storage.read(key: _kVoiceVadSensitivity);
    final language = await _storage.read(key: _kVoiceLanguage);
    final minTurnStr = await _storage.read(key: _kMinTurnSeconds);
    final visionEnabledRaw = await _storage.read(key: _kVisionEnabled);

    return VoiceSettings(
      sttEngine: sttEngine ?? VoiceSettings().sttEngine,
      ttsEngine: ttsEngine ?? VoiceSettings().ttsEngine,
      vadSensitivity: vadStr != null
          ? double.tryParse(vadStr) ?? VoiceSettings().vadSensitivity
          : VoiceSettings().vadSensitivity,
      preferredLanguage: language ?? VoiceSettings().preferredLanguage,
      minTurnSeconds: minTurnStr != null
          ? double.tryParse(minTurnStr) ?? VoiceSettings().minTurnSeconds
          : VoiceSettings().minTurnSeconds,
      visionEnabled: visionEnabledRaw != null
          ? visionEnabledRaw == 'true'
          : VoiceSettings().visionEnabled,
    );
  }

  @override
  Future<void> save(VoiceSettings settings) async {
    await _storage.write(key: _kVoiceSttEngine, value: settings.sttEngine);
    await _storage.write(key: _kVoiceTtsEngine, value: settings.ttsEngine);
    await _storage.write(
      key: _kVoiceVadSensitivity,
      value: settings.vadSensitivity.toString(),
    );
    await _storage.write(
      key: _kVoiceLanguage,
      value: settings.preferredLanguage,
    );
    await _storage.write(
      key: _kMinTurnSeconds,
      value: settings.minTurnSeconds.toString(),
    );
    await _storage.write(
      key: _kVisionEnabled,
      value: settings.visionEnabled.toString(),
    );
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _kVoiceSttEngine);
    await _storage.delete(key: _kVoiceTtsEngine);
    await _storage.delete(key: _kVoiceVadSensitivity);
    await _storage.delete(key: _kVoiceLanguage);
    await _storage.delete(key: _kMinTurnSeconds);
    await _storage.delete(key: _kVisionEnabled);
  }
}