import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'engine_config.dart';
import 'engine_registry.dart';
import 'engines/kokoro_tts_engine.dart';
import 'engines/whisper_stt_engine.dart';
import 'model_downloader.dart';
import 'stt_engine.dart';
import 'tts_engine.dart';

/// High-level status of a voice engine's model.
enum VoiceEngineStatus {
  /// Model file has not been downloaded yet.
  notStarted,

  /// Model download is in progress.
  downloading,

  /// Model file exists and the engine is ready.
  ready,

  /// Last download attempt failed.
  failed,

  /// The engine is not usable on this build (e.g. no model URL configured).
  ///
  /// Distinct from [failed]: nothing is broken, the feature is simply gated
  /// off. The UI hides such engines instead of offering a failing download.
  unavailable,
}

/// Manages the lifecycle of on-device voice engines: model downloads,
/// registration into [EngineRegistry], and status tracking.
///
/// Construct synchronously (model paths are derived from [modelDir]).
/// Call [initialize] once at app startup to ensure model files exist and
/// register the engines.
///
/// Implements [ChangeNotifier]: listeners are notified whenever model statuses
/// change (initialization completes or a download lands), so providers can
/// react to async registration instead of snapshotting stale state.
class EngineManager extends ChangeNotifier {
  EngineManager({String? modelDir})
      : _modelDir = modelDir ?? '.voice_models';

  final String _modelDir;

  final ModelDownloader _downloader = ModelDownloader();
  final Map<String, VoiceEngineStatus> _statuses = {};

  /// Lazily resolved absolute path to the model directory.
  String? _resolvedModelDir;

  /// Memoised initialization future; [initialize] is idempotent and awaitable.
  Future<void>? _initializedFuture;

  bool _disposed = false;

  /// Emits progress events for the currently-active model download, or a
  /// single null after the last event when no download is in flight.
  Stream<ModelDownloadProgress> get downloadProgress => _downloader.progress;

  /// Whether initialization has completed (engines registered, statuses set).
  ///
  /// Awaits the same memoised work as [initialize], so any caller can wait for
  /// engine registration before reading [sttEngine] / [ttsEngine].
  Future<void> get initialized => initialize();

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /// Ensures the model directory exists, checks which models are already
  /// downloaded, and registers engines into [EngineRegistry].
  ///
  /// Safe to call multiple times — subsequent calls return the same future.
  Future<void> initialize() => _initializedFuture ??= _initialize();

  Future<void> _initialize() async {
    final dir = await _resolveModelDir();

    _ensureSttEngineRegistered(
      EngineConfig.whisperTinyId,
      WhisperSttEngine(modelPath: '$dir/ggml-tiny.bin'),
    );
    _ensureTtsEngineRegistered(
      EngineConfig.kokoro82mId,
      KokoroTtsEngine(modelPath: '$dir/kokoro_82m.onnx'),
    );

    _refreshStatuses();
    _notify();
  }

  // ---------------------------------------------------------------------------
  // Model management
  // ---------------------------------------------------------------------------

  /// Downloads any models that are not yet present on disk.
  ///
  /// [progress] is invoked with the model ID each time a download starts so
  /// the UI can display per-model progress. Models whose URL is not configured
  /// (e.g. the Kokoro placeholder) are skipped and marked [unavailable] rather
  /// than attempted — a failing download would permanently poison the status.
  ///
  /// Returns `true` when every usable model is available.
  Future<bool> ensureModelsDownloaded({
    required void Function(String modelId) progress,
  }) async {
    final dir = await _resolveModelDir();

    for (final entry in _modelConfig.entries) {
      final id = entry.key;
      final config = entry.value;

      if (!config.downloadable) {
        _statuses[id] = VoiceEngineStatus.unavailable;
        continue;
      }

      final filePath = '$dir/${config.fileName}';
      if (File(filePath).existsSync()) {
        _statuses[id] = VoiceEngineStatus.ready;
        continue;
      }

      _statuses[id] = VoiceEngineStatus.downloading;
      progress(id);

      try {
        // ModelDownloader writes to `<dir>/ggml<modelType>.bin`. We rename the
        // result to the model's canonical file name once the download lands so
        // the engines (and status checks) find the file at the expected path.
        await _downloader.downloadModel(
          modelType: config.downloaderType,
          url: config.url,
          destinationPath: dir,
        );
        final produced = '$dir/${config.downloaderType}.bin';
        final target = '$dir/${config.fileName}';
        if (produced != target && File(produced).existsSync()) {
          final targetFile = File(target);
          if (targetFile.existsSync()) targetFile.deleteSync();
          await File(produced).rename(target);
        }
        _statuses[id] = VoiceEngineStatus.ready;
      } catch (e) {
        _statuses[id] = VoiceEngineStatus.failed;
        if (kDebugMode) {
          debugPrint('EngineManager: model "$id" download failed: $e');
        }
      }
    }

    _notify();
    return areModelsReady();
  }

