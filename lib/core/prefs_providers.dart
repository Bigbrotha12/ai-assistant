import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'prefs_store.dart';

/// Provides the runtime [AppPrefsStore] used across the app.
final appPrefsStoreProvider = Provider<AppPrefsStore>(
  (ref) => SharedPrefsAppPrefsStore(),
);

/// Async-notifier over the persisted [AppPrefs], defaulting to a fresh set.
final appPrefsProvider =
    AsyncNotifierProvider<AppPrefsNotifier, AppPrefs>(AppPrefsNotifier.new);

class AppPrefsNotifier extends AsyncNotifier<AppPrefs> {
  @override
  Future<AppPrefs> build() async => ref.read(appPrefsStoreProvider).load();

  /// Persists [prefs] and updates the in-memory state. On write failure the
  /// state becomes [AsyncError] instead of keeping stale data.
  Future<void> save(AppPrefs prefs) async {
    try {
      await ref.read(appPrefsStoreProvider).save(prefs);
      state = AsyncData(prefs);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }
}
