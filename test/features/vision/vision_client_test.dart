import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/vision/data/vision_client.dart';
import 'package:ai_assistant/features/vision/data/vision_config.dart';

/// A scripted [HttpClientAdapter] for vision client tests.
class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter();

  final List<_VisionAction> actions = [];
  final List<RequestOptions> requests = [];

  int _calls = 0;
  int get callCount => _calls;

  void addResponse(Map<String, dynamic> body, {int statusCode = 200}) {
    actions.add(_JsonAction(body, statusCode));
  }

  void addError(int statusCode, {String body = ''}) {
    actions.add(_ErrorAction(statusCode, body: body));
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final index = _calls < actions.length ? _calls : actions.length - 1;
    _calls++;
    requests.add(options);

    final action = actions[index];
    switch (action) {
      case _JsonAction a:
        return ResponseBody(
          Stream.fromIterable([
            Uint8List.fromList(utf8.encode(jsonEncode(a.body))),
          ]),
          a.statusCode,
          headers: {'content-type': ['application/json']},
        );
      case _ErrorAction a:
        return ResponseBody(
          Stream.fromIterable([
            Uint8List.fromList(utf8.encode(a.body)),
          ]),
          a.statusCode,
        );
    }
  }

  @override
  void close({bool force = false}) {}
}

sealed class _VisionAction {}

class _JsonAction extends _VisionAction {
  _JsonAction(this.body, this.statusCode);

  final Map<String, dynamic> body;
  final int statusCode;
}

class _ErrorAction extends _VisionAction {
  _ErrorAction(this.statusCode, {this.body = ''});

  final int statusCode;
  final String body;
}

VisionApiClient _client(
  _ScriptedAdapter adapter, {
  String baseUrl = 'http://test.local',
  String? apiKey,
}) =>
    VisionApiClient(
      baseUrl: baseUrl,
      dio: Dio()..httpClientAdapter = adapter,
      apiKey: apiKey,
    );

void main() {
  group(VisionApiClient, () {
    late _ScriptedAdapter adapter;
    late VisionApiClient client;

    setUp(() {
      adapter = _ScriptedAdapter();
      client = _client(adapter);
    });

    test('describeImage returns description from successful response', () async {
      adapter.addResponse({
        'choices': [
          {
            'message': {
              'content': 'A beautiful sunset over the ocean.',
            },
          },
        ],
      });

      const imageBytes = [
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46,
      ];

      final result = await client.describeImage(
        bytes: Uint8List.fromList(imageBytes),
        mimeType: 'image/jpeg',
      );

      expect(result, 'A beautiful sunset over the ocean.');
      expect(adapter.requests, hasLength(1));
      final req = adapter.requests.single;
      expect(req.path.endsWith('/v1/chat/completions'), isTrue);
      final body = req.data as Map<String, dynamic>;
      expect(body['model'], kVisionModelRoute);
    });

    test('describeImage throws VisionServerError on empty choices', () async {
      adapter.addResponse({'choices': <dynamic>[]});

      const imageBytes = [0xFF, 0xD8];
      expect(
        () => client.describeImage(
          bytes: Uint8List.fromList(imageBytes),
          mimeType: 'image/png',
        ),
        throwsA(isA<VisionServerError>()),
      );
    });

    test('describeImage throws VisionServerError on malformed response',
        () async {
      adapter.addResponse({'choices': [null]});

      const imageBytes = [0xFF, 0xD8];
      expect(
        () => client.describeImage(
          bytes: Uint8List.fromList(imageBytes),
          mimeType: 'image/webp',
        ),
        throwsA(isA<VisionServerError>()),
      );
    });

    test('describeImage throws VisionServerError on empty content', () async {
      adapter.addResponse({
        'choices': [
          {'message': {'content': ''}},
        ],
      });

      const imageBytes = [0xFF, 0xD8];
      expect(
        () => client.describeImage(
          bytes: Uint8List.fromList(imageBytes),
          mimeType: 'image/jpeg',
        ),
        throwsA(isA<VisionServerError>()),
      );
    });

    test('describeImage includes image data URI in request', () async {
      adapter.addResponse({
        'choices': [
          {'message': {'content': 'A cat.'}},
        ],
      });

      const imageBytes = [0x89, 0x50, 0x4E, 0x47];
      await client.describeImage(
        bytes: Uint8List.fromList(imageBytes),
        mimeType: 'image/png',
        prompt: 'What is in this image?',
      );

      final req = adapter.requests.single;
      final body = req.data as Map<String, dynamic>;
      final messages = body['messages'] as List;
      final userMsg = messages[0] as Map<String, dynamic>;
      final content = userMsg['content'] as List;
      final imageEntry = content[1] as Map<String, dynamic>;
      final imageUrl = imageEntry['image_url']['url'] as String;
      expect(imageUrl, startsWith('data:image/png;base64,'));
    });

    test('describeImage maps HTTP errors to VisionServerError', () async {
      adapter.addError(503);

      const imageBytes = [0xFF, 0xD8];
      await expectLater(
        client.describeImage(
          bytes: Uint8List.fromList(imageBytes),
          mimeType: 'image/jpeg',
        ),
        throwsA(
          isA<VisionServerError>()
              .having((e) => e.statusCode, 'statusCode', 503),
        ),
      );
    });

    test('describeImage sends Authorization: Bearer <key> when apiKey set',
        () async {
      adapter.addResponse({
        'choices': [
          {'message': {'content': 'A cat.'}},
        ],
      });
      final authClient = _client(adapter, apiKey: 'sk-test123');

      const imageBytes = [0x89, 0x50, 0x4E, 0x47];
      await authClient.describeImage(
        bytes: Uint8List.fromList(imageBytes),
        mimeType: 'image/png',
      );

      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer sk-test123',
      );
    });

    test('describeImage omits Authorization when apiKey is null', () async {
      adapter.addResponse({
        'choices': [
          {'message': {'content': 'A cat.'}},
        ],
      });

      const imageBytes = [0x89, 0x50, 0x4E, 0x47];
      await client.describeImage(
        bytes: Uint8List.fromList(imageBytes),
        mimeType: 'image/png',
      );

      final req = adapter.requests.single;
      expect(req.headers.containsKey('Authorization'), isFalse);
    });
  });

  group(NoOpVisionClient, () {
    test('describeImage throws VisionUnavailableError', () async {
      const client = NoOpVisionClient();
      expect(
        () => client.describeImage(
          bytes: Uint8List(10),
          mimeType: 'image/png',
        ),
        throwsA(isA<VisionUnavailableError>()),
      );
    });
  });
}
