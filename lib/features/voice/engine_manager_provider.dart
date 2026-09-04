import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'engine_config.dart';
import 'engine_manager.dart';
import 'engine_registry.dart';
import 'model_downloader.dart';
import 'stt_engine.dart';
import 'tts_engine.dart';

/// Singleton [EngineManager] instance.
final engineManagerProvider = Provider<EngineManager>((ref) {
  final manager = EngineManager();
  ref.onDispose(manager.dispose);
  // Trigger lazy initialisation (creates model directory, registers engines).
  // The future is memoised on the manager (`initialize()` is idempotent), so
  // providers can await `manager.initialized` before reading engines.
  manager.initialize();
  return manager;
});

/// Reactive map of model ID → [VoiceEngineStatus].
///
/// Re-emits whenever the manager completes async initialisation or a download
/// lands, so engine status can never go stale relative to registration.
final voiceEngineStatusProvider =
    NotifierProvider<VoiceEngineStatusNotifier, Map<String, VoiceEngineStatus>>(
      VoiceEngineStatusNotifier.new,
    );

class VoiceEngineStatusNotifier
    extends Notifier<Map<String, VoiceEngineStatus>> {
  void Function()? _listener;

  @override
  Map<String, VoiceEngineStatus> build() {
    final manager = ref.watch(engineManagerProvider);
    _listener = () => state = manager.allStatuses;
    manager.addListener(_listener!);
    ref.onDispose(() {
      manager.removeListener(_listener!);
      _listener = null;
    });
    return manager.allStatuses;
  }

  /// Triggers a download of all missing models and updates the status map
  /// after each model completes or fails.
  Future<void> downloadAllModels() async {
    final manager = ref.read(engineManagerProvider);
    await manager.ensureModelsDownloaded(
      progress: (modelId) {
        state = {...state, modelId: VoiceEngineStatus.downloading};
      },
    );
    // Snapshot final statuses.
    state = manager.allStatuses;
  }

  /// Triggers a download of only the model identified by [modelId] (targeted
  /// retry — e.g. re-downloading Supertonic after a failed attempt without
  /// re-touching Whisper) and snapshots the status map afterwards.
  Future<void> downloadModel(String modelId) async {
    final manager = ref.read(engineManagerProvider);
    await manager.downloadModel(modelId);
    state = manager.allStatuses;
  }
}

/// Progress events for the currently-active model download (if any).
final modelDownloadProgressProvider =
    StreamProvider<ModelDownloadProgress?>((ref) {
  final manager = ref.watch(engineManagerProvider);
  return manager.downloadProgress;
});

// ---------------------------------------------------------------------------
// Convenience providers for the individual engines
// ---------------------------------------------------------------------------

/// The registered STT engine (Whisper), or `null` if not registered yet.
///
/// Awaits [EngineManager.initialize] so consumers never read an unregistered
/// engine during the asynchronous model-dir resolution.
final sttEngineProvider = FutureProvider<SttEngine?>((ref) async {
  final manager = ref.watch(engineManagerProvider);
  await manager.initialize();
  return EngineRegistry.instance.getSttEngine(EngineConfig.whisperTinyId);
});

/// The registered TTS engine (Supertonic 3), or `null` if not registered yet.
///
/// Awaits [EngineManager.initialize] so consumers never read an unregistered
/// engine during the asynchronous model-dir resolution.
final ttsEngineProvider = FutureProvider<TtsEngine?>((ref) async {
  final manager = ref.watch(engineManagerProvider);
  await manager.initialize();
  return EngineRegistry.instance.getTtsEngine(EngineConfig.supertonic3Id);
});