import 'dart:async';

import 'package:flutter/widgets.dart';

/// Reacts to app lifecycle changes so an in-progress voice conversation is
/// suspended cleanly when the app goes to the background.
///
/// On background the session suspends its audio (mic/playback/focus) but the
/// in-flight LLM turn keeps running — its reply completes and queues for
/// playback on the next foreground (see `VoiceController.enterBackground` /
/// `exitBackground`).
///
/// Teardown fires only on `paused`, `hidden`, and `detached` states.
/// Transient `inactive` interruptions (iOS control-center, incoming calls) are
/// handled by the audio-focus-loss mechanism (see PLAN.md gotcha #1) so they
/// do NOT suspend the session.
class VoiceLifecycleObserver with WidgetsBindingObserver {
  VoiceLifecycleObserver({
    required this.onBackground,
    this.onForeground,
  });

  /// Invoked when the app becomes `paused`, `hidden`, or `detached` (i.e. losing
  /// foreground visibility). Should stop recording and playback while keeping
  /// any in-flight LLM turn alive.
  final Future<void> Function() onBackground;

  /// Invoked when the app returns to `resumed`. Defaults to a no-op.
  final Future<void> Function()? onForeground;

  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(onForeground?.call());
        break;
      case AppLifecycleState.inactive:
        // Handled by audio-focus-loss; do NOT suspend or tear down the
        // session. `break` (not a terminating suspend) keeps this genuine —
        // an empty Dart case would fall through to paused/hidden/detached.
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
