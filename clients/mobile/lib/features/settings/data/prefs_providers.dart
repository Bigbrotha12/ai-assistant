import 'package:flutter_riverpod/flutter_riverpod.dart';

import './prefs_store.dart';

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

  /// Records that [scopeId]'s owner has now viewed the goals list (Phase 7.3),
  /// so the goals attention provider recomputes to no attention and the chip's
  /// dot clears.
  ///
  /// The marker is clamped to the newest `updatedAt` the overlay actually
  /// rendered ([maxObservedUpdatedAt]): the comparison in
  /// [goalHasAttention] uses the SERVER's clock, so a server running ahead of
  /// the device would keep a just-viewed goal "newer" than a device-`now`
  /// marker and the dot would never clear. Passing the observed max makes the
  /// marker at least as new as everything on screen, regardless of skew.
  ///
  /// Deliberately best-effort and non-blocking: a failed write keeps the last
  /// good state (the dot stays until a later successful view) and never throws
  /// into the caller, so an overlay render can fire-and-forget this. The write
  /// is guarded against provider disposal.
  ///
  /// Accepted limitation (L5): the read-modify-write of `goalLastSeen` assumes
  /// a single active account. Concurrent writes for two scopes could drop one
  /// marker. This is fine while only one account is signed in at a time.
  Future<void> markGoalsSeen(
    String scopeId, {
    DateTime? at,
    DateTime? maxObservedUpdatedAt,
  }) async {
    AppPrefs current;
    final loaded = state.value;
    if (loaded != null) {
      current = loaded;
    } else {
      // Still loading (or the initial load failed): try the pending value once.
      try {
        current = await future;
      } catch (_) {
        return;
      }
      if (!ref.mounted) return;
    }
    final now = at ?? DateTime.now();
    final observed = maxObservedUpdatedAt;
    final stamp = (observed != null && observed.isAfter(now) ? observed : now)
        .toUtc()
        .toIso8601String();
    if (current.goalLastSeen[scopeId] == stamp) return;
    final next = current.copyWith(
      goalLastSeen: {...current.goalLastSeen, scopeId: stamp},
    );
    try {
      await ref.read(appPrefsStoreProvider).save(next);
    } catch (_) {
      return; // best-effort; keep the last good state
    }
    if (!ref.mounted) return;
    state = AsyncData(next);
  }
}
