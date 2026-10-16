import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../chat/data/status_tracker.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../plugins/data/plugin_http.dart';
import '../../settings/data/prefs_providers.dart';
import '../data/goal_attention_providers.dart';
import '../data/goal_dto.dart';
import '../data/goal_providers.dart';
import 'goal_status_ui.dart';
import 'goal_todo_screen.dart';

/// Phase 3.7 entry point: the gear chip that opens the goals overlay from BOTH
/// send surfaces (chat composer and voice screen).
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

/// Opens the goals overlay. The dialog owns its own dismiss control (plus the
/// usual barrier tap); a row opens that goal's todo view, and each row's
/// trailing menu cancels, deletes, or resumes the goal.
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
/// It is NOT read-only: each row carries a trailing action menu that cancels a
/// live goal, deletes a terminal one, or opens the resume sheet for a paused
/// one. The tap-to-todo-view behavior is unchanged. Pagination follows the
/// ledger convention: the first page is loaded on open and older goals are
/// appended from an explicit footer action.
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

/// The per-row actions the overlay can present.
enum _GoalAction { cancel, delete, resume }

class _GoalsList extends ConsumerStatefulWidget {
  const _GoalsList({required this.page, required this.scheme});

  final GoalListPage page;
  final ColorScheme scheme;

  @override
  ConsumerState<_GoalsList> createState() => _GoalsListState();
}

class _GoalsListState extends ConsumerState<_GoalsList> {
  var _recorded = false;

  /// Goal ids with a cancel/delete request in flight. The row's action surface
  /// is replaced by a spinner while busy, so a second tap cannot double-fire.
  final Set<String> _busy = {};

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

  List<_GoalAction> _actionsFor(GoalSummary goal) => [
    if (goal.canCancel) _GoalAction.cancel,
    if (goal.terminal) _GoalAction.delete,
    if (goal.canResume) _GoalAction.resume,
  ];

  void _onAction(GoalSummary goal, _GoalAction action) {
    switch (action) {
      case _GoalAction.cancel:
        unawaited(_cancel(goal));
      case _GoalAction.delete:
        unawaited(_delete(goal));
      case _GoalAction.resume:
        unawaited(showGoalResumeSheet(context, goalId: goal.goalId));
    }
  }

  /// Confirms, then cancels a live goal. Cancel stops live work, so it is never
  /// one tap away. On success the providers are already invalidated (the list
  /// refreshes in place); a failure surfaces the mapped phrase.
  Future<void> _cancel(GoalSummary goal) async {
    final confirmed = await _confirm(
      title: 'Cancel goal?',
      message:
          'This stops live work on “${goal.instruction}”. Completed steps are '
          'kept, but no further steps will run.',
      confirmLabel: 'Cancel goal',
      confirmKey: const Key('goal-confirm-cancel'),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy.add(goal.goalId));
    try {
      await ref.read(goalActionsProvider).cancel(goal.goalId);
    } catch (error) {
      if (!mounted) return;
      _showSnack(statusPhraseForError(error));
    } finally {
      if (mounted) setState(() => _busy.remove(goal.goalId));
    }
  }

  /// Confirms, then permanently deletes a terminal goal (and its children).
  Future<void> _delete(GoalSummary goal) async {
    final confirmed = await _confirm(
      title: 'Delete goal?',
      message:
          'This permanently removes “${goal.instruction}” and everything '
          'under it — its steps, todos, and results. This cannot be undone.',
      confirmLabel: 'Delete',
      confirmKey: const Key('goal-confirm-delete'),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy.add(goal.goalId));
    try {
      await ref.read(goalActionsProvider).delete(goal.goalId);
    } catch (error) {
      if (!mounted) return;
      _showSnack(statusPhraseForError(error));
    } finally {
      if (mounted) setState(() => _busy.remove(goal.goalId));
    }
  }

  Future<bool> _confirm({
    required String title,
    required String message,
    required String confirmLabel,
    required Key confirmKey,
  }) async {
    final scheme = Theme.of(context).colorScheme;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Never mind'),
          ),
          FilledButton(
            key: confirmKey,
            style: FilledButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return confirmed == true;
  }

