import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import './files_service.dart';
import '../../../core/network_errors.dart';
import './file_model.dart';

// The constructor assigns public params to private fields, which trips
// prefer_initializing_formals.
// ignore_for_file: prefer_initializing_formals

/// Drives concurrent background uploads through a [FilesClient], exposing live
/// job state to the UI via [jobs]. Uploads are async and non-blocking: callers
/// enqueue files and poll/observe [jobs] for progress.
class UploadQueue {
  UploadQueue({
    required FilesClient filesService,
    this.maxConcurrent = 2,
    List<Duration> retryBackoffs = const [
      Duration.zero,
      Duration(seconds: 1),
      Duration(seconds: 2),
    ],
  })  : _filesService = filesService,
        _retryBackoffs = retryBackoffs;

  final FilesClient _filesService;

  /// Maximum number of uploads in flight at once.
  final int maxConcurrent;

  /// Backoff delays between upload attempts; the first attempt is immediate.
  /// Injectable so tests can avoid real sleeps.
  final List<Duration> _retryBackoffs;

  /// Live upload jobs, newest first. Every mutation replaces the list or calls
  /// [ValueNotifier.notifyListeners].
  final ValueNotifier<List<UploadJob>> jobs = ValueNotifier(const []);

  final Uuid _uuid = const Uuid();
  bool _draining = false;

  /// Enqueues a file for upload and starts the worker loop. Returns the job id.
  ///
  /// Unsupported MIME types are rejected client-side (bandwidth savings): the
  /// job is added to [jobs] already marked failed with a clear error and is
  /// never handed to the upload worker.
  Future<String> enqueue({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
  }) async {
    final job = UploadJob(
      id: _uuid.v4(),
      uri: path,
      filename: sanitizeFilename(filename, mimeType: mimeType),
      sizeBytes: sizeBytes,
      mimeType: mimeType,
    );
    if (!isSupportedImageMime(mimeType)) {
      job.status = UploadStatus.failed;
      job.error =
          'Unsupported file type "$mimeType". Only JPEG, PNG and WEBP images '
          'are supported.';
      jobs.value = [...jobs.value, job];
      return job.id;
    }
    jobs.value = [...jobs.value, job];
    unawaited(_drain());
    return job.id;
  }

  Future<void> _drain() async {
    if (_draining) return;
    _draining = true;
    try {
      while (true) {
        final pending =
            jobs.value.where((j) => j.status == UploadStatus.pending).toList();
        if (pending.isEmpty) break;
        final batch = pending.take(maxConcurrent).toList();
        await Future.wait(batch.map(_process));
      }
    } finally {
      _draining = false;
    }
  }

  Future<void> _process(UploadJob job) async {
    if (job.status != UploadStatus.pending) return;
    job.status = UploadStatus.uploading;
    job.cancelToken = CancelToken();
    _notify();
    try {
      final info = await _uploadWithRetry(job);
      if (job.status != UploadStatus.uploading) return;
      job.status = UploadStatus.done;
      job.progress = 1.0;
      job.serverFileId = info.id;
      job.error = null;
    } catch (e) {
      if (job.status == UploadStatus.uploading) {
        job.status = UploadStatus.failed;
        job.progress = 0;
        job.error = _describeError(e);
      }
    } finally {
      job.cancelToken = null;
      _notify();
    }
  }

  Future<FileInfo> _uploadWithRetry(UploadJob job) async {
    for (var attempt = 0; attempt < _retryBackoffs.length; attempt++) {
      if (attempt > 0) {
        await Future<void>.delayed(_retryBackoffs[attempt]);
        if (job.status != UploadStatus.uploading) {
          throw const FilesCancelledError('cancelled');
        }
      }
      try {
        return await _filesService.uploadFile(
          path: job.uri,
          filename: job.filename,
          sizeBytes: job.sizeBytes,
          mimeType: job.mimeType,
          cancelToken: job.cancelToken,
          onProgress: (sent, total) {
            if (total > 0) {
              job.progress = sent / total;
              _notify();
            }
          },
        );
      } on FilesApiError catch (e) {
        if (e is! FilesNetworkError || attempt == _retryBackoffs.length - 1) {
          rethrow;
        }
      } on DioException catch (e) {
        if (e.type == DioExceptionType.cancel) {
          throw const FilesCancelledError('cancelled');
        }
        if (!isNetworkError(e) || attempt == _retryBackoffs.length - 1) {
          rethrow;
        }
      }
    }
    throw StateError('unreachable');
  }

  /// Marks [jobId] failed and cancels its in-flight request.
  void cancelJob(String jobId) {
    for (final job in jobs.value) {
      if (job.id != jobId) continue;
      if (job.status == UploadStatus.pending ||
          job.status == UploadStatus.uploading) {
        job.cancelToken?.cancel();
        job.cancelToken = null;
        job.status = UploadStatus.failed;
        job.progress = 0;
        job.error = 'cancelled';
        _notify();
      }
      return;
    }
  }

  /// Marks every pending/uploading job failed and cancels all in-flight
  /// requests. Called from [dispose] to prevent leaks.
  void cancelAll() {
    var changed = false;
    for (final job in jobs.value) {
      if (job.status == UploadStatus.pending ||
          job.status == UploadStatus.uploading) {
        job.cancelToken?.cancel();
        job.cancelToken = null;
        job.status = UploadStatus.failed;
        job.progress = 0;
        job.error = 'cancelled';
        changed = true;
      }
    }
    if (changed) _notify();
  }

  /// Releases all resources; cancels every in-flight upload.
  void dispose() => cancelAll();

  void _notify() => jobs.value = List.of(jobs.value);

  static String _describeError(Object e) {
    if (e is FilesApiError) return e.message;
    if (e is DioException) return describeDioError(e);
    return '$e';
  }
}
