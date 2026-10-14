import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/data/upload_queue.dart';

/// Scripted [FilesClient] that can record in-flight counts and fail
/// on demand.
class FakeFilesClient implements FilesClient {
  FakeFilesClient({this.failures = 0});

  /// Number of upload attempts that should throw before succeeding. Each
  /// failure throws a [FilesNetworkError] (retryable) or [FilesServerError]
  /// (non-retryable) based on [failWithServerError].
  int failures;
  bool failWithServerError = false;

  /// A single persistent error to throw on every call.
  Object? alwaysError;

  /// Number of upload calls made so far.
  int calls = 0;

  /// Peak number of uploads in flight simultaneously.
  int maxInFlight = 0;
  int _inFlight = 0;
  bool honorCancellation = true;

  /// Completers that, when set, block the next upload until completed.
  final List<Completer<void>> gates = [];

  int _gateIndex = 0;

  @override
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  }) async {
    calls++;
    _inFlight++;
    if (_inFlight > maxInFlight) maxInFlight = _inFlight;
    try {
      if (alwaysError != null) {
        throw alwaysError!;
      }
      if (_gateIndex < gates.length) {
        final gate = gates[_gateIndex++];
        if (cancelToken != null && honorCancellation) {
          await Future.any<Object?>([gate.future, cancelToken.whenCancel]);
        } else {
          await gate.future;
        }
        if (cancelToken != null &&
            honorCancellation &&
            cancelToken.isCancelled) {
          onProgress?.call(0, 100);
          throw const FilesCancelledError('cancelled');
        }
      }
      if (cancelToken != null) {
        cancelToken.whenCancel.then((_) => onProgress?.call(0, 100));
      }
      if (failures > 0) {
        failures--;
        throw failWithServerError
            ? const FilesServerError('HTTP 500', statusCode: 500)
            : const FilesNetworkError('unreachable');
      }
      onProgress?.call(sizeBytes, sizeBytes);
      return FileInfo(
        id: 'file-$calls',
        filename: filename,
        sizeBytes: sizeBytes,
        mimeType: mimeType,
      );
    } finally {
      _inFlight--;
    }
  }

  @override
  Future<List<FileInfo>> listFiles() async => const [];

  @override
  Future<Uint8List> fetchFile(
    String fileId, {
    CancelToken? cancelToken,
  }) async => Uint8List(0);

  @override
  Future<void> deleteFile(String fileId) async {}
}

