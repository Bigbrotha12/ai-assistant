import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../chat/data/status_tracker.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../settings/data/prefs_providers.dart';
import '../data/goal_attention_providers.dart';
import '../data/goal_dto.dart';
import '../data/goal_providers.dart';
import 'goal_status_ui.dart';
import 'goal_todo_screen.dart';

/// Phase 3.7 entry point: the gear chip that opens the read-only goals overlay
/// from BOTH send surfaces (chat composer and voice screen).
///
/// The chip is deliberately self-contained — it owns its own `onPressed` — so
/// each screen only has to place it. Phase 7.3 adds a small attention dot when
/// a paused/failed goal is newer than the account's last-seen marker; the
/// tooltip and size are unchanged otherwise.
class GoalsChip extends ConsumerWidget {
  const GoalsChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final hasAttention = ref.watch(goalAttentionProvider);
    final icon = Icon(
      Icons.settings,
      size: 20,
      color: scheme.onSurfaceVariant,
    );
    return IconButton(
      key: const Key('goals-chip'),
      tooltip: 'Goals',
      visualDensity: VisualDensity.compact,
      // Same circular-outline treatment the composer's action buttons use, so
      // it reads as a button rather than a bare glyph.
      style: IconButton.styleFrom(
        shape: const CircleBorder(),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      // The Stack is sized by the 20x20 icon, so the dot never changes the
      // chip's footprint (only its painting).
      icon: hasAttention
          ? Stack(
              alignment: Alignment.topRight,
              children: [
                icon,
                Container(
                  key: const Key('goals-attention-dot'),
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: scheme.error,
                    shape: BoxShape.circle,
                  ),
                ),
              ],
            )
          : icon,
      onPressed: () => showGoalsOverlay(context),
    );
  }
}

/// Opens the read-only goals overlay. The dialog owns its own dismiss control
/// (plus the usual barrier tap), and a row opens that goal's todo view.
Future<void> showGoalsOverlay(BuildContext context) {
  // [goalAttentionProvider] keeps [goalListProvider] alive for the session, so
  // its retained page would otherwise be shown on reopen. Invalidate before the
  // dialog subscribes so every open refetches a fresh first page.
  //
  // Accepted flicker: invalidating drops the list to loading, so attention
  // momentarily returns false; if the refetch somehow retains a stale value it
  // may flash true again until `markGoalsSeen` lands after the first frame.
  // That is at most a two-frame flap and it happens behind the dialog barrier,
  // so the chip is not visible — do not restructure the flow to chase it.
  ProviderScope.containerOf(
    context,
    listen: false,
  ).invalidate(goalListProvider);
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (dialogContext) => const GoalsOverlay(),
  );
}

/// The overlay itself: every goal the owner has, newest-first, scrollable.
///
/// READ-ONLY by design (the first cut): no cancel/resume/delete here — rows
/// only open the goal's todo view, which is itself read-only. Pagination
/// follows the ledger convention: the first page is loaded on open and older
/// goals are appended from an explicit footer action.
class GoalsOverlay extends ConsumerWidget {
  const GoalsOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final page = ref.watch(goalListProvider);
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Dialog(
      key: const Key('goals-overlay'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('Goals', style: textTheme.titleLarge),
                ),
                IconButton(
                  key: const Key('goals-dismiss'),
                  tooltip: 'Close',
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
            const SizedBox(height: 4),
            SizedBox(
              width: 420,
              height: 380,
              child: page.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, _) => _GoalsLoadError(
                  message: error is PluginReauthenticationRequired
                      ? error.message
                      : statusPhraseForError(error),
                  onRetry: () => ref.invalidate(goalListProvider),
                ),
                data: (goals) => _GoalsList(page: goals, scheme: scheme),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GoalsLoadError extends StatelessWidget {
  const _GoalsLoadError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: onRetry,
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}

class _GoalsList extends ConsumerStatefulWidget {
  const _GoalsList({required this.page, required this.scheme});

  final GoalListPage page;
  final ColorScheme scheme;

  @override
  ConsumerState<_GoalsList> createState() => _GoalsListState();
}

class _GoalsListState extends ConsumerState<_GoalsList> {
  var _recorded = false;

  @override
  void initState() {
    super.initState();
    // The list has rendered once this state is built; defer the marker write
    // to after the frame so it never blocks the first paint, and record at
    // most once per overlay.
    WidgetsBinding.instance.addPostFrameCallback((_) => _markSeen());
  }

  /// Records the viewed marker for the owning account so the chip's dot clears
  /// after the user has seen the goals. The marker is clamped to the newest
  /// `updatedAt` on screen so a server clock ahead of the device cannot leave a
  /// just-viewed goal looking newer. Fire-and-forget: the write is best-effort
  /// and guarded, and a scope that cannot resolve simply skips it.
  void _markSeen() {
    if (!mounted || _recorded) return;
    _recorded = true;
    final String scopeId;
    try {
      scopeId = ref.read(pluginAccountScopeProvider).storageId;
    } on PluginReauthenticationRequired {
      return;
    }
    unawaited(
      ref.read(appPrefsProvider.notifier).markGoalsSeen(
        scopeId,
        maxObservedUpdatedAt: _newestUpdatedAt(widget.page.goals),
      ),
    );
  }

  /// Newest parseable `updatedAt` across [goals], or null when none parse. A
  /// malformed timestamp is ignored rather than weakening the clamp.
  static DateTime? _newestUpdatedAt(Iterable<GoalSummary> goals) {
    DateTime? newest;
    for (final goal in goals) {
      final parsed = DateTime.tryParse(goal.updatedAt);
      if (parsed == null) continue;
      if (newest == null || parsed.isAfter(newest)) newest = parsed;
    }
    return newest;
  }

  @override
  Widget build(BuildContext context) {
    final page = widget.page;
    final scheme = widget.scheme;
    if (page.goals.isEmpty) {
      return Center(
        child: Text(
          'No goals yet.',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
      );
    }
    final notifier = ref.read(goalListProvider.notifier);
    return ListView(
      children: [
        for (final goal in page.goals)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(
              goalStatusIcon(goal.status),
              color: goalStatusColor(goal.status, scheme),
            ),
            title: Text(
              goal.instruction,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(_subtitle(goal)),
            onTap: () async {
              final navigator = Navigator.of(context);
              navigator.pop(); // dismiss the overlay first…
              await navigator.push(
                MaterialPageRoute<void>(
                  builder: (_) => GoalTodoScreen(goalId: goal.goalId),
                ),
              );
            },
          ),
        if (page.nextOffset != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(
              'Show older goals…',
              style: TextStyle(color: scheme.primary),
            ),
            onTap: notifier.loadMore,
          ),
      ],
    );
  }

  /// The one line a read-only row needs: an unanswered question or a failure
  /// reason outrank the plain status.
  String _subtitle(GoalSummary goal) {
    if (goal.pauseQuestion != null) return 'Needs you: ${goal.pauseQuestion}';
    if (goal.failureReason != null) return goal.failureReason!;
    return goalStatusLabel(goal.status);
  }
}
