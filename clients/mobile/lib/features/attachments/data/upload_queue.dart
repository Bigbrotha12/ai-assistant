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

const defaultUploadDrainTimeout = Duration(seconds: 125);

class UploadDrainTimeout implements Exception {
  UploadDrainTimeout(this.jobIds);

  final List<String> jobIds;

  @override
  String toString() =>
      'UploadDrainTimeout: ${jobIds.length} uploads did not settle';
}

/// Drives concurrent background uploads through a [FilesClient], exposing live
/// job state to the UI via [jobs]. Uploads are async and non-blocking: callers
/// enqueue files and poll/observe [jobs] for progress.
class UploadQueue {
  UploadQueue({
    required FilesClient filesService,
    this.maxConcurrent = 2,
    this.cancelDrainTimeout = defaultUploadDrainTimeout,
    List<Duration> retryBackoffs = const [
      Duration.zero,
      Duration(seconds: 1),
      Duration(seconds: 2),
    ],
  }) : _filesService = filesService,
       _retryBackoffs = retryBackoffs;

  final FilesClient _filesService;

  /// Maximum number of uploads in flight at once.
  final int maxConcurrent;

  /// Backoff delays between upload attempts; the first attempt is immediate.
  /// Injectable so tests can avoid real sleeps.
  final List<Duration> _retryBackoffs;

  final Duration cancelDrainTimeout;
  bool _closed = false;
  void Function()? _uploadAdmissionCheck;
  final Set<String> _inFlightJobIds = {};

  /// Live upload jobs, newest first. Every mutation replaces the list or calls
  /// [ValueNotifier.notifyListeners].
  final ValueNotifier<List<UploadJob>> jobs = ValueNotifier(const []);

  final Uuid _uuid = const Uuid();
  Future<void>? _worker;
  final Set<Future<void>> _inFlightProcesses = {};
  Future<void>? _cancelDrainFuture;

  void Function() attachUploadAdmissionCheck(void Function() check) {
    final previous = _uploadAdmissionCheck;
    _uploadAdmissionCheck = check;
    return () {
      if (identical(_uploadAdmissionCheck, check)) {
        _uploadAdmissionCheck = previous;
      }
    };
  }

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
    var blocked = _closed || _cancelDrainFuture != null;
    if (!blocked && _uploadAdmissionCheck != null) {
      try {
        _uploadAdmissionCheck!();
      } catch (_) {
        blocked = true;
      }
    }
    if (blocked) {
      job.status = UploadStatus.failed;
      job.error = 'cancelled';
      jobs.value = [...jobs.value, job];
      return job.id;
    }
    if (!isSupportedImageMime(mimeType)) {
      job.status = UploadStatus.failed;
      job.error =
          'Unsupported file type "$mimeType". Only JPEG, PNG and WEBP images '
          'are supported.';
      jobs.value = [...jobs.value, job];
      return job.id;
    }
    jobs.value = [...jobs.value, job];
    unawaited(_startWorker());
    return job.id;
  }

  Future<void> _startWorker() {
    final current = _worker;
    if (current != null) return current;
    late final Future<void> worker;
    worker = _drain().whenComplete(() {
      if (identical(_worker, worker)) _worker = null;
    });
    _worker = worker;
    return worker;
  }

  Future<void> _drain() async {
    while (true) {
      final pending = jobs.value
          .where((j) => j.status == UploadStatus.pending)
          .toList();
      if (pending.isEmpty) break;
      final batch = pending.take(maxConcurrent).toList();
      await Future.wait(batch.map(_process));
    }
  }

  Future<void> _process(UploadJob job) async {
    final settled = Completer<void>();
    final settledFuture = settled.future;
    _inFlightProcesses.add(settledFuture);
    _inFlightJobIds.add(job.id);
    try {
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
      }
    } finally {
      try {
        job.cancelToken = null;
        _notify();
      } finally {
        if (!settled.isCompleted) settled.complete();
        _inFlightProcesses.remove(settledFuture);
        _inFlightJobIds.remove(job.id);
      }
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

  /// Cancels all queued work and waits for every active upload to settle.
  Future<void> cancelAndDrain() {
    final current = _cancelDrainFuture;
    if (current != null) return current;
    _closed = true;
    cancelAll();
    late final Future<void> future;
    future = _drainInFlight()
        .timeout(
          cancelDrainTimeout,
          onTimeout: () {
            throw UploadDrainTimeout(_inFlightJobIds.toList());
          },
        )
        .whenComplete(() {
          if (identical(_cancelDrainFuture, future)) {
            _cancelDrainFuture = null;
          }
        });
    _cancelDrainFuture = future;
    return future;
  }

  Future<void> _drainInFlight() async {
    while (true) {
      final worker = _worker;
      if (worker != null) {
        await worker;
        continue;
      }
      final active = _inFlightProcesses.toList();
      if (active.isEmpty) return;
      await Future.wait(active);
    }
  }

  /// Releases all resources; cancels and drains every in-flight upload.
  void dispose() {
    unawaited(cancelAndDrain());
  }

  void _notify() => jobs.value = List.of(jobs.value);

  static String _describeError(Object e) {
    if (e is FilesApiError) return e.message;
    if (e is DioException) return describeDioError(e);
    return '$e';
  }
}
