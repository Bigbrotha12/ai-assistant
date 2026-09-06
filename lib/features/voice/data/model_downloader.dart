import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import './engine_config.dart';

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
    return Directory('${base.path}/${EngineConfig.modelStorageDir}');
  }

  final StreamController<ModelDownloadProgress> _progressController =
      StreamController.broadcast();

  /// All download progress events.
  Stream<ModelDownloadProgress> get progress => _progressController.stream;

  /// In-memory state keyed by model type (e.g. `'whisper_tiny'`).
  final Map<String, ModelDownloadState> _states = {};

  /// Downloads the model identified by [modelType] from [url].
  ///
  /// Callers own the [modelType]→[url] mapping (via [EngineConfig] / the
  /// engine manager), so [url] is required rather than re-derived here. If
  /// [destinationPath] is provided it overrides the default location.
  ///
  /// [fileName] optionally overrides the output file name. When omitted the
  /// legacy `ggml<modelType>.bin` convention is used; when provided the bytes
  /// land directly at `$dir/$fileName` (used by the per-file TTS model
  /// artifacts — e.g. Supertonic's seven files — whose names differ from
  /// their model type; subdirectories inside [fileName] are created).
  Future<void> downloadModel({
    required String modelType,
    required String url,
    String? destinationPath,
    String? fileName,
  }) async {
    final dir = destinationPath ?? (await _modelDirectory).path;
    final resolvedPath =
        fileName != null ? '$dir/$fileName' : '$dir/ggml$modelType.bin';

    _states[modelType] = Downloading();
    await _doDownload(modelType, url, resolvedPath);
  }

  Future<void> _doDownload(
    String modelType,
    String url,
    String resolvedPath,
  ) async {
    try {
      final dir = File(resolvedPath).parent;
      await dir.create(recursive: true);

      int? expectedTotal;
      final response = await _dio.get<List<int>>(
        url,
        options: Options(
          responseType: ResponseType.bytes,
          followRedirects: true,
          maxRedirects: 5,
        ),
        onReceiveProgress: (received, total) {
          if (total > 0) expectedTotal = total;
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
      if (bytes.isEmpty) {
        throw Exception('download returned an empty file');
      }
      final expected = expectedTotal;
      if (expected != null && bytes.length != expected) {
        throw Exception(
          'download size mismatch: expected $expected bytes, '
          'got ${bytes.length}',
        );
      }

      // Write to a temp file in the same directory as the final model so a
      // partial or interrupted download can never be mistaken for the real
      // file. Only once the temp file is fully written and validated is it
      // atomically renamed into place.
      final tempPath = '$resolvedPath.part';
      final tempFile = File(tempPath);
      try {
        await tempFile.writeAsBytes(bytes, flush: true);
        await tempFile.rename(resolvedPath);
      } catch (_) {
        await _deleteIfExists(tempFile);
        rethrow;
      }

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

  /// Best-effort deletion of a partially written temp file, swallowing any
  /// secondary cleanup error so the original failure propagates.
  static Future<void> _deleteIfExists(File file) async {
    try {
      if (await file.exists()) {
        await file.delete();
      }
    } catch (_) {
      // Intentionally ignored; the caller's error takes precedence.
    }
  }

  /// Returns the current state for [modelType].
  ModelDownloadState getState(String modelType) =>
      _states[modelType] ?? NotStarted();

  /// Closes the progress stream controller.
  void dispose() => _progressController.close();
}
