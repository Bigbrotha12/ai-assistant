import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/backend_settings.dart';
import './settings_store.dart';

/// Provides the runtime [SettingsStore] used across the app.
final settingsStoreProvider = Provider<SettingsStore>(
  (ref) => SecureSettingsStore(),
);

/// Async-notifier over the persisted settings (null = not configured yet).
final settingsProvider =
    AsyncNotifierProvider<SettingsNotifier, BackendSettings?>(
  SettingsNotifier.new,
);

class SettingsNotifier extends AsyncNotifier<BackendSettings?> {
  @override
  Future<BackendSettings?> build() async {
    if (kDebugMode) debugPrint('SettingsProvider: building (reload)');
    return ref.read(settingsStoreProvider).load();
  }

  /// Persists [settings] and updates the in-memory state. On write failure the
  /// state becomes [AsyncError] instead of keeping stale data.
  Future<void> save(BackendSettings settings) async {
    try {
      await ref.read(settingsStoreProvider).save(settings);
      state = AsyncData(settings);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }

  /// Clears persisted settings and resets the in-memory state.
  Future<void> clear() async {
    await ref.read(settingsStoreProvider).clear();
    state = const AsyncData(null);
  }
}