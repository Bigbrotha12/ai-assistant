import 'dart:async';
import 'dart:io';

import 'package:ai_assistant/features/voice/data/model_downloader.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Scriptable [HttpClientAdapter] that serves canned bytes to a real [Dio].
///
/// [ModelDownloader] takes a [Dio] directly, so the lightest way to fake it is
/// a custom adapter that serves canned bytes with a `Content-Length` header.
/// Dio itself drives `onReceiveProgress` from that header while reading the
/// body, which is exactly how the downloader derives the expected file size in
/// production. This keeps the exercise on real `dart:io` file writes rather
/// than a hand-rolled `Dio` implementation.
class FakeModelDownloaderAdapter implements HttpClientAdapter {
  FakeModelDownloaderAdapter({
    this.bytes = const [],
    this.error,
    this.reportedTotal,
    this.gate,
  });

  List<int> bytes;

  /// When set, `fetch` throws a [DioException] before producing a body.
  Object? error;

  /// Total reported via the response `Content-Length` header (which Dio
  /// surfaces through `onReceiveProgress`). When non-null it overrides
  /// [bytes].length so tests can simulate a body that is shorter than the
  /// server's advertised Content-Length.
  int? reportedTotal;

  /// When set, `fetch` pauses here until the test completes it, so the
  /// mid-download state can be observed.
  Completer<void>? gate;

  /// The [RequestOptions] of every `fetch` call, in order.
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final pendingGate = gate;
    if (pendingGate != null) {
      await pendingGate.future;
    }
    final err = error;
    if (err != null) {
      throw DioException(requestOptions: options, error: err);
    }
    final total = reportedTotal ?? bytes.length;
    return ResponseBody.fromBytes(
      Uint8List.fromList(bytes),
      200,
      headers: {Headers.contentLengthHeader: ['$total']},
    );
  }

  @override
  void close({bool force = false}) {}
}

const _pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');
const _modelType = 'whisper_tiny';
const _modelUrl = 'https://example.invalid/models/whisper.bin';

