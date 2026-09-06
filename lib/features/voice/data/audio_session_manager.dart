import 'dart:async';

import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';

/// Manages the platform audio session for voice conversations.
abstract interface class AudioSessionManager {
  /// Configure the audio session for play-and-record voice chat.
  Future<void> initialize();

  /// Acquire audio focus (activate the session).
  Future<void> requestAudioFocus();

  /// Release audio focus (deactivate the session).
  Future<void> abandonAudioFocus();

  /// Called when an OS-level audio interruption begins or ends.
  void handleInterruption({required bool isInterrupted});

  /// Whether audio focus is currently held.
  bool get hasAudioFocus;

  /// Callback invoked when an OS-level audio interruption begins or ends.
  void Function(bool isInterrupted)? onInterruption;

  /// Release all resources.
  Future<void> dispose();
}

class AudioSessionManagerImpl implements AudioSessionManager {
  AudioSessionManagerImpl();

  bool _hasAudioFocus = false;
  AudioSession? _session;
  StreamSubscription<AudioInterruptionEvent>? _interruptionSubscription;
  bool _initialized = false;
  bool _disposed = false;

  /// Callback invoked when an interruption begins or ends.
  @override
  void Function(bool isInterrupted)? onInterruption;

  @override
  Future<void> initialize() async {
    if (_initialized) return;
    try {
      final session = await AudioSession.instance;
      // dispose() may have run while the platform lookup was in flight; do
      // not configure/subscribe on a torn-down manager.
      if (_disposed) return;
      _session = session;
      await _session!.configure(
        AudioSessionConfiguration(
          avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
          avAudioSessionMode: AVAudioSessionMode.voiceChat,
          avAudioSessionCategoryOptions:
              AVAudioSessionCategoryOptions.defaultToSpeaker |
              AVAudioSessionCategoryOptions.duckOthers,
          androidAudioAttributes: const AndroidAudioAttributes(
            contentType: AndroidAudioContentType.speech,
            // USAGE_MEDIA, not voiceCommunication: the session is half-duplex
            // (hold-to-talk), so TTS belongs on the media stream — media
            // volume, speaker routing. voiceCommunication routes to the
            // earpiece with STREAM_VOICE_CALL volume, which reads as "TTS
            // produced samples but silence" when call volume is low/zero.
            usage: AndroidAudioUsage.media,
          ),
        ),
      );
      _interruptionSubscription =
          _session!.interruptionEventStream.listen(_onInterruptionEvent);
      _initialized = true;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('AudioSessionManager init failed: $e');
      }
    }
  }

  void _onInterruptionEvent(AudioInterruptionEvent event) {
    handleInterruption(isInterrupted: event.begin);
    onInterruption?.call(event.begin);
  }

  @override
  Future<void> requestAudioFocus() async {
    try {
      final session = _session ?? await AudioSession.instance;
      final activated = await session.setActive(true);
      _hasAudioFocus = activated;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('AudioSessionManager: requestAudioFocus failed: $e');
      }
    }
  }

  @override
  Future<void> abandonAudioFocus() async {
    try {
      final session = _session ?? await AudioSession.instance;
      await session.setActive(false);
      _hasAudioFocus = false;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('AudioSessionManager: abandonAudioFocus failed: $e');
      }
    }
  }

  @override
  void handleInterruption({required bool isInterrupted}) {
    if (kDebugMode) {
      debugPrint(
        'AudioSessionManager: interruption '
        '${isInterrupted ? "started" : "ended"}',
      );
    }
  }

  @override
  bool get hasAudioFocus => _hasAudioFocus;

  @override
  Future<void> dispose() async {
    _disposed = true;
    _interruptionSubscription?.cancel();
    _interruptionSubscription = null;
    if (_hasAudioFocus) {
      await abandonAudioFocus();
    }
  }
}
