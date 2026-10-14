import 'dart:async';

import 'package:flutter/widgets.dart';

/// Reacts to app lifecycle changes so the managed-chat background poller stays
/// foreground-gated (plan P3).
///
/// Background inference is delivered on the next foreground: a suspended app
/// runs no poll timers, and a `LedgerPollHandle`'s fixed deadline can expire
/// while suspended (an expired handle finishes `exhausted` without a single
/// poll). So on `resumed` the poller is re-armed and every still-pending
/// background job gets a FRESH ledger watch; on `paused`/`hidden`/`detached`
/// the poller is suspended so nothing runs unseen.
///
/// Teardown fires only on `paused`, `hidden`, and `detached`. Transient
/// `inactive` interruptions (iOS control-center, incoming calls) do NOT
/// suspend the poller.
class ChatLifecycleObserver with WidgetsBindingObserver {
  ChatLifecycleObserver({
    required this.onForeground,
    required this.onBackground,
  });

  /// Invoked when the app becomes `resumed`: arm the poller and re-watch every
  /// still-pending background job.
  final Future<void> Function() onForeground;

  /// Invoked when the app becomes `paused`, `hidden`, or `detached`: suspend
  /// the poller so no timers run in the background.
  final Future<void> Function() onBackground;

  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(onForeground());
        break;
      case AppLifecycleState.inactive:
        // Handled by the poller's own suspension policy; do NOT arm or tear
        // down on a transient interruption. `break` keeps this genuine — an
        // empty Dart case would fall through to paused/hidden/detached.
        break;
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        unawaited(onBackground());
    }
  }

  /// Stops listening for lifecycle changes. Safe to call multiple times.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
  }
}