void main() {
  test('uploads jobs sequentially and reports done', () async {
    final fake = FakeFilesClient();
    final queue = UploadQueue(filesService: fake, maxConcurrent: 2);

    final id = await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    expect(id, isNotEmpty);

    await Future<void>.delayed(const Duration(milliseconds: 50));
    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.done);
    expect(job.serverFileId, isNotNull);
    expect(job.progress, 1.0);
  });

  test('caps in-flight uploads at maxConcurrent', () async {
    final fake = FakeFilesClient()
      ..gates.addAll([Completer<void>(), Completer<void>(), Completer<void>()]);
    final queue = UploadQueue(filesService: fake, maxConcurrent: 2);

    for (var i = 0; i < 3; i++) {
      await queue.enqueue(
        path: '/tmp/f$i.jpg',
        filename: 'f$i.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
      );
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(fake.maxInFlight, lessThanOrEqualTo(2));

    for (final gate in fake.gates) {
      if (!gate.isCompleted) gate.complete();
    }
    await Future<void>.delayed(const Duration(milliseconds: 50));
    for (final job in queue.jobs.value) {
      expect(job.status, UploadStatus.done);
    }
  });

  test('marks a job failed on a non-retryable server error', () async {
    final fake = FakeFilesClient()
      ..failures = 1
      ..failWithServerError = true;
    final queue = UploadQueue(filesService: fake);

    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 50));

    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.failed);
    expect(fake.calls, 1, reason: 'non-retryable errors are not retried');
  });

  test('retries a network error up to three times then fails', () async {
    final fake = FakeFilesClient()..failures = 3;
    final queue = UploadQueue(
      filesService: fake,
      retryBackoffs: const [Duration.zero, Duration.zero, Duration.zero],
    );

    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(fake.calls, 3);
    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.failed);
  });

  test('succeeds after a transient network error retry', () async {
    final fake = FakeFilesClient()..failures = 1;
    final queue = UploadQueue(
      filesService: fake,
      retryBackoffs: const [Duration.zero, Duration.zero, Duration.zero],
    );

    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(fake.calls, 2);
    expect(queue.jobs.value.single.status, UploadStatus.done);
  });

  test('rejects non-image mime client-side', () async {
    final fake = FakeFilesClient();
    final queue = UploadQueue(filesService: fake);

    await queue.enqueue(
      path: '/tmp/a.pdf',
      filename: 'a.pdf',
      sizeBytes: 1,
      mimeType: 'application/pdf',
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.failed);
    expect(job.error, contains('Unsupported'));
    expect(fake.calls, 0, reason: 'no request should be made');
  });

  test('cancelJob marks the job failed', () async {
    final fake = FakeFilesClient()..gates.add(Completer<void>());
    final queue = UploadQueue(filesService: fake);

    final id = await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(fake.calls, 1, reason: 'upload should be in flight');
    queue.cancelJob(id);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.failed);
    expect(job.error, 'cancelled');
  });

  test('cancelAll marks every pending job failed', () async {
    final fake = FakeFilesClient();
    final queue = UploadQueue(filesService: fake, maxConcurrent: 1);

    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await queue.enqueue(
      path: '/tmp/b.jpg',
      filename: 'b.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    queue.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 30));

    for (final job in queue.jobs.value) {
      expect(job.status, isNot(UploadStatus.pending));
    }
  });

  test('cancelAndDrain waits for active uploads to settle', () async {
    final gate = Completer<void>();
    final fake = FakeFilesClient()
      ..honorCancellation = false
      ..gates.add(gate);
    final queue = UploadQueue(filesService: fake, maxConcurrent: 1);
    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    while (fake.calls == 0) {
      await Future<void>.delayed(Duration.zero);
    }

    var drained = false;
    final drain = queue.cancelAndDrain().then((_) => drained = true);
    await Future<void>.delayed(Duration.zero);
    expect(drained, isFalse);

    gate.complete();
    await drain;
    expect(drained, isTrue);
    expect(queue.jobs.value.single.status, UploadStatus.failed);
  });

  test(
    'cancelAndDrain reports a deadline and rejects late enqueue work',
    () async {
      final gate = Completer<void>();
      final fake = FakeFilesClient()
        ..honorCancellation = false
        ..gates.add(gate);
      final queue = UploadQueue(
        filesService: fake,
        maxConcurrent: 1,
        cancelDrainTimeout: const Duration(milliseconds: 20),
      );
      await queue.enqueue(
        path: '/tmp/a.jpg',
        filename: 'a.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
      );
      while (fake.calls == 0) {
        await Future<void>.delayed(Duration.zero);
      }

      await expectLater(
        queue.cancelAndDrain(),
        throwsA(isA<UploadDrainTimeout>()),
      );
      expect(queue.jobs.value.single.status, UploadStatus.failed);
      final lateId = await queue.enqueue(
        path: '/tmp/b.jpg',
        filename: 'b.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
      );
      expect(
        queue.jobs.value.singleWhere((job) => job.id == lateId).status,
        UploadStatus.failed,
      );

      gate.complete();
      await Future<void>.delayed(Duration.zero);
      expect(fake.calls, 1);
    },
  );

  test('cancelAndDrain is safe when called repeatedly', () async {
    final gate = Completer<void>();
    final fake = FakeFilesClient()
      ..honorCancellation = false
      ..gates.add(gate);
    final queue = UploadQueue(filesService: fake, maxConcurrent: 1);
    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    while (fake.calls == 0) {
      await Future<void>.delayed(Duration.zero);
    }

    final first = queue.cancelAndDrain();
    final second = queue.cancelAndDrain();
    expect(identical(first, second), isTrue);
    gate.complete();
    await Future.wait([first, second]);
  });

  test('cancelAndDrain completes immediately for an idle queue', () async {
    final queue = UploadQueue(filesService: FakeFilesClient());
    await expectLater(queue.cancelAndDrain(), completes);
    await expectLater(queue.cancelAndDrain(), completes);
  });

  test('a canceled upload that completes late never emits success', () async {
    final gate = Completer<void>();
    final fake = FakeFilesClient()
      ..honorCancellation = false
      ..gates.add(gate);
    final queue = UploadQueue(filesService: fake, maxConcurrent: 1);
    final statuses = <UploadStatus>[];
    queue.jobs.addListener(() {
      if (queue.jobs.value.isNotEmpty) {
        statuses.add(queue.jobs.value.single.status);
      }
    });
    await queue.enqueue(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    while (fake.calls == 0) {
      await Future<void>.delayed(Duration.zero);
    }

    final drain = queue.cancelAndDrain();
    gate.complete();
    await drain;

    final job = queue.jobs.value.single;
    expect(job.status, UploadStatus.failed);
    expect(job.serverFileId, isNull);
    expect(statuses, isNot(contains(UploadStatus.done)));
  });

  test('sanitizes the filename before upload', () async {
    final fake = FakeFilesClient();
    final queue = UploadQueue(filesService: fake);

    await queue.enqueue(
      path: '/tmp/a b.jpg',
      filename: 'a b.jpg',
      sizeBytes: 1,
      mimeType: 'image/jpeg',
    );
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(queue.jobs.value.single.filename, 'a_b.jpg');
  });
}
