import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'engine_config.dart';

/// Progress report for a model download.
class ModelDownloadProgress {
  const ModelDownloadProgress({required this.percent, required this.status});

  /// Percentage complete (0.0–1.0).
  final double percent;

  /// Human-readable status label (e.g. "downloading", "complete", "error").
  final String status;
}

/// Current download state for a model type.
sealed class ModelDownloadState {}

/// A download is in progress.
class Downloading extends ModelDownloadState {
  Downloading({
    this.receivedBytes = 0,
    this.totalBytes = 0,
    this.progress = 0.0,
  });

  final int receivedBytes;
  final int totalBytes;
  final double progress;
}

/// The model file is present and ready.
class Ready extends ModelDownloadState {}

/// The last download attempt failed.
class Failed extends ModelDownloadState {
  Failed({required this.error});

  final String error;
}

/// No download has been attempted yet.
class NotStarted extends ModelDownloadState {}

/// Downloads voice models (STT / TTS) from remote URLs and exposes
/// a progress stream.
///
/// Models are stored in a `.voice_models/` subdirectory of the
/// application documents directory.
class ModelDownloader {
  ModelDownloader({Dio? dio})
    : _dio = dio ?? Dio(),
      _modelDirectory = _loadModelDirectory();

  final Dio _dio;
  final Future<Directory> _modelDirectory;

  static Future<Directory> _loadModelDirectory() async {
    final base = await getApplicationDocumentsDirectory();
    return Directory('${base.path}${EngineConfig.modelStorageDir}');
  }

  final StreamController<ModelDownloadProgress> _progressController =
      StreamController.broadcast();

  /// All download progress events.
  Stream<ModelDownloadProgress> get progress => _progressController.stream;

  /// In-memory state keyed by model type (e.g. `'whisper_tiny'`).
  final Map<String, ModelDownloadState> _states = {};

  /// Downloads the model identified by [modelType] from its configured URL.
  ///
  /// Uses [EngineConfig] for the default URL and model type mapping.
  /// If [url] is provided it overrides the default; if [destinationPath]
  /// is provided it overrides the default location.
  Future<void> downloadModel({
    required String modelType,
    String? url,
    String? destinationPath,
  }) async {
    final resolvedUrl = url ?? _resolveUrl(modelType);
    final dir = destinationPath ?? (await _modelDirectory).path;
    final resolvedPath = '$dir/ggml$modelType.bin';

    _states[modelType] = Downloading();
    await _doDownload(modelType, resolvedUrl, resolvedPath);
  }

  Future<void> _doDownload(
    String modelType,
    String url,
    String resolvedPath,
  ) async {
    try {
      final dir = File(resolvedPath).parent;
      await dir.create(recursive: true);

      final response = await _dio.get<List<int>>(
        url,
        options: Options(
          responseType: ResponseType.bytes,
          followRedirects: true,
          maxRedirects: 5,
        ),
        onReceiveProgress: (received, total) {
          final progress = total > 0 ? received / total : 0.0;
          _progressController.add(
            ModelDownloadProgress(percent: progress, status: 'downloading'),
          );
          _states[modelType] = Downloading(
            receivedBytes: received,
            totalBytes: total,
            progress: progress,
          );
        },
      );

      final bytes = response.data;
      if (bytes == null) {
        throw Exception('download returned no data');
      }

      final file = File(resolvedPath);
      await file.writeAsBytes(bytes);

      _states[modelType] = Ready();
      _progressController.add(
        ModelDownloadProgress(percent: 1.0, status: 'complete'),
      );

      if (kDebugMode) {
        debugPrint('Model "$modelType" downloaded to $resolvedPath');
      }
    } catch (e) {
      final error = e.toString();
      _states[modelType] = Failed(error: error);
      _progressController.add(
        ModelDownloadProgress(percent: 0.0, status: 'error: $error'),
      );
      rethrow;
    }
  }

  /// Returns the current state for [modelType].
  ModelDownloadState getState(String modelType) =>
      _states[modelType] ?? NotStarted();

  String _resolveUrl(String modelType) {
    if (modelType == EngineConfig.whisperTinyId) {
      return EngineConfig.whisperTinyUrl;
    }
    if (modelType == EngineConfig.kokoro82mId) {
      return EngineConfig.kokoro82mUrl;
    }
    throw ArgumentError.value(modelType, 'modelType', 'Unknown model type');
  }

  /// Closes the progress stream controller.
  void dispose() => _progressController.close();
}
