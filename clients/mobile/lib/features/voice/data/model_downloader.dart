import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/app_data_dir.dart';
import './engine_config.dart';

typedef FreeStorageBytesReader = Future<int?> Function();

class InsufficientStorageException implements Exception {
  const InsufficientStorageException({
    required this.requiredBytes,
    required this.availableBytes,
  });

  final int requiredBytes;
  final int? availableBytes;

  @override
  String toString() =>
      'InsufficientStorageException: '
      '$requiredBytes bytes required, '
      '${availableBytes == null ? 'unknown' : '$availableBytes'} bytes available';
}

class ModelDownloadLimitException implements Exception {
  const ModelDownloadLimitException({
    required this.maxBytes,
    required this.observedBytes,
  });

  final int maxBytes;
  final int observedBytes;

  @override
  String toString() =>
      'ModelDownloadLimitException: maximum $maxBytes bytes exceeded '
      '(observed $observedBytes bytes)';
}

/// Progress report for a model download.
class ModelDownloadProgress {
  const ModelDownloadProgress({
    required this.modelType,
    required this.percent,
    required this.status,
  });

  /// The downloader type this event belongs to (e.g. `whisper_tiny` or one of
  /// Supertonic's artifact ids). Lets consumers attribute progress to the right
  /// model when several are downloaded in sequence.
  final String modelType;

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
  ModelDownloader({
    Dio? dio,
    FreeStorageBytesReader? freeStorageBytes,
    int requiredBytesTolerance = EngineConfig.modelDownloadSizeToleranceBytes,
    int hardMaxBytes = EngineConfig.modelDownloadHardCapBytes,
  }) : this._(
         dio ?? Dio(),
         freeStorageBytes,
         requiredBytesTolerance,
         hardMaxBytes,
       );

  ModelDownloader._(
    this._dio,
    this._freeStorageBytes,
    this._requiredBytesTolerance,
    this._hardMaxBytes,
  ) : _modelDirectory = _loadModelDirectory() {
    if (_requiredBytesTolerance < 0) {
      throw ArgumentError.value(
        _requiredBytesTolerance,
        'requiredBytesTolerance',
        'must be non-negative',
      );
    }
    if (_hardMaxBytes < 0) {
      throw ArgumentError.value(
        _hardMaxBytes,
        'hardMaxBytes',
        'must be non-negative',
      );
    }
  }

  final Dio _dio;
  final FreeStorageBytesReader? _freeStorageBytes;
  final int _requiredBytesTolerance;
  final int _hardMaxBytes;
  final Future<Directory> _modelDirectory;

