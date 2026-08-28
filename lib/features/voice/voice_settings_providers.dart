import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'voice_settings.dart';
import 'voice_settings_store.dart';

/// Provides the runtime [VoiceSettingsStore] used for voice settings.
final voiceSettingsStoreProvider = Provider<VoiceSettingsStore>(
  (ref) => SecureVoiceSettingsStore(),
);

/// Async-notifier over the persisted voice settings (null = not configured yet).
final voiceSettingsProvider =
    AsyncNotifierProvider<VoiceSettingsNotifier, VoiceSettings?>(
      VoiceSettingsNotifier.new,
    );

class VoiceSettingsNotifier extends AsyncNotifier<VoiceSettings?> {
  @override
  Future<VoiceSettings?> build() async =>
      ref.read(voiceSettingsStoreProvider).load();

  /// Persists [settings] and updates the in-memory state. On write failure
  /// the state becomes [AsyncError] instead of keeping stale data.
  Future<void> save(VoiceSettings settings) async {
    try {
      await ref.read(voiceSettingsStoreProvider).save(settings);
      state = AsyncData(settings);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }

  /// Resets to the default voice settings.
  Future<void> reset() async {
    final defaults = VoiceSettings();
    try {
      await ref.read(voiceSettingsStoreProvider).save(defaults);
      state = AsyncData(defaults);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }
}