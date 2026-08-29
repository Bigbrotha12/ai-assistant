import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Visual tier of the app (see `docs/design-system.md`).
enum AppTier { standard, premium }

/// Persistence for the app-tier preference (non-sensitive — plain prefs).
abstract interface class AppTierStore {
  /// Returns the saved tier, or null when nothing has been saved (default).
  Future<AppTier?> load();

  /// Persists [tier] for later retrieval.
  Future<void> save(AppTier tier);
}

/// [SharedPreferences]-backed store. The instance is injectable so tests can
/// substitute an in-memory fake.
class SharedPrefsAppTierStore implements AppTierStore {
  SharedPrefsAppTierStore();

  static const _kKey = 'app_tier';

  @override
  Future<AppTier?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_kKey);
    return switch (value) {
      'premium' => AppTier.premium,
      'standard' => AppTier.standard,
      _ => null,
    };
  }

  @override
  Future<void> save(AppTier tier) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kKey, tier.name);
  }
}

/// Provides the runtime [AppTierStore].
final appTierStoreProvider = Provider<AppTierStore>(
  (ref) => SharedPrefsAppTierStore(),
);

/// Selected [AppTier]; defaults to [AppTier.standard].
final appTierProvider = AsyncNotifierProvider<AppTierNotifier, AppTier>(
  AppTierNotifier.new,
);

class AppTierNotifier extends AsyncNotifier<AppTier> {
  @override
  Future<AppTier> build() async =>
      await ref.read(appTierStoreProvider).load() ?? AppTier.standard;

  /// Persists [tier] and updates the in-memory state.
  Future<void> setTier(AppTier tier) async {
    if (state.value == tier) return;
    state = const AsyncLoading();
    try {
      await ref.read(appTierStoreProvider).save(tier);
      state = AsyncData(tier);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }

  /// Toggles between standard and premium.
  Future<void> toggle() =>
      setTier(state.value == AppTier.premium
          ? AppTier.standard
          : AppTier.premium);
}