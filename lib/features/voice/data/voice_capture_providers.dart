import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import './audio_session_manager.dart';
import './vad_processor.dart';
import './voice_capture_pipeline.dart';
import '../ui/voice_controller_provider.dart';
import '../ui/voice_lifecycle_observer.dart';
import '../ui/voice_settings_providers.dart';

/// Voice activity detection processor.
///
/// Sensitivity and minimum silence duration are sourced from persisted
/// [VoiceSettings]. Settings are read (not watched) at build time: the
/// async settings load (loading → data) must not rebuild this provider at
/// startup — a rebuild cascades into the capture pipeline and tears down
/// an in-flight hold-to-talk. Live settings changes are applied to the
/// running processor in place by [VoiceCapturePipelineNotifier].
final vadProcessorProvider = Provider<VadProcessor>((ref) {
  final settings = ref.read(voiceSettingsProvider).value;
  final processor = EnergyBasedVadProcessor(
    sensitivity: settings?.vadSensitivity ?? 0.5,
    minSilenceSeconds: settings?.minTurnSeconds ?? 0.5,
  );
  ref.onDispose(processor.dispose);
  return processor;
});

/// Platform audio session manager for voice conversations.
final audioSessionManagerProvider = Provider<AudioSessionManager>((ref) {
  final manager = AudioSessionManagerImpl();
  manager.initialize(); // Fire-and-forget; best-effort init.
  ref.onDispose(manager.dispose);
  return manager;
});

/// Orchestrates mic capture → VAD → VoiceController.
///
/// Rebuilds when any upstream dependency changes (VoiceController,
/// VAD processor, mic capture, or audio session).
final voiceCapturePipelineProvider =
    NotifierProvider<VoiceCapturePipelineNotifier, VoiceCapturePipeline>(
      VoiceCapturePipelineNotifier.new,
    );

class VoiceCapturePipelineNotifier extends Notifier<VoiceCapturePipeline> {
  static int _buildCount = 0;

  @override
  VoiceCapturePipeline build() {
    _buildCount++;
    if (kDebugMode) {
      debugPrint('Pipeline build #$_buildCount (rebuild=$_buildCount > 1)');
    }
    final pipeline = VoiceCapturePipeline(
      micCapture: ref.watch(micCaptureServiceProvider),
      vad: ref.watch(vadProcessorProvider),
      audioSession: ref.watch(audioSessionManagerProvider),
      voiceController: ref.watch(voiceControllerProvider),
    );

    // Apply voice-settings changes to the running VAD in place instead of
    // rebuilding the processor (and thereby this pipeline): a rebuild while
    // a hold is active stops the mic mid-utterance and drops the buffered
    // audio. Fires once at startup with the loaded settings, so the first
    // frame of a session already carries the persisted values.
    final vadSettingsSub = ref.listen(
      voiceSettingsProvider,
      (_, next) {
        pipeline.vad.setSensitivity(next.value?.vadSensitivity ?? 0.5);
        pipeline.vad.setMinSilenceSeconds(next.value?.minTurnSeconds ?? 0.5);
      },
    );
    ref.onDispose(() {
      vadSettingsSub.close();
      pipeline.dispose();
    });

    // Register a lifecycle observer here rather than in
    // VoiceControllerNotifier: the pipeline provider depends on the
    // controller, so a lifecycle read of the pipeline from the controller's
    // ref closed a dependency circle (Riverpod CircularDependencyError on
    // every background transition). The pipeline owns the recording state
    // this teardown needs anyway. Re-registration pairs with the notifier
    // rebuilds (onDispose removes the previous observer).
    final observer = VoiceLifecycleObserver(
      onBackground: _handleBackground,
      onForeground: _handleForeground,
    );
    WidgetsBinding.instance.addObserver(observer);
    ref.onDispose(observer.dispose);

    return pipeline;
  }

  /// Tears down recording and playback and ends the text conversation when
  /// the app moves to the background. Voice calls are short-lived; dropping
  /// the session on background is the conservative, audio-safe choice.
  Future<void> _handleBackground() async {
    if (kDebugMode) {
      debugPrint('Pipeline: app → background (recording=${state.isRecording})');
    }
    // Capture references before the first await: the notifier may be
    // rebuilt/disposed while the teardown is in flight, which would leave
    // this ref dead mid-await.
    final pipeline = state;
    final controller = ref.read(voiceControllerProvider);
    final session = ref.read(audioSessionManagerProvider);
    if (pipeline.isRecording) {
      await pipeline.stopRecording();
    }
    await controller.endConversation();
    // endConversation stops playback but owns no focus; a reply playing at
    // this moment would otherwise leak the audio focus for the app session.
    await session.abandonAudioFocus();
  }

  /// Resets the session to idle on foreground. Deliberately does not
  /// auto-reconnect — the user re-taps the mic to rejoin.
  Future<void> _handleForeground() async {
    final controller = ref.read(voiceControllerProvider);
    if (controller.state.isPaused) {
      await controller.resumeAfterInterruption();
    }
  }
}