/// Covers [ModelDownloader]'s atomic-write behaviour: downloads land on a
/// `<final>.part` temp file, are validated, then renamed into place, with the
/// partial file removed on any failure.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;
  late String modelPath;
  late String partPath;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('model_downloader_test_');
    modelPath = '${tempDir.path}/ggml$_modelType.bin';
    partPath = '$modelPath.part';
    // The constructor eagerly resolves the app documents directory via
    // path_provider; serve it from a temp dir so no platform channel is hit.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      _pathProviderChannel,
      (call) async => tempDir.path,
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_pathProviderChannel, null);
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  Dio dioWith(FakeModelDownloaderAdapter adapter) =>
      Dio()..httpClientAdapter = adapter;

  ModelDownloader newDownloader(FakeModelDownloaderAdapter adapter) {
    final downloader = ModelDownloader(dio: dioWith(adapter));
    addTearDown(downloader.dispose);
    return downloader;
  }

  Future<void> download(ModelDownloader downloader) => downloader.downloadModel(
        modelType: _modelType,
        url: _modelUrl,
        destinationPath: tempDir.path,
      );

  group('ModelDownloader atomic download', () {
    test('successful download writes final bytes and reaches Ready', () async {
      final payload = List<int>.generate(64, (i) => i);
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(bytes: payload),
      );

      final progress = <ModelDownloadProgress>[];
      final sub = downloader.progress.listen(progress.add);
      addTearDown(sub.cancel);

      await download(downloader);

      expect(downloader.getState(_modelType), isA<Ready>());
      expect(File(modelPath).readAsBytesSync(), payload);
      // The intermediate temp file must not linger.
      expect(File(partPath).existsSync(), isFalse);

      await Future<void>.delayed(Duration.zero);
      expect(progress.map((e) => e.status), ['downloading', 'complete']);
      expect(progress.last.percent, 1.0);
    });

    test('state is Downloading while the request is in flight', () async {
      final gate = Completer<void>();
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(bytes: [1, 2, 3], gate: gate),
      );

      final downloadFuture = download(downloader);
      await Future<void>.delayed(Duration.zero);

      expect(downloader.getState(_modelType), isA<Downloading>());

      gate.complete();
      await downloadFuture;

      expect(downloader.getState(_modelType), isA<Ready>());
    });

    test('empty body throws, leaves no final or temp file, not Ready',
        () async {
      final downloader = newDownloader(FakeModelDownloaderAdapter());

      await expectLater(
        download(downloader),
        throwsA(isA<Exception>()),
      );

      final state = downloader.getState(_modelType);
      expect(state, isA<Failed>());
      expect((state as Failed).error, contains('empty file'));
      expect(downloader.getState(_modelType), isNot(isA<Ready>()));
      expect(File(modelPath).existsSync(), isFalse);
      expect(File(partPath).existsSync(), isFalse);
    });

    test('body shorter than reported total throws and cleans up', () async {
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(bytes: [1, 2, 3, 4], reportedTotal: 10),
      );

      await expectLater(
        download(downloader),
        throwsA(isA<Exception>()),
      );

      final state = downloader.getState(_modelType);
      expect(state, isA<Failed>());
      expect((state as Failed).error, contains('size mismatch'));
      expect(downloader.getState(_modelType), isNot(isA<Ready>()));
      expect(File(modelPath).existsSync(), isFalse);
      expect(File(partPath).existsSync(), isFalse);
    });

    test('Dio error mid-download propagates and leaves no files', () async {
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(
          error: DioException(requestOptions: RequestOptions(path: _modelUrl)),
        ),
      );

      await expectLater(
        download(downloader),
        throwsA(isA<DioException>()),
      );

      final state = downloader.getState(_modelType);
      expect(state, isA<Failed>());
      expect((state as Failed).error, contains('DioException'));
      expect(downloader.getState(_modelType), isNot(isA<Ready>()));
      expect(File(modelPath).existsSync(), isFalse);
      expect(File(partPath).existsSync(), isFalse);
    });

    test('rename failure deletes the partial temp file and propagates',
        () async {
      // Occupying the final path with a directory forces the atomic rename to
      // fail, exercising the partial-file cleanup branch.
      Directory(modelPath).createSync(recursive: true);
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(bytes: [1, 2, 3]),
      );

      await expectLater(
        download(downloader),
        throwsA(isA<FileSystemException>()),
      );

      expect(downloader.getState(_modelType), isA<Failed>());
      expect(downloader.getState(_modelType), isNot(isA<Ready>()));
      // The partial temp file must be gone and the final path untouched.
      expect(File(partPath).existsSync(), isFalse);
      expect(Directory(modelPath).existsSync(), isTrue);
      expect(File(modelPath).existsSync(), isFalse);
    });
  });

  group('ModelDownloader state defaults', () {
    test('getState is NotStarted even with stray files on disk', () async {
      // Simulate leftover artifacts from a previously interrupted run.
      File(partPath).writeAsBytesSync([9, 9]);
      File(modelPath).writeAsBytesSync([1, 2, 3]);
      final downloader = newDownloader(FakeModelDownloaderAdapter());

      // ModelDownloader keeps state purely in memory; EngineManager's
      // _refreshStatuses() (not this class) is responsible for surfacing files
      // that already exist on disk, so a stray `.part` is never Ready.
      expect(downloader.getState(_modelType), isA<NotStarted>());
      expect(downloader.getState('unknown_model'), isA<NotStarted>());
    });

    test('existing final file is atomically replaced by a fresh download',
        () async {
      File(modelPath).writeAsBytesSync([9, 9, 9]);
      final downloader = newDownloader(
        FakeModelDownloaderAdapter(bytes: [4, 5, 6]),
      );

      await download(downloader);

      expect(downloader.getState(_modelType), isA<Ready>());
      expect(File(modelPath).readAsBytesSync(), [4, 5, 6]);
      expect(File(partPath).existsSync(), isFalse);
    });
  });
}