  static Future<Directory> _loadModelDirectory() async {
    final base = await AppDataDir.resolve();
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
    int? requiredBytes,
  }) async {
    final dir = destinationPath ?? (await _modelDirectory).path;
    final resolvedPath = fileName != null
        ? '$dir/$fileName'
        : '$dir/ggml$modelType.bin';

    _states[modelType] = Downloading();
    // Emit an immediate 0% so the UI never sits on a stale value while the
    // network connection is establishing.
    _progressController.add(
      ModelDownloadProgress(
        modelType: modelType,
        percent: 0.0,
        status: 'downloading',
      ),
    );
    await _doDownload(modelType, url, resolvedPath, requiredBytes);
  }

  Future<void> _doDownload(
    String modelType,
    String url,
    String resolvedPath,
    int? requiredBytes,
  ) async {
    try {
      await _preflight(requiredBytes);
      final dir = File(resolvedPath).parent;
      await dir.create(recursive: true);
      final maxBytes = _maxBytesFor(requiredBytes);
      final tempPath = '$resolvedPath.part';
      final tempFile = File(tempPath);
      ResponseBody? responseBody;
      RandomAccessFile? output;
      var received = 0;
      int? expectedTotal;

      try {
        final response = await _dio.get<ResponseBody>(
          url,
          options: Options(
            responseType: ResponseType.stream,
            followRedirects: true,
            maxRedirects: 5,
          ),
          onReceiveProgress: (count, total) {
            if (total > 0) expectedTotal = total;
            final progress = total > 0 ? count / total : 0.0;
            _progressController.add(
              ModelDownloadProgress(
                modelType: modelType,
                percent: progress,
                status: 'downloading',
              ),
            );
            _states[modelType] = Downloading(
              receivedBytes: count,
              totalBytes: total,
              progress: progress,
            );
          },
        );
        final body = response.data;
        if (body == null) throw Exception('download returned no data');
        responseBody = body;
        final contentLength = body.contentLength;
        if (contentLength > maxBytes) {
          throw ModelDownloadLimitException(
            maxBytes: maxBytes,
            observedBytes: contentLength,
          );
        }
        if (contentLength > 0) expectedTotal = contentLength;
        final fileOutput = await tempFile.open(mode: FileMode.write);
        output = fileOutput;
        await for (final chunk in body.stream) {
          final nextReceived = received + chunk.length;
          if (nextReceived > maxBytes) {
            throw ModelDownloadLimitException(
              maxBytes: maxBytes,
              observedBytes: nextReceived,
            );
          }
          await fileOutput.writeFrom(chunk);
          received = nextReceived;
        }
        await fileOutput.flush();
        await fileOutput.close();
        output = null;

        if (received == 0) throw Exception('download returned an empty file');
        final actualLength = await tempFile.length();
        if (actualLength > maxBytes) {
          throw ModelDownloadLimitException(
            maxBytes: maxBytes,
            observedBytes: actualLength,
          );
        }
        if (actualLength != received) {
          throw Exception(
            'download size mismatch: expected $received bytes, '
            'got $actualLength',
          );
        }
        final expected = expectedTotal;
        if (expected != null && expected > 0 && expected != received) {
          throw Exception(
            'download size mismatch: expected $expected bytes, '
            'got $received',
          );
        }
        await tempFile.rename(resolvedPath);
      } finally {
        if (responseBody != null) {
          try {
            (responseBody as dynamic).close();
          } catch (_) {}
        }
        if (output != null) {
          try {
            await output.close();
          } catch (_) {}
        }
      }

      _states[modelType] = Ready();
      _progressController.add(
        ModelDownloadProgress(
          modelType: modelType,
          percent: 1.0,
          status: 'complete',
        ),
      );

      if (kDebugMode) {
        debugPrint('Model "$modelType" downloaded to $resolvedPath');
      }
    } catch (e) {
      await _deleteIfExists(File('$resolvedPath.part'));
      final error = e.toString();
      _states[modelType] = Failed(error: error);
      _progressController.add(
        ModelDownloadProgress(
          modelType: modelType,
          percent: 0.0,
          status: 'error: $error',
        ),
      );
      rethrow;
    }
  }

  int _maxBytesFor(int? requiredBytes) {
    if (requiredBytes == null) return _hardMaxBytes;
    if (requiredBytes >= _hardMaxBytes) return _hardMaxBytes;
    final remaining = _hardMaxBytes - requiredBytes;
    return requiredBytes +
        (remaining < _requiredBytesTolerance
            ? remaining
            : _requiredBytesTolerance);
  }

  Future<void> _preflight(int? requiredBytes) async {
    final artifactBytes = requiredBytes ?? 0;
    if (artifactBytes < 0) {
      throw InsufficientStorageException(
        requiredBytes: artifactBytes,
        availableBytes: null,
      );
    }
    final required =
        artifactBytes + EngineConfig.modelDownloadSafetyMarginBytes;
    final reader = _freeStorageBytes;
    if (reader == null) return;
    int? available;
    try {
      available = await reader();
    } catch (_) {
      return;
    }
    if (available == null) return;
    if (available < 0 || available < required) {
      throw InsufficientStorageException(
        requiredBytes: required,
        availableBytes: available,
      );
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