  void _showSnack(String message) {
    if (message.isEmpty) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
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
            trailing: _trailing(context, goal),
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

  /// The row's action surface. While a request is in flight the menu is
  /// replaced by a progress spinner, so the surface cannot be re-opened (or
  /// double-tapped) mid-mutation.
  Widget _trailing(BuildContext context, GoalSummary goal) {
    if (_busy.contains(goal.goalId)) {
      return const SizedBox(
        key: Key('goal-action-busy'),
        width: 24,
        height: 24,
        child: Padding(
          padding: EdgeInsets.all(4),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    final actions = _actionsFor(goal);
    if (actions.isEmpty) return const SizedBox.shrink();
    return PopupMenuButton<_GoalAction>(
      key: Key('goal-actions-${goal.goalId}'),
      tooltip: 'Goal actions',
      onSelected: (action) => _onAction(goal, action),
      itemBuilder: (context) => [
        for (final action in actions)
          PopupMenuItem<_GoalAction>(
            value: action,
            child: Text(switch (action) {
              _GoalAction.cancel => 'Cancel',
              _GoalAction.delete => 'Delete',
              _GoalAction.resume => 'Resume',
            }),
          ),
      ],
    );
  }

  /// The one line a row needs: an unanswered question or a failure reason
  /// outrank the plain status.
  String _subtitle(GoalSummary goal) {
    if (goal.pauseQuestion != null) return 'Needs you: ${goal.pauseQuestion}';
    if (goal.failureReason != null) return goal.failureReason!;
    return goalStatusLabel(goal.status);
  }
}

/// Opens the resume sheet for [goalId]. The sheet watches the goal detail,
/// asks for exactly the input the pause reason requires, and hands the raw
/// values to [GoalActions.resume] — it never assembles credentials itself.
Future<void> showGoalResumeSheet(
  BuildContext context, {
  required String goalId,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (_) => GoalResumeSheet(goalId: goalId),
  );
}

/// The per-pause input the resume sheet collects.
enum _ResumeMode { answer, mutations, budget, credentials, generic }

/// The resume dialog: loads `GET /v1/goals/:id`, renders the input the pause
/// reason calls for, and submits `POST /v1/goals/:id/resume` with ONLY the
/// fields relevant to that pause (the action layer owns credentials).
class GoalResumeSheet extends ConsumerStatefulWidget {
  const GoalResumeSheet({super.key, required this.goalId});

  final String goalId;

  @override
  ConsumerState<GoalResumeSheet> createState() => _GoalResumeSheetState();
}

/// Shown when a resume could not assemble the goal's pinned-model credentials:
/// an inline pointer at Plugins rather than a raw failure.
const goalResumeCredentialsHint =
    'Model credentials come from the saved plugin config. If the key is '
    'missing or was revoked, add it in Plugins, then try again.';

/// Shown when two recorded unresolved mutations share the same `(tool,
/// argsHash)` pair. The resume body identifies a resolution only by that pair,
/// so the app cannot express a different resolution for each — sending both
/// would give the server two identical entries, which it rejects with a 400 and
/// leaves the goal un-resumable. There is deliberately no resolution
/// affordance here; cancelling then deleting the goal clears the stuck changes.
const goalResumeDuplicateMutationsHint =
    'Two recorded calls share the same tool name and arguments, so the app '
    'can\'t tell them apart. Cancel this goal, then delete it to clear the '
    'stuck changes, and start it again.';

class _GoalResumeSheetState extends ConsumerState<GoalResumeSheet> {
  final _answer = TextEditingController();
  final _budget = TextEditingController();

  /// Chosen resolution per unresolved mutation, keyed by tool + argsHash.
  final Map<String, String> _resolutions = {};

  var _busy = false;
  var _credentialsHint = false;

  @override
  void dispose() {
    _answer.dispose();
    _budget.dispose();
    super.dispose();
  }

  _ResumeMode _modeFor(GoalDetail goal) {
    if (goal.pauseReason == 'needs_user_input') return _ResumeMode.answer;
    if (goal.pauseReason == 'needs_mutation_resolution' ||
        goal.unresolvedMutations.isNotEmpty) {
      return _ResumeMode.mutations;
    }
    if (goal.pauseReason == 'budget_exhausted') return _ResumeMode.budget;
    if (goal.pauseReason == 'credentials_required' ||
        goal.pauseReason == 'missing_capability') {
      return _ResumeMode.credentials;
    }
    return _ResumeMode.generic;
  }

  static String _mutationId(GoalMutation mutation) =>
      '${mutation.tool}\u0000${mutation.argsHash}';

  static String _shortHash(String hash) =>
      hash.length > 8 ? '${hash.substring(0, 8)}…' : hash;

  /// True when two unresolved mutations collapse to the same `(tool,
  /// argsHash)` key. Only one resolution can be keyed per pair, so the body
  /// would carry two identical entries — the server refuses duplicates and the
  /// goal can no longer be resumed from the UI.
  static bool _hasDuplicateMutations(GoalDetail goal) {
    final seen = <String>{};
    for (final mutation in goal.unresolvedMutations) {
      if (!seen.add(_mutationId(mutation))) return true;
    }
    return false;
  }

  bool _budgetValid(GoalDetail goal) {
    final value = int.tryParse(_budget.text.trim());
    return value != null &&
        value > 0 &&
        value > goal.tokenBudget &&
        value > goal.tokensSpent;
  }

  bool _canSubmit(GoalDetail goal, _ResumeMode mode) {
    switch (mode) {
      case _ResumeMode.answer:
        return _answer.text.trim().isNotEmpty;
      case _ResumeMode.mutations:
        if (_hasDuplicateMutations(goal)) return false;
        return goal.unresolvedMutations.every(
          (mutation) => _resolutions[_mutationId(mutation)] != null,
        );
      case _ResumeMode.budget:
        return _budgetValid(goal);
      case _ResumeMode.credentials:
      case _ResumeMode.generic:
        return true;
    }
  }

  List<GoalMutationResolutionInput> _mutations(GoalDetail goal) => [
    for (final mutation in goal.unresolvedMutations)
      GoalMutationResolutionInput(
        tool: mutation.tool,
        argsHash: mutation.argsHash,
        resolution: _resolutions[_mutationId(mutation)]!,
      ),
  ];

  Future<void> _submit(GoalDetail goal, _ResumeMode mode) async {
    setState(() {
      _busy = true;
      _credentialsHint = false;
    });
    try {
      await ref
          .read(goalActionsProvider)
          .resume(
            goal.goalId,
            answer: mode == _ResumeMode.answer ? _answer.text : null,
            resolveMutations: mode == _ResumeMode.mutations
                ? _mutations(goal)
                : null,
            tokenBudget: mode == _ResumeMode.budget
                ? int.parse(_budget.text.trim())
                : null,
          );
      if (!mounted) return;
      // Providers are already invalidated; closing lets the refreshed list /
      // todo view render in place.
      Navigator.of(context).pop();
    } on PluginClientException catch (error) {
      if (!mounted) return;
      if (error.code == ManagedErrorCodes.noCredentials) {
        setState(() => _credentialsHint = true);
        // The inline hint only renders in the credentials mode's content;
        // every other mode would otherwise swallow the tap with no feedback.
        if (mode != _ResumeMode.credentials) {
          _showSnack(goalResumeCredentialsHint);
        }
      } else {
        _showSnack(statusPhraseForError(error));
      }
    } catch (error) {
      if (!mounted) return;
      _showSnack(statusPhraseForError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showSnack(String message) {
    if (message.isEmpty) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(goalDetailProvider(widget.goalId));
    return detail.when(
      loading: () => const AlertDialog(
        key: Key('goal-resume-sheet'),
        content: SizedBox(
          height: 120,
          child: Center(child: CircularProgressIndicator()),
        ),
      ),
      error: (error, _) => AlertDialog(
        key: const Key('goal-resume-sheet'),
        title: const Text('Resume goal'),
        content: Text(
          error is PluginReauthenticationRequired
              ? error.message
              : statusPhraseForError(error),
        ),
        actions: [
          TextButton(
            key: const Key('goal-resume-close'),
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
          OutlinedButton(
            key: const Key('goal-resume-retry'),
            onPressed: () => ref.invalidate(goalDetailProvider(widget.goalId)),
            child: const Text('Try again'),
          ),
        ],
      ),
      data: (goal) => _buildDialog(context, goal),
    );
  }

  Widget _buildDialog(BuildContext context, GoalDetail goal) {
    final mode = _modeFor(goal);
    final canSubmit = !_busy && _canSubmit(goal, mode);
    return AlertDialog(
      key: const Key('goal-resume-sheet'),
      title: const Text('Resume goal'),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: _content(context, goal, mode),
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('goal-resume-close'),
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
        FilledButton(
          key: const Key('goal-resume-submit'),
          onPressed: canSubmit ? () => _submit(goal, mode) : null,
          child: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Resume'),
        ),
      ],
    );
  }

  List<Widget> _content(
    BuildContext context,
    GoalDetail goal,
    _ResumeMode mode,
  ) {
    switch (mode) {
      case _ResumeMode.answer:
        return [_answerContent(goal)];
      case _ResumeMode.mutations:
        return [_mutationsContent(goal)];
      case _ResumeMode.budget:
        return [_budgetContent(goal)];
      case _ResumeMode.credentials:
        return [_credentialsContent()];
      case _ResumeMode.generic:
        return [
          Text(
            'Resume “${goal.instruction}”? It will pick up where it left off.',
          ),
        ];
    }
  }

  Widget _answerContent(GoalDetail goal) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          goal.pauseQuestion ?? 'This goal needs your input before it can '
              'continue.',
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('goal-resume-answer'),
          controller: _answer,
          enabled: !_busy,
          autofocus: true,
          minLines: 3,
          maxLines: 6,
          textInputAction: TextInputAction.newline,
          decoration: const InputDecoration(
            labelText: 'Your answer',
            alignLabelWithHint: true,
            border: OutlineInputBorder(),
          ),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }

  Widget _mutationsContent(GoalDetail goal) {
    // A duplicate `(tool, argsHash)` pair cannot be resolved distinctly, so no
    // chips are offered and Resume stays disabled; the only way out is to
    // cancel then delete the goal.
    if (_hasDuplicateMutations(goal)) {
      return Text(
        goalResumeDuplicateMutationsHint,
        key: const Key('goal-resume-duplicate-mutations'),
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'These changes were left unresolved when the goal paused. Mark what '
          'happened to each one.',
        ),
        const SizedBox(height: 12),
        for (var i = 0; i < goal.unresolvedMutations.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _mutationRow(goal.unresolvedMutations[i], i),
          ),
        Text(
          'Applied and Retryable both mean the change did land (Retryable just '
          'means it is safe to run again). Not applied is your assertion that '
          'nothing was applied.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }

  Widget _mutationRow(GoalMutation mutation, int index) {
    final selected = _resolutions[_mutationId(mutation)];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('${mutation.tool} · ${_shortHash(mutation.argsHash)}'),
        const SizedBox(height: 4),
        Wrap(
          spacing: 8,
          children: [
            for (final value in const ['applied', 'retryable', 'not_applied'])
              ChoiceChip(
                key: Key('mutation-$index-$value'),
                label: Text(switch (value) {
                  'applied' => 'Applied',
                  'retryable' => 'Retryable',
                  _ => 'Not applied',
                }),
                selected: selected == value,
                onSelected: _busy
                    ? null
                    : (_) => setState(
                        () => _resolutions[_mutationId(mutation)] = value,
                      ),
              ),
          ],
        ),
      ],
    );
  }

  Widget _budgetContent(GoalDetail goal) {
    final text = _budget.text.trim();
    final error = text.isNotEmpty && !_budgetValid(goal)
        ? 'Enter a whole number greater than the current budget and what has '
              'already been spent.'
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('This goal ran out of its token budget. Continue with a '
            'higher budget?'),
        const SizedBox(height: 8),
        Text(
          'Spent ${goal.tokensSpent} of ${goal.tokenBudget} tokens.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('goal-resume-budget'),
          controller: _budget,
          enabled: !_busy,
          autofocus: true,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: InputDecoration(
            labelText: 'New token budget',
            border: const OutlineInputBorder(),
            errorText: error,
          ),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }

  Widget _credentialsContent() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'This goal paused because its model credentials were missing or '
          'expired. They are taken from the saved plugin configuration.',
        ),
        if (_credentialsHint) ...[
          const SizedBox(height: 12),
          Text(
            goalResumeCredentialsHint,
            key: const Key('goal-resume-credentials-hint'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ],
      ],
    );
  }
}
