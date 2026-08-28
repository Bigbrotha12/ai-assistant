import 'package:flutter/widgets.dart';

/// Reacts to app lifecycle changes so an in-progress voice conversation is
/// torn down cleanly when the app goes to the background.
///
/// Voice calls disconnect on background and reset to idle on foreground. The
/// underlying audio services (mic capture, playback) are stopped so no audio
/// leaks while the app is not visible.
class VoiceLifecycleObserver with WidgetsBindingObserver {
  VoiceLifecycleObserver({
    required this.onBackground,
    this.onForeground,
  });

  /// Invoked when the app becomes `paused` or `inactive` (i.e. losing
  /// foreground visibility). Should stop recording, playback, and disconnect.
  final Future<void> Function() onBackground;

  /// Invoked when the app returns to `resumed`. Defaults to a no-op.
  final Future<void> Function()? onForeground;

  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        onForeground?.call();
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        onBackground();
    }
  }

  /// Stops listening for lifecycle changes. Safe to call multiple times.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
  }
}
