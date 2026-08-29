import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/backend_settings.dart';
import '../../core/network_banner.dart';
import '../../core/config.dart';
import '../../core/files_providers.dart';
import '../../core/settings_providers.dart';
import 'audio_playback_service.dart';
import 'engine_manager_provider.dart';
import 'livekit_service.dart';
import 'mic_capture_service.dart';
import 'voice_capture_providers.dart';
import 'voice_controller.dart';
import 'voice_lifecycle_observer.dart';

/// Data-channel-only LiveKit session wired to the configured backend host.
///
/// Recreated when the backend host changes (a settings save disposes any
/// in-flight session).
final liveKitServiceProvider = Provider<LiveKitService>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final host = settings?.trimmedHost ?? BackendConfig.defaultHost;
  final service = LiveKitServiceImpl(host: host);
  ref.onDispose(service.dispose);
  return service;
});

/// Microphone capture streaming raw PCM16 chunks.
final micCaptureServiceProvider = Provider<MicCaptureService>((ref) {
  final service = RecordMicCaptureService();
  ref.onDispose(service.dispose);
  return service;
});

/// Audio playback of received AI TTS frames.
///
/// Typed as [AudioPlayback] so tests can substitute an in-memory fake without
/// bootstrapping a real audio player.
final audioPlaybackServiceProvider = Provider<AudioPlayback>((ref) {
  final service = AudioPlaybackService(
    audioSession: ref.watch(audioSessionManagerProvider),
  );
  ref.onDispose(service.dispose);
  return service;
});

/// Owns the [VoiceController] for the current (or next) conversation.
///
/// Rebuilds when backend settings change, creating a fresh controller wired
/// to a session against the new host.
final voiceControllerProvider =
    NotifierProvider<VoiceControllerNotifier, VoiceController>(
      VoiceControllerNotifier.new,
    );

class VoiceControllerNotifier extends Notifier<VoiceController> {
  VoiceLifecycleObserver? _lifecycleObserver;
  void Function()? _enginesListener;

  @override
  VoiceController build() {
    final settings = ref.watch(settingsProvider).value;
    final engineManager = ref.watch(engineManagerProvider);
    final sttEngine = engineManager.sttEngine;
    final ttsEngine = engineManager.ttsEngine;
    final controller = VoiceController(
      liveKit: ref.read(liveKitServiceProvider),
      micCapture: ref.read(micCaptureServiceProvider),
      playback: ref.read(audioPlaybackServiceProvider),
      tokenMinter: settings == null
          ? null
          : _tokenMinter(settings, ref.read(dioProvider)),
      sttEngine: sttEngine,
      ttsEngine: ttsEngine,
      onNetworkError: () {
        ref.read(networkStatusProvider.notifier).set(NetworkStatus.disconnected);
      },
    );

    // Engines register asynchronously (model-dir resolution happens on a
    // background task). If they haven't landed by the time the controller is
    // built, rebuild once they do — otherwise the controller would be stuck
    // without its on-device engines for the rest of the session.
    if (sttEngine == null || ttsEngine == null) {
      _enginesListener = () {
        final manager = ref.read(engineManagerProvider);
        if (manager.sttEngine == null && manager.ttsEngine == null) return;
        ref.invalidateSelf();
      };
      engineManager.addListener(_enginesListener!);
    }

    // Register a lifecycle observer so entering the background tears the
    // conversation down cleanly (even when the VoiceScreen is not visible).
    final previousObserver = _lifecycleObserver;
    _lifecycleObserver = VoiceLifecycleObserver(
      onBackground: _handleBackground,
      onForeground: _handleForeground,
    );
    WidgetsBinding.instance.addObserver(_lifecycleObserver!);
    previousObserver?.dispose();

    ref.onDispose(() {
      if (_enginesListener != null) {
        engineManager.removeListener(_enginesListener!);
        _enginesListener = null;
      }
      _lifecycleObserver?.dispose();
      _lifecycleObserver = null;
      unawaited(controller.dispose());
    });
    return controller;
  }

  /// Tears down recording and playback and disconnects the LiveKit room when
  /// the app moves to the background. Voice calls are short-lived; dropping
  /// the connection on background is the conservative, audio-safe choice.
  Future<void> _handleBackground() async {
    final pipeline = ref.read(voiceCapturePipelineProvider);
    if (pipeline.isRecording) {
      await pipeline.stopRecording();
    }
    await ref.read(voiceControllerProvider).disconnect();
  }

  /// Resets the session to idle on foreground. Deliberately does not
  /// auto-reconnect — the user re-taps the mic to rejoin.
  Future<void> _handleForeground() async {
    final controller = ref.read(voiceControllerProvider);
    if (controller.state.isPaused) {
      await controller.resumeAfterInterruption();
    }
  }

  /// Binds token minting to the configured backend (shared token-mint secret).
  VoiceTokenMinter _tokenMinter(BackendSettings settings, Dio dio) =>
      (roomName) => mintToken(
        host: settings.trimmedHost,
        roomName: roomName,
        secret: settings.secret.trim(),
        dio: dio,
      );
}

/// Reactive view of the current conversation's state.
final voiceConversationStateProvider =
    NotifierProvider<VoiceStateNotifier, VoiceConversationState>(
      VoiceStateNotifier.new,
    );

class VoiceStateNotifier extends Notifier<VoiceConversationState> {
  StreamSubscription<VoiceConversationState>? _subscription;

  @override
  VoiceConversationState build() {
    final controller = ref.watch(voiceControllerProvider);
    final previous = _subscription;
    _subscription = controller.stateStream.listen(
      (state) => this.state = state,
    );
    if (previous != null) {
      unawaited(previous.cancel());
    }
    ref.onDispose(() {
      final sub = _subscription;
      _subscription = null;
      if (sub != null) {
        unawaited(sub.cancel());
      }
    });
    return controller.state;
  }
}
