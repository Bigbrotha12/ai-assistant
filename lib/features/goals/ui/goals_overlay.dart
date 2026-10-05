import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../chat/data/status_tracker.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../data/goal_dto.dart';
import '../data/goal_providers.dart';
import 'goal_status_ui.dart';
import 'goal_todo_screen.dart';

/// Phase 3.7 entry point: the gear chip that opens the read-only goals overlay
/// from BOTH send surfaces (chat composer and voice screen).
///
/// The chip is deliberately self-contained — it owns its own `onPressed` — so
/// each screen only has to place it.
class GoalsChip extends StatelessWidget {
  const GoalsChip({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
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
      icon: Icon(Icons.settings, size: 20, color: scheme.onSurfaceVariant),
      onPressed: () => showGoalsOverlay(context),
    );
  }
}

/// Opens the read-only goals overlay. The dialog owns its own dismiss control
/// (plus the usual barrier tap), and a row opens that goal's todo view.
Future<void> showGoalsOverlay(BuildContext context) {
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

class _GoalsList extends ConsumerWidget {
  const _GoalsList({required this.page, required this.scheme});

  final GoalListPage page;
  final ColorScheme scheme;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