  /// Whether every usable configured model exists on disk.
  Future<bool> areModelsReady() async {
    final dir = await _resolveModelDir();
    for (final entry in _modelConfig.entries) {
      final config = entry.value;
      if (!config.downloadable) continue;
      if (!File('$dir/${config.fileName}').existsSync()) {
        return false;
      }
    }
    return true;
  }

  /// Current status of a single model.
  VoiceEngineStatus getStatus(String modelId) =>
      _statuses[modelId] ?? VoiceEngineStatus.notStarted;

  /// Snapshot of all model statuses.
  Map<String, VoiceEngineStatus> get allStatuses =>
      Map.unmodifiable(_statuses);

  // ---------------------------------------------------------------------------
  // Engine access (convenience)
  // ---------------------------------------------------------------------------

  /// Returns the registered STT engine, or `null` if not registered yet.
  ///
  /// Registered asynchronously by [initialize]; await [initialized] first if
  /// a non-null engine is required.
  SttEngine? get sttEngine =>
      EngineRegistry.instance.getSttEngine(EngineConfig.whisperTinyId);

  /// Returns the registered TTS engine, or `null` if not registered yet.
  ///
  /// Registered asynchronously by [initialize]; await [initialized] first if
  /// a non-null engine is required.
  TtsEngine? get ttsEngine =>
      EngineRegistry.instance.getTtsEngine(EngineConfig.kokoro82mId);

  /// Releases the model downloader resources.
  @override
  void dispose() {
    _disposed = true;
    _downloader.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  static final _modelConfig = <String, _ModelConfig>{
    EngineConfig.whisperTinyId: _ModelConfig(
      fileName: 'ggml-tiny.bin',
      downloaderType: 'whisper_tiny',
      url: EngineConfig.whisperTinyUrl,
      downloadable: true,
    ),
    EngineConfig.kokoro82mId: _ModelConfig(
      fileName: 'kokoro_82m.onnx',
      downloaderType: 'kokoro_82m',
      url: EngineConfig.kokoro82mUrl,
      downloadable: EngineConfig.kokoro82mDownloadAvailable,
    ),
  };

  Future<String> _resolveModelDir() async {
    if (_resolvedModelDir != null) return _resolvedModelDir!;
    final base = await getApplicationDocumentsDirectory();
    _resolvedModelDir = '${base.path}/$_modelDir';
    // Ensure the directory exists.
    await Directory(_resolvedModelDir!).create(recursive: true);
    return _resolvedModelDir!;
  }

  void _ensureSttEngineRegistered(String id, SttEngine engine) {
    final registry = EngineRegistry.instance;
    if (registry.getSttEngine(id) == null) {
      registry.registerSttEngine(id, engine);
    }
  }

  void _ensureTtsEngineRegistered(String id, TtsEngine engine) {
    final registry = EngineRegistry.instance;
    if (registry.getTtsEngine(id) == null) {
      registry.registerTtsEngine(id, engine);
    }
  }

  void _refreshStatuses() {
    // Synchronous best-effort check; the resolved dir may not be available
    // yet if _resolveModelDir hasn't completed. In that case statuses remain
    // at their default (notStarted).
    final dir = _resolvedModelDir;
    if (dir == null) return;

    for (final entry in _modelConfig.entries) {
      final config = entry.value;
      if (!config.downloadable) {
        _statuses[entry.key] = VoiceEngineStatus.unavailable;
        continue;
      }
      if (File('$dir/${config.fileName}').existsSync()) {
        _statuses[entry.key] = VoiceEngineStatus.ready;
      } else {
        _statuses.putIfAbsent(
          entry.key,
          () => VoiceEngineStatus.notStarted,
        );
      }
    }
  }

  /// Fires to listeners unless the manager has already been disposed.
  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }
}

class _ModelConfig {
  const _ModelConfig({
    required this.fileName,
    required this.downloaderType,
    required this.url,
    required this.downloadable,
  });
  final String fileName;
  final String downloaderType;
  final String url;

  /// False when the model has no usable download URL on this build — the
  /// engine is kept registered but surfaced as `unavailable` (never
  /// downloaded, never reported ready against a nonexistent artifact).
  final bool downloadable;
}