import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../settings/data/prefs_providers.dart';
import 'goal_dto.dart';
import 'goal_providers.dart';

/// True when at least one of the owner's goals needs attention (Phase 7.3):
/// it is `paused` (any reason) or `failed`, and its `updatedAt` is newer than
/// the account's persisted "goals last seen" marker.
///
/// Read-only: the list arrives through [goalListProvider] (never a second HTTP
/// path), so this recomputes whenever that list refreshes — including the
/// foreground re-fetch wired by [goalAttentionLifecycleProvider]. Every gap
/// fails quiet: a loading/errored list, an unresolvable account scope, an
/// unparseable timestamp, or a loading/errored prefs store yields `false`
/// rather than a phantom dot.
///
/// An ERRORED list is checked before its value is read. Riverpod's `AsyncError`
/// RETAINS the previous `value`, so a failed refresh after a successful load
/// leaves `isLoading == false` while `value` is the stale list. Reading that
/// value would evaluate the previous account's paused/failed goals against the
/// new scope's (null) marker and light a persistent phantom dot; the error gate
/// is what makes the documented fail-quiet hold on that path.
final goalAttentionProvider = Provider<bool>((ref) {
  // Keeps the foreground observer registered for as long as this provider is
  // alive (the chip watches it) and re-fetches the goals list on every resume.
  ref.watch(goalAttentionLifecycleProvider);

  // Gate on a resolved account BEFORE subscribing to the list or prefs: with
  // no scope there is no list to fetch and no marker to read, and not watching
  // those providers avoids building (and Riverpod-auto-retrying) a failing
  // `goalListProvider` on cold boot / signed-out surfaces.
  final authScope = ref.watch(
    authCredentialsProvider.select((auth) => auth.value?.accountScope),
  );
  if (authScope == null) return false;

  final list = ref.watch(goalListProvider);
  // Fail quiet while the list is (re)loading. After a scope switch Riverpod
  // keeps the PREVIOUS account's goals as the value of the in-flight
  // `AsyncLoading`; evaluating those against the new scope's (possibly absent)
  // marker would flash a one-frame phantom dot. This also covers the initial
  // load and the foreground re-fetch.
  //
  // `hasError` must be gated too, not just `isLoading`: an `AsyncError` from a
  // FAILED refresh retains the prior list as its `value`, so `isLoading` is
  // false while `list.value` still holds the stale goals. Reading it would
  // evaluate the previous account's paused/failed goals against the new scope's
  // (null) marker and light a persistent phantom dot.
  if (list.isLoading || list.hasError) return false;
  final goals = list.value?.goals;
  if (goals == null) return false; // no loaded page → no attention

  final String scopeId;
  try {
    scopeId = ref.watch(pluginAccountScopeProvider).storageId;
  } on PluginReauthenticationRequired {
    return false;
  }
  // Derive the marker only from a successfully-loaded prefs value: an errored
  // store (or one still loading) must not be read as "never viewed", which
  // would light the dot for every paused goal.
  final prefs = ref.watch(appPrefsProvider);
  if (prefs.isLoading || prefs.hasError) return false;
  final lastSeen = prefs.value?.goalLastSeen[scopeId];
  return goalHasAttention(goals: goals, lastSeenIso: lastSeen);
});

/// Pure predicate behind [goalAttentionProvider].
///
/// A goal draws attention when its status is `paused` or `failed` AND its
/// `updatedAt` is newer than [lastSeenIso]. With no marker (the account has
/// never viewed the list, or the record predates 7.3) every paused/failed goal
/// draws attention. A goal whose `updatedAt` cannot be parsed never draws
/// attention once a marker exists — a malformed timestamp must not produce a
/// phantom dot.
bool goalHasAttention({
  required Iterable<GoalSummary> goals,
  required String? lastSeenIso,
}) {
  final lastSeen = lastSeenIso == null ? null : DateTime.tryParse(lastSeenIso);
  final hasMarker = lastSeen != null;
  for (final goal in goals) {
    final status = goal.status.toLowerCase();
    if (status != 'paused' && status != 'failed') continue;
    if (!hasMarker) return true;
    final updated = DateTime.tryParse(goal.updatedAt);
    if (updated == null) continue;
    if (updated.isAfter(lastSeen)) return true;
  }
  return false;
}

/// Foreground reconciliation for the goals attention dot.
///
/// This mirrors `chatPollerLifecycleObserverProvider`'s shape rather than
/// sharing it: that observer is chat/ledger-specific (it arms
/// `ManagedChatAdapter`), so a parallel, self-contained observer is cheaper
/// than widening the chat one. On `resumed` the goals list is re-fetched,
/// which recomputes [goalAttentionProvider]; background transitions need no
/// work because nothing polls goals in the background. The
/// [WidgetsBindingObserver] is registered here and removed in `ref.onDispose`,
/// so it lives exactly as long as the provider keeping it alive. No timers.
final goalAttentionLifecycleProvider = Provider<GoalAttentionLifecycle>((
  ref,
) {
  final lifecycle = GoalAttentionLifecycle(
    onForeground: () {
      if (!ref.mounted) return;
      // Re-fetch; the list provider's rebuild recomputes attention. A failed
      // re-fetch simply keeps the last value (fail quiet).
      ref.invalidate(goalListProvider);
    },
  );
  WidgetsBinding.instance.addObserver(lifecycle);
  ref.onDispose(lifecycle.dispose);
  return lifecycle;
});

/// Minimal [WidgetsBindingObserver]: invokes [onForeground] on `resumed` and
/// ignores every other state (only the chat poller needs background teardown).
class GoalAttentionLifecycle with WidgetsBindingObserver {
  GoalAttentionLifecycle({required this.onForeground});

  final void Function() onForeground;
  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    if (state == AppLifecycleState.resumed) onForeground();
  }

  /// Stops listening for lifecycle changes. Safe to call multiple times.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
  }
}
