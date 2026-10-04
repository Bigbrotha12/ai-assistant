import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../chat/data/status_tracker.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../data/goal_dto.dart';
import '../data/goal_providers.dart';

/// Phase 3.7's todo view: renders `GET /v1/goals/:id` (WIRE_SPEC §12) and
/// keeps it live while the goal runs.
///
/// The poll is deliberately screen-scoped and lifecycle-honest:
///  - it stops the moment the goal is terminal (nothing left to change);
///  - it backs off 1s → 15s while the payload is unchanged and snaps back to
///    1s as soon as status/updatedAt moves, so a running goal stays responsive
///    without hammering the gateway during a long quiet step;
///  - it pauses when the app leaves the foreground (the same gating the chat
///    ledger poller applies) and is cancelled in [dispose], so no timer or
///    request outlives the screen (DEFENSIVE_PATTERNS §4).
class GoalTodoScreen extends ConsumerStatefulWidget {
  const GoalTodoScreen({super.key, required this.goalId});

  final String goalId;

  @override
  ConsumerState<GoalTodoScreen> createState() => _GoalTodoScreenState();
}

const _pollInitial = Duration(seconds: 1);
const _pollMax = Duration(seconds: 15);

class _GoalTodoScreenState extends ConsumerState<GoalTodoScreen>
    with WidgetsBindingObserver {
  Timer? _timer;
  var _delay = _pollInitial;
  var _lastSeen = '';
  var _foreground = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _arm(_pollInitial);
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_foreground) {
        _foreground = true;
        _delay = _pollInitial;
        _arm(_pollInitial);
      }
      return;
    }
    _foreground = false;
    _timer?.cancel();
    _timer = null;
  }

  void _arm(Duration delay) {
    _timer?.cancel();
    if (!_foreground) return;
    _timer = Timer(delay, _tick);
  }

  Duration _grow(Duration current) {
    final next = current * 2;
    return next > _pollMax ? _pollMax : next;
  }

  Future<void> _tick() async {
    if (!mounted || !_foreground) return;
    await ref
        .read(goalDetailProvider(widget.goalId).notifier)
        .refresh();
    if (!mounted || !_foreground) return;

    final detail = ref.read(goalDetailProvider(widget.goalId)).value;
    if (detail == null) {
      // First load still pending (or failed): keep probing at the backoff.
      _arm(_grow(_delay));
      return;
    }
    if (detail.terminal) return; // done — stop polling entirely

    final seen = '${detail.status}:${detail.updatedAt}';
    _delay = seen == _lastSeen ? _grow(_delay) : _pollInitial;
    _lastSeen = seen;
    _arm(_delay);
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(goalDetailProvider(widget.goalId));
    return Scaffold(
      appBar: AppBar(title: const Text('Goal')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => _GoalLoadError(
          message: error is PluginReauthenticationRequired
              ? error.message
              : statusPhraseForError(error),
          onRetry: () => ref.invalidate(goalDetailProvider(widget.goalId)),
        ),
        data: (goal) => _GoalDetailView(goal: goal),
      ),
    );
  }
}

class _GoalLoadError extends StatelessWidget {
  const _GoalLoadError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

class _GoalDetailView extends StatelessWidget {
  const _GoalDetailView({required this.goal});

  final GoalDetail goal;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        Row(
          children: [
            Icon(_statusIcon(goal.status), size: 18, color: _statusColor(goal, scheme)),
            const SizedBox(width: 8),
            Text(_statusLabel(goal.status), style: theme.textTheme.titleSmall),
          ],
        ),
        const SizedBox(height: 12),
        Text(goal.instruction, style: theme.textTheme.bodyLarge),
        if (goal.pauseQuestion != null) ...[
          const SizedBox(height: 16),
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Needs you', style: theme.textTheme.titleSmall),
                  const SizedBox(height: 4),
                  Text(goal.pauseQuestion!),
                ],
              ),
            ),
          ),
        ],
        if (goal.failureReason != null) ...[
          const SizedBox(height: 16),
          Text(
            goal.failureReason!,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ],
        const SizedBox(height: 24),
        Text('Plan', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        if (goal.todos.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              goal.terminal
                  ? 'No todos were published.'
                  : 'Waiting for the goal to publish its plan…',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          )
        else
          for (final todo in goal.todos)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: Icon(Icons.check_circle_outline, color: scheme.outline),
              title: Text(todo),
            ),
      ],
    );
  }

  static String _statusLabel(String status) => switch (status) {
    'queued' => 'Queued',
    'running' => 'Running',
    'paused' => 'Paused',
    'complete' => 'Complete',
    'failed' => 'Failed',
    'cancelled' => 'Cancelled',
    _ => status,
  };

  static IconData _statusIcon(String status) => switch (status) {
    'running' => Icons.timelapse,
    'paused' => Icons.pause_circle_outline,
    'complete' => Icons.check_circle,
    'failed' => Icons.error_outline,
    'cancelled' => Icons.block,
    _ => Icons.schedule,
  };

  static Color _statusColor(GoalDetail goal, ColorScheme scheme) =>
      switch (goal.status) {
        'running' => scheme.primary,
        'paused' => scheme.tertiary,
        'complete' => scheme.primary,
        'failed' => scheme.error,
        _ => scheme.onSurfaceVariant,
      };
}
