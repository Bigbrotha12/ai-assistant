import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/chat_client_provider.dart';
import '../../core/network_banner.dart';
import 'audio_playback_service.dart';
import 'engine_manager_provider.dart';
import 'mic_capture_service.dart';
import 'voice_capture_providers.dart';
import 'voice_controller.dart';

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
/// Rebuilds when backend settings or auth credentials change (the latter
/// matters after a re-auth mints a fresh API key): watching [chatApiClientProvider]
/// creates a fresh controller wired to a client carrying the current key.
final voiceControllerProvider =
    NotifierProvider<VoiceControllerNotifier, VoiceController>(
      VoiceControllerNotifier.new,
    );

class VoiceControllerNotifier extends Notifier<VoiceController> {
  void Function()? _enginesListener;

  @override
  VoiceController build() {
    final engineManager = ref.watch(engineManagerProvider);
    final sttEngine = engineManager.sttEngine;
    final ttsEngine = engineManager.ttsEngine;
    final controller = VoiceController(
      chatClient: ref.watch(chatApiClientProvider),
      micCapture: ref.read(micCaptureServiceProvider),
      playback: ref.read(audioPlaybackServiceProvider),
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

    ref.onDispose(() {
      if (_enginesListener != null) {
        engineManager.removeListener(_enginesListener!);
        _enginesListener = null;
      }
      unawaited(controller.dispose());
    });
    return controller;
  }
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
