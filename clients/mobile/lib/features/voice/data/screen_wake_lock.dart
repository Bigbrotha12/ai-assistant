import 'package:wakelock_plus/wakelock_plus.dart';

/// Controls whether the screen is kept awake while an active voice
/// conversation is running.
///
/// The app has no background-audio permission, so it must finish speaking a
/// reply while still on screen. Without a wake lock, a long LLM wait or TTS
/// reply can hit the OS idle timer and blank the display — terminating the
/// audio session mid-response. Enabled only for the lifetime of a connected
/// conversation ([VoiceController.startConversation] … [endConversation]) so
/// the screen returns to normal sleeping behaviour on every other screen.
abstract interface class ScreenWakeLock {
  /// Keeps the screen on. Idempotent.
  Future<void> enable();

  /// Releases the wake lock. Idempotent.
  Future<void> disable();
}

/// [ScreenWakeLock] backed by the platform `wakelock_plus` plugin.
class PlatformScreenWakeLock implements ScreenWakeLock {
  @override
  Future<void> enable() => WakelockPlus.enable();

  @override
  Future<void> disable() => WakelockPlus.disable();
}

/// No-op [ScreenWakeLock] for tests and unsupported hosts.
class NoopScreenWakeLock implements ScreenWakeLock {
  @override
  Future<void> enable() async {}

  @override
  Future<void> disable() async {}
}
