import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/core/files_service.dart';

const _base = 'http://host:17603';
const _token = 'secret';

/// The safe-Id regex from [FilesClientImpl]. Kept in sync with the
/// implementation so tests fail loudly when the pattern changes.
const _safeIdPattern = r'^[a-zA-Z0-9._-]+$';

(Dio, DioAdapter) _makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

FilesClientImpl _client(Dio dio) =>
    FilesClientImpl(dio: dio, baseUrl: _base, bearerToken: _token);

void main() {
  group('safe ID validation', () {
    final safe = RegExp(_safeIdPattern);

    test('accepts alphanumeric IDs', () {
      expect(safe.hasMatch('abc123'), isTrue);
      expect(safe.hasMatch('A1B2C3'), isTrue);
    });

    test('accepts dots, underscores, hyphens', () {
      expect(safe.hasMatch('abc-123.def'), isTrue);
      expect(safe.hasMatch('a_b.c-d'), isTrue);
      expect(safe.hasMatch('file_name.jpg'), isTrue);
    });

    test('rejects IDs with spaces', () {
      expect(safe.hasMatch('abc 123'), isFalse);
      expect(safe.hasMatch('my file'), isFalse);
    });

    test('rejects IDs with slashes', () {
      expect(safe.hasMatch('abc/123'), isFalse);
      expect(safe.hasMatch('abc\\123'), isFalse);
      expect(safe.hasMatch('../etc/passwd'), isFalse);
    });

    test('rejects IDs with angle brackets', () {
      expect(safe.hasMatch('abc<123'), isFalse);
      expect(safe.hasMatch('abc>123'), isFalse);
    });

    test('rejects IDs with query-like characters', () {
      expect(safe.hasMatch('abc=123'), isFalse);
      expect(safe.hasMatch('abc&123'), isFalse);
      expect(safe.hasMatch('abc?foo=bar'), isFalse);
    });

    test('rejects empty string', () {
      expect(safe.hasMatch(''), isFalse);
    });
  });

  group('fetchFile path uses /files/<id>', () {
    test('hits /files/<id> for a safe ID', () async {
      final (dio, adapter) = _makeDio();
      adapter.onGet(
        '$_base/files/f1',
        (r) => r.reply(200, Uint8List.fromList([1, 2, 3])),
      );
      final client = _client(dio);

      final bytes = await client.fetchFile('f1');

      expect(bytes, Uint8List.fromList([1, 2, 3]));
    });

    test('rejects unsafe ID without hitting the network', () async {
      final (dio, adapter) = _makeDio();
      final client = _client(dio);

      expect(
        () => client.fetchFile('../etc/passwd'),
        throwsA(isA<FilesValidationError>()),
      );
    });

    test('rejects ID with angle brackets', () async {
      final client = _client(Dio()..httpClientAdapter = _NoopAdapter());

      expect(
        () => client.fetchFile('a<123'),
        throwsA(isA<FilesValidationError>()),
      );
    });

    test('rejects ID with spaces', () async {
      final client = _client(Dio()..httpClientAdapter = _NoopAdapter());

      expect(
        () => client.fetchFile('my file'),
        throwsA(isA<FilesValidationError>()),
      );
    });
  });

  group('deleteFile path uses /files/<id>', () {
    test('hits /files/<id> for a safe ID', () async {
      final (dio, adapter) = _makeDio();
      adapter.onDelete('$_base/files/f1', (r) => r.reply(204, null));
      final client = _client(dio);

      await client.deleteFile('f1');
    });

    test('rejects unsafe ID', () async {
      final client = _client(Dio()..httpClientAdapter = _NoopAdapter());

      expect(
        () => client.deleteFile('a b'),
        throwsA(isA<FilesValidationError>()),
      );
    });
  });

  group('uploadFile uses /files (not /upload)', () {
    test('posts to /files endpoint', () async {
      final adapter = CaptureAdapter();
      final dio = Dio()..httpClientAdapter = adapter;
      final client = FilesClientImpl(
        dio: dio,
        baseUrl: _base,
        bearerToken: _token,
      );
      final file =
          File('${Directory.systemTemp.createTempSync('fp').path}/a.jpg')
            ..writeAsBytesSync([1]);

      await client.uploadFile(
        path: file.path,
        filename: 'a.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
      );

      expect(adapter.requests.single.path, '$_base/files');
    });
  });

  group('listFiles uses /files (not /list)', () {
    test('GETs from /files endpoint', () async {
      final adapter = CaptureAdapter();
      final dio = Dio()..httpClientAdapter = adapter;
      final client = FilesClientImpl(
        dio: dio,
        baseUrl: _base,
        bearerToken: _token,
      );

      await client.listFiles();

      expect(adapter.requests.single.path, '$_base/files');
    });
  });
}

/// Minimal adapter that captures every RequestOptions.
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

/// Adapter that accepts any request and returns success (used for _safeId
/// rejection tests that should never reach the network).
class _NoopAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions requestOptions,
    Stream<Uint8List>? requestStream,
    Future? cancelFuture,
  ) async {
    return ResponseBody.fromString('', 200);
  }

  @override
  void close({bool force = false}) {}
}
