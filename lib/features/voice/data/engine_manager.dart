import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../../core/app_data_dir.dart';
import './engine_config.dart';
import './engine_registry.dart';
import './engines/supertonic_tts_engine.dart';
import './engines/whisper_stt_engine.dart';
import './model_downloader.dart';
import './stt_engine.dart';
import './tts_engine.dart';

class VoiceModelReadiness {
  const VoiceModelReadiness({
    required this.sttReady,
    required this.ttsReady,
    required this.requiredDownloadBytes,
  });

  final bool sttReady;
  final bool ttsReady;
  final int? requiredDownloadBytes;
}

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
  EngineManager({String? modelDir, FreeStorageBytesReader? freeStorageBytes})
    : _modelDir = modelDir ?? '.voice_models',
      _downloader = ModelDownloader(freeStorageBytes: freeStorageBytes) {
    // Fold the downloader's per-artifact events into overall progress per
    // engine model, keyed by the engine model id the UI renders.
    _downloaderSub = _downloader.progress.listen(_onDownloaderProgress);
  }

  final String _modelDir;

  final ModelDownloader _downloader;
  final Map<String, VoiceEngineStatus> _statuses = {};
  StreamSubscription<ModelDownloadProgress>? _downloaderSub;

  /// Overall download progress (0.0–1.0) per engine model id (whisper /
  /// supertonic). Grows monotonically across a model's multiple artifact
  /// files, so a multi-file model reads as one continuous download.
  final StreamController<Map<String, double>> _modelProgressController =
      StreamController.broadcast();
  final Map<String, double> _modelProgress = {};

  /// Emits per-model overall progress snapshots while a download is in flight.
  Stream<Map<String, double>> get modelProgress =>
      _modelProgressController.stream;

  /// The registered TTS engine, kept so [dispose] can release its native
  /// resources.
  SupertonicTtsEngine? _ttsEngine;

  /// Lazily resolved absolute path to the model directory.
  String? _resolvedModelDir;

  /// Memoised initialization future; [initialize] is idempotent and awaitable.
  Future<void>? _initializedFuture;

  bool _disposed = false;

  /// Emits progress events for the currently-active model download, or a
  /// single null after the last event when no download is in flight.
  Stream<ModelDownloadProgress> get downloadProgress => _downloader.progress;

  /// Translates a downloader event into overall progress for the engine model
  /// it belongs to: `(artifactIndex + event.percent) / artifactCount`. Each
  /// completed file therefore advances the model's bar by `1/N` instead of
  /// restarting it, and only the model actually downloading is touched.
  void _onDownloaderProgress(ModelDownloadProgress event) {
    if (_disposed) return;
    for (final entry in _modelConfig.entries) {
      final types = _downloaderTypes(entry.value);
      final index = types.indexOf(event.modelType);
      if (index < 0) continue;
      final overall = ((index + event.percent) / types.length).clamp(0.0, 1.0);
      _modelProgress[entry.key] = overall;
      _modelProgressController.add(Map.unmodifiable(_modelProgress));
      return;
    }
  }

  /// Ordered artifact downloader types for a model (primary file first), used
  /// to index downloader progress events into an overall model percentage.
  static List<String> _downloaderTypes(_ModelConfig config) => [
    config.downloaderType,
    for (final artifact in config.artifacts) artifact.downloaderType,
  ];

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
      EngineConfig.supertonic3Id,
      _ttsEngine = SupertonicTtsEngine(
        modelDir: '$dir/${EngineConfig.supertonic3ModelDir}',
      ),
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
  /// (e.g. an unavailable Supertonic) are skipped and marked [unavailable]
  /// rather than attempted — a failing download would permanently poison the
  /// status.
  ///
  /// A "model" may consist of several artifacts (e.g. Supertonic's seven
  /// model files). All artifacts are downloaded to their canonical file names
  /// before the model is reported [ready].
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

      final allTargets = config.allTargets(dir);
      final missing = allTargets.where((t) => !File(t.path).existsSync());
      if (missing.isEmpty) {
        _statuses[id] = VoiceEngineStatus.ready;
        continue;
      }

      _statuses[id] = VoiceEngineStatus.downloading;
      progress(id);

      try {
        await _downloadArtifacts(config, dir);
        // Only mark ready if every artifact actually landed.
        _statuses[id] = allTargets.every((t) => File(t.path).existsSync())
            ? VoiceEngineStatus.ready
            : VoiceEngineStatus.failed;
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

  /// Downloads all missing artifacts of a single model (e.g. a targeted
  /// Supertonic retry after a failed attempt) without touching other models.
  ///
  /// Returns `true` when the model ended up [VoiceEngineStatus.ready].
  Future<bool> downloadModel(String modelId) async {
    final dir = await _resolveModelDir();
    final config = _modelConfig[modelId];
    if (config == null || !config.downloadable) {
      _statuses[modelId] = VoiceEngineStatus.unavailable;
      _notify();
      return false;
    }

    _statuses[modelId] = VoiceEngineStatus.downloading;
    _notify();
    try {
      await _downloadArtifacts(config, dir);
      _statuses[modelId] =
          config.allTargets(dir).every((t) => File(t.path).existsSync())
          ? VoiceEngineStatus.ready
          : VoiceEngineStatus.failed;
    } catch (e) {
      _statuses[modelId] = VoiceEngineStatus.failed;
      if (kDebugMode) {
        debugPrint('EngineManager: model "$modelId" download failed: $e');
      }
    }
    _notify();
    return getStatus(modelId) == VoiceEngineStatus.ready;
  }

  /// Deletes every artifact of [modelId] from disk (final files plus any
  /// leftover `.part` temp) and resets the model to [VoiceEngineStatus.notStarted]
  /// so it can be re-downloaded. Returns `true` when the model was deletable.
  Future<bool> deleteModel(String modelId) async {
    final config = _modelConfig[modelId];
    if (config == null || !config.downloadable) return false;
    final dir = await _resolveModelDir();
    for (final target in config.allTargets(dir)) {
      await _deleteIfExists(target);
      await _deleteIfExists(File('${target.path}.part'));
    }
    _statuses[modelId] = VoiceEngineStatus.notStarted;
    _modelProgress.remove(modelId);
    if (!_disposed) {
      _modelProgressController.add(Map.unmodifiable(_modelProgress));
    }
    _notify();
    return true;
  }

  /// Downloads every artifact of [config] into [dir] (primary file first,
  /// then the secondary artifacts). Callers own the status bookkeeping.
  Future<void> _downloadArtifacts(_ModelConfig config, String dir) async {
    // Each artifact lands at its canonical file name (the downloader's
    // optional `fileName` bypasses the legacy `ggml<type>.bin` notation),
    // so no post-download rename is required.
    await _downloader.downloadModel(
      modelType: config.downloaderType,
      url: config.url,
      destinationPath: dir,
      fileName: config.fileName,
      requiredBytes: config.estimatedBytes,
    );
    for (final artifact in config.artifacts) {
      await _downloader.downloadModel(
        modelType: artifact.downloaderType,
        url: artifact.url,
        destinationPath: dir,
        fileName: artifact.fileName,
        requiredBytes: config.estimatedBytes,
      );
    }
  }

  /// Whether every usable configured model exists on disk.
  Future<bool> areModelsReady() async {
    final dir = await _resolveModelDir();
    for (final entry in _modelConfig.entries) {
      final config = entry.value;
      if (!config.downloadable) continue;
      final targets = config.allTargets(dir);
      if (!targets.every((t) => File(t.path).existsSync())) {
        return false;
      }
    }
    return true;
  }

  /// Current status of a single model.
  VoiceEngineStatus getStatus(String modelId) =>
      _statuses[modelId] ?? VoiceEngineStatus.notStarted;

  /// Snapshot of all model statuses.
  Map<String, VoiceEngineStatus> get allStatuses => Map.unmodifiable(_statuses);

  VoiceModelReadiness? get modelReadiness {
    final dir = _resolvedModelDir;
    if (dir == null) return null;
    final sttConfig = _modelConfig[EngineConfig.whisperTinyId];
    final ttsConfig = _modelConfig[EngineConfig.supertonic3Id];
    final sttReady = sttConfig != null && _targetsReady(sttConfig, dir);
    final ttsReady = ttsConfig != null && _targetsReady(ttsConfig, dir);
    int? requiredBytes = 0;
    for (final config in _modelConfig.values) {
      if (!config.downloadable) continue;
      final missing = config
          .allTargets(dir)
          .where((target) => !target.existsSync())
          .isNotEmpty;
      if (!missing) continue;
      final estimate = config.estimatedBytes;
      if (estimate == null) {
        requiredBytes = null;
      } else if (requiredBytes != null) {
        requiredBytes += estimate;
      }
    }
    return VoiceModelReadiness(
      sttReady: sttReady,
      ttsReady: ttsReady,
      requiredDownloadBytes: requiredBytes,
    );
  }

  bool _targetsReady(_ModelConfig config, String dir) =>
      config.downloadable &&
      config.allTargets(dir).every((target) => target.existsSync());

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
      EngineRegistry.instance.getTtsEngine(EngineConfig.supertonic3Id);

  /// Releases the model downloader resources and the TTS engine's native
  /// backend (if it was created).
  @override
  void dispose() {
    _disposed = true;
    _downloaderSub?.cancel();
    _downloaderSub = null;
    _modelProgressController.close();
    _ttsEngine?.dispose();
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
      estimatedBytes: EngineConfig.whisperTinyEstimatedBytes,
    ),
    EngineConfig.supertonic3Id: _ModelConfig(
      fileName:
          '${EngineConfig.supertonic3ModelDir}/'
          '${EngineConfig.supertonic3TextEncoderFile}',
      downloaderType: EngineConfig.supertonic3TextEncoderId,
      url: EngineConfig.supertonic3TextEncoderUrl,
      downloadable: EngineConfig.supertonic3DownloadAvailable,
      estimatedBytes: EngineConfig.supertonic3EstimatedBytes,
      artifacts: [
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3DurationPredictorFile}',
          downloaderType: EngineConfig.supertonic3DurationPredictorId,
          url: EngineConfig.supertonic3DurationPredictorUrl,
        ),
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3VectorEstimatorFile}',
          downloaderType: EngineConfig.supertonic3VectorEstimatorId,
          url: EngineConfig.supertonic3VectorEstimatorUrl,
        ),
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3VocoderFile}',
          downloaderType: EngineConfig.supertonic3VocoderId,
          url: EngineConfig.supertonic3VocoderUrl,
        ),
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3TtsJsonFile}',
          downloaderType: EngineConfig.supertonic3TtsJsonId,
          url: EngineConfig.supertonic3TtsJsonUrl,
        ),
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3UnicodeIndexerFile}',
          downloaderType: EngineConfig.supertonic3UnicodeIndexerId,
          url: EngineConfig.supertonic3UnicodeIndexerUrl,
        ),
        _ArtifactConfig(
          fileName:
              '${EngineConfig.supertonic3ModelDir}/'
              '${EngineConfig.supertonic3VoiceFile}',
          downloaderType: EngineConfig.supertonic3VoiceId,
          url: EngineConfig.supertonic3VoiceUrl,
        ),
      ],
    ),
  };

  Future<String> _resolveModelDir() async {
    if (_resolvedModelDir != null) return _resolvedModelDir!;
    final base = await AppDataDir.resolve();
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
      if (config.allTargets(dir).every((t) => File(t.path).existsSync())) {
        _statuses[entry.key] = VoiceEngineStatus.ready;
      } else {
        _statuses.putIfAbsent(entry.key, () => VoiceEngineStatus.notStarted);
      }
    }
  }

  /// Fires to listeners unless the manager has already been disposed.
  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  /// Best-effort deletion of a model artifact or temp file, swallowing any
  /// secondary error (the caller decides whether the delete succeeded by
  /// checking the file system afterwards).
  static Future<void> _deleteIfExists(File file) async {
    try {
      if (await file.exists()) {
        await file.delete();
      }
    } catch (_) {
      // Intentionally ignored; the caller's status check is authoritative.
    }
  }
}

class _ModelConfig {
  const _ModelConfig({
    required this.fileName,
    required this.downloaderType,
    required this.url,
    required this.downloadable,
    this.estimatedBytes,
    this.artifacts = const [],
  });
  final String fileName;
  final String downloaderType;
  final String url;
  final int? estimatedBytes;

  /// Secondary artifacts (additional files) that make up this model, e.g.
  /// Supertonic's six non-primary model files. Downloaded alongside the
  /// primary file and all must exist before the model is reported [ready].
  final List<_ArtifactConfig> artifacts;

  /// False when the model has no usable download URL on this build — the
  /// engine is kept registered but surfaced as `unavailable` (never
  /// downloaded, never reported ready against a nonexistent artifact).
  final bool downloadable;

  /// The absolute [File] targets for the primary file and every artifact that
  /// must all be present for the model to be [VoiceEngineStatus.ready].
  List<File> allTargets(String dir) => [
    File('$dir/$fileName'),
    for (final a in artifacts) File('$dir/${a.fileName}'),
  ];
}

class _ArtifactConfig {
  const _ArtifactConfig({
    required this.fileName,
    required this.downloaderType,
    required this.url,
  });
  final String fileName;
  final String downloaderType;
  final String url;
}
