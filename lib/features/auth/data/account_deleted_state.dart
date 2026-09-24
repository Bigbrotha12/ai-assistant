import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

const accountDeletedNotice = 'This account has been deleted.';

final accountDeletedProvider = NotifierProvider<AccountDeletedNotifier, bool>(
  AccountDeletedNotifier.new,
);

class AccountDeletedRun {
  const AccountDeletedRun._(this._notifier, this.generation);

  final AccountDeletedNotifier _notifier;
  final int generation;

  bool get isCurrent => _notifier._isCurrent(this);
}

class AccountDeletedNotifier extends Notifier<bool> {
  Future<void>? _inFlight;
  AccountDeletedRun? _activeRun;
  int _generation = 0;
  Object? _partialCause;
  Future<void> Function()? _retry;

  @override
  bool build() => false;

  int get generation => _generation;
  bool get partialCleanup => _partialCause != null;
  Object? get partialCleanupCause => _partialCause;
  bool get terminalWipeInFlight => _inFlight != null;

  void reset() {
    _generation++;
    _activeRun = null;
    _partialCause = null;
    _retry = null;
    if (state) state = false;
  }

  Future<void> waitForSettlement() => _inFlight ?? Future<void>.value();

  Future<void> resetForNewAccount() {
    final running = _inFlight;
    if (running == null) {
      reset();
      return Future<void>.value();
    }
    return _waitForTerminalWipe(running);
  }

  Future<void> _waitForTerminalWipe(Future<void> running) async {
    try {
      await running;
    } catch (_) {}
    reset();
  }

  bool _isCurrent(AccountDeletedRun run) =>
      identical(_activeRun, run) && run.generation == _generation;

  void registerRetry(AccountDeletedRun run, Future<void> Function() retry) {
    if (_isCurrent(run)) _retry = retry;
  }

  void markPartialCleanup(AccountDeletedRun run, Object cause) {
    if (_isCurrent(run)) _partialCause = cause;
  }

  Future<void> runOnce(Future<void> Function() action) =>
      runOnceFor((_) => action());

  Future<void> runOnceFor(Future<void> Function(AccountDeletedRun run) action) {
    final running = _inFlight;
    if (running != null) return running;
    if (state) return Future<void>.value();

    state = true;
    final run = AccountDeletedRun._(this, ++_generation);
    _activeRun = run;
    return _launch(action, run);
  }

  Future<void> retry() {
    final action = _retry;
    final run = _activeRun;
    if (action == null || run == null || _inFlight != null) {
      return Future<void>.value();
    }
    return _launch((_) => action(), run);
  }

  Future<void> _launch(
    Future<void> Function(AccountDeletedRun run) action,
    AccountDeletedRun run,
  ) {
    final completer = Completer<void>();
    late final Future<void> future;
    future = completer.future;
    final actionFuture = Future<void>.sync(() => action(run));
    unawaited(
      actionFuture.then<void>(
        (_) {
          if (_isCurrent(run)) {
            _partialCause = null;
            _retry = null;
          }
          if (!completer.isCompleted) completer.complete();
          if (identical(_inFlight, future)) _inFlight = null;
        },
        onError: (Object error, StackTrace stack) {
          if (_isCurrent(run) && _retry == null) _partialCause = error;
          if (!completer.isCompleted) {
            completer.completeError(error, stack);
          }
          if (identical(_inFlight, future)) _inFlight = null;
        },
      ),
    );
    _inFlight = future;
    return future;
  }
}
