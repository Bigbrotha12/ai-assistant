import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'audio_session_manager.dart';
import 'vad_processor.dart';
import 'voice_capture_pipeline.dart';
import 'voice_controller_provider.dart';
import 'voice_settings_providers.dart';

/// Voice activity detection processor.
///
/// Sensitivity and minimum silence duration are sourced from persisted
/// [VoiceSettings]. The provider rebuilds (creating a fresh processor)
/// when settings change, ensuring the new processor starts with the
/// correct values.
final vadProcessorProvider = Provider<VadProcessor>((ref) {
  final settingsAsync = ref.watch(voiceSettingsProvider);
  final sensitivity = settingsAsync.value?.vadSensitivity ?? 0.5;
  final minSilence = settingsAsync.value?.minTurnSeconds ?? 0.5;
  final processor =
      EnergyBasedVadProcessor(sensitivity: sensitivity, minSilenceSeconds: minSilence);
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
  @override
  VoiceCapturePipeline build() {
    final pipeline = VoiceCapturePipeline(
      micCapture: ref.watch(micCaptureServiceProvider),
      vad: ref.watch(vadProcessorProvider),
      audioSession: ref.watch(audioSessionManagerProvider),
      voiceController: ref.watch(voiceControllerProvider),
    );
    ref.onDispose(pipeline.dispose);
    return pipeline;
  }
}
