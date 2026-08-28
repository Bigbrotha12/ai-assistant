import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/core/files_service.dart';

const _base = 'http://host:17603';
const _token = 'secret';

(Dio, DioAdapter) _makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

FilesClientImpl _client(Dio dio) =>
    FilesClientImpl(dio: dio, baseUrl: _base, bearerToken: _token);

/// Captures every [RequestOptions] so tests can assert headers/options without
/// a matching mock route.
class CaptureAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions requestOptions,
    Stream<Uint8List>? requestStream,
    Future? cancelFuture,
  ) async {
    requests.add(requestOptions);
    return ResponseBody.fromString(
      jsonEncode({
        'id': 'f1',
        'filename': 'a.jpg',
        'sizeBytes': 1,
        'mimeType': 'image/jpeg',
      }),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('uploadFile', () {
    test('posts a multipart form with progress and returns FileInfo', () async {
      final (dio, adapter) = _makeDio();
      adapter.onPost(
        '$_base/files',
        (r) => r.reply(200, {
          'id': 'f1',
          'filename': 'photo.jpg',
          'sizeBytes': 4,
          'mimeType': 'image/jpeg',
        }),
      );
      final client = _client(dio);
      final file = File('${Directory.systemTemp.createTempSync('fs').path}/a.jpg')
        ..writeAsBytesSync([1, 2, 3, 4]);
      final progress = <int>[];
      final info = await client.uploadFile(
        path: file.path,
        filename: 'a.jpg',
        sizeBytes: 4,
        mimeType: 'image/jpeg',
        onProgress: (sent, total) => progress.add(sent),
      );

      expect(info.id, 'f1');
      expect(info.filename, 'photo.jpg');
      expect(info.sizeBytes, 4);
    });

    test('maps a non-2xx response to FilesServerError', () async {
      final (dio, adapter) = _makeDio();
      adapter.onPost(
        '$_base/files',
        (r) => r.throws(
          500,
          DioException(
            requestOptions: RequestOptions(path: '$_base/files'),
            response: Response(
              requestOptions: RequestOptions(path: '$_base/files'),
              statusCode: 500,
            ),
            type: DioExceptionType.badResponse,
          ),
        ),
      );
      final client = _client(dio);
      final file = File('${Directory.systemTemp.createTempSync('fs').path}/a.jpg')
        ..writeAsBytesSync([1]);

      expect(
        () => client.uploadFile(
          path: file.path,
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
        throwsA(isA<FilesServerError>()),
      );
    });

    test('maps a connection error to FilesNetworkError', () async {
      final (dio, adapter) = _makeDio();
      adapter.onPost(
        '$_base/files',
        (r) => r.throws(
          0,
          DioException(
            requestOptions: RequestOptions(path: '$_base/files'),
            type: DioExceptionType.connectionError,
          ),
        ),
      );
      final client = _client(dio);
      final file = File('${Directory.systemTemp.createTempSync('fs').path}/a.jpg')
        ..writeAsBytesSync([1]);

      expect(
        () => client.uploadFile(
          path: file.path,
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
        throwsA(isA<FilesNetworkError>()),
      );
    });

    test('sends multipart with bearer auth, no redirects, and wired progress',
        () async {
      final adapter = CaptureAdapter();
      final dio = Dio()..httpClientAdapter = adapter;
      final client = _client(dio);
      final file = File('${Directory.systemTemp.createTempSync('fs').path}/a.jpg')
        ..writeAsBytesSync([1]);
      final progressCalls = <(int, int)>[];

      await client.uploadFile(
        path: file.path,
        filename: 'a.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
        onProgress: (sent, total) => progressCalls.add((sent, total)),
      );

      final req = adapter.requests.single;
      expect(req.method, 'POST');
      expect(req.path, '$_base/files');
      expect(req.headers['Authorization'], 'Bearer $_token');
      expect(req.followRedirects, isFalse);
      expect(req.data, isA<FormData>());
      final form = req.data as FormData;
      expect(form.files.single.key, 'file');
      expect(form.files.single.value.filename, 'a.jpg');
      expect(form.fields.map((f) => f.key), containsAll(['filename', 'mimeType']));
      expect(req.onSendProgress, isNotNull);
      expect(progressCalls, isEmpty,
          reason: 'mock adapter emits no progress; the callback stays wired');
    });
  });

  group('listFiles', () {
    test('parses a list body', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet(
        '$_base/files',
        (r) => r.reply(200, [
          {'id': 'f1', 'filename': 'a.jpg', 'sizeBytes': 1, 'mimeType': 'image/jpeg'},
        ]),
      );
      final client = _client(dio);

      final files = await client.listFiles();

      expect(files, hasLength(1));
      expect(files.single.id, 'f1');
    });

    test('parses a {"files": [...]} body', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet(
        '$_base/files',
        (r) => r.reply(200, {
          'files': [
            {'id': 'f2', 'filename': 'b.png', 'sizeBytes': 2, 'mimeType': 'image/png'},
          ],
        }),
      );
      final client = _client(dio);

      final files = await client.listFiles();

      expect(files.single.id, 'f2');
    });

    test('returns an empty list for a bare/empty body', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet('$_base/files', (r) => r.reply(200, {}));
      final client = _client(dio);

      expect(await client.listFiles(), isEmpty);
    });
  });

  group('fetchFile', () {
    test('returns raw bytes', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet(
        '$_base/files/f1',
        (r) => r.reply(200, Uint8List.fromList([1, 2, 3, 4])),
      );
      final client = _client(dio);

      final bytes = await client.fetchFile('f1');

      expect(bytes, Uint8List.fromList([1, 2, 3, 4]));
    });

    test('rejects an unsafe file id before making a request', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet('$_base/files/x', (r) => r.reply(200, [1]));
      final client = _client(dio);

      expect(
        () => client.fetchFile('../etc/passwd'),
        throwsA(isA<FilesValidationError>()),
      );
    });
  });

  group('deleteFile', () {
    test('deletes a file by id', () async {
      final (dio, adapter) = _makeDio();
      adapter.onDelete('$_base/files/f1', (r) => r.reply(204, null));
      final client = _client(dio);

      await client.deleteFile('f1');
    });

    test('rejects an unsafe file id', () async {
      final (dio, adapter) = _makeDio();
      final client = _client(dio);

      expect(() => client.deleteFile('a b'), throwsA(isA<FilesValidationError>()));
    });
  });

  group('NoOpFilesClient', () {
    final noOp = NoOpFilesClient();

    test('listFiles returns an empty list', () async {
      expect(await noOp.listFiles(), isEmpty);
    });

    test('uploadFile throws StateError', () async {
      expect(
        () => noOp.uploadFile(
          path: 'x',
          filename: 'x.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
        throwsStateError,
      );
    });

    test('fetchFile throws StateError', () {
      expect(() => noOp.fetchFile('f1'), throwsStateError);
    });

    test('deleteFile is a no-op', () async {
      await noOp.deleteFile('f1');
    });
  });

  group('isSupportedImageMime', () {
    test('accepts jpeg, png and webp', () {
      expect(isSupportedImageMime('image/jpeg'), isTrue);
      expect(isSupportedImageMime('image/png'), isTrue);
      expect(isSupportedImageMime('image/webp'), isTrue);
    });

    test('rejects other mimes', () {
      expect(isSupportedImageMime('application/pdf'), isFalse);
      expect(isSupportedImageMime('image/gif'), isFalse);
    });
  });
}
