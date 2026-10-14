import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/notifications/data/notif_client.dart';

/// Captures every actual request (path/headers) and returns a scripted
/// response body.
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter(this.body);

  final ResponseBody body;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return body;
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('parseNtfyEvent', () {
    test('parses a message event', () {
      const line =
          '{"id":"abc","event":"message","topic":"mytopic","message":"Hello","title":"Hi","click":"https://example.com"}';
      final message = parseNtfyEvent(line);
      expect(message, isNotNull);
      expect(message!.topic, 'mytopic');
      expect(message.title, 'Hi');
      expect(message.body, 'Hello');
      expect(message.link, 'https://example.com');
    });

    test('returns null for control events', () {
      expect(parseNtfyEvent('{"id":"x","event":"open","topic":"mytopic"}'),
          isNull);
      expect(
          parseNtfyEvent('{"id":"x","event":"keepalive","topic":"mytopic"}'),
          isNull);
    });

    test('returns null for malformed or empty lines', () {
      expect(parseNtfyEvent(''), isNull);
      expect(parseNtfyEvent('not json'), isNull);
      expect(parseNtfyEvent('{'), isNull);
    });

    test('returns null when message and title are both empty', () {
      expect(
          parseNtfyEvent(
              '{"id":"x","event":"message","topic":"t","message":"","title":""}'),
          isNull);
    });

    test('topic defaults to empty string', () {
      final message = parseNtfyEvent(
          '{"id":"x","event":"message","message":"Hi","title":"T"}');
      expect(message, isNotNull);
      expect(message!.topic, '');
    });
  });

  group('NtfyNotifClient', () {
    const base = 'https://ntfy.example';

    ResponseBody streamBody() => ResponseBody.fromString(
          '{"id":"a","event":"message","topic":"alerts","message":"Hi","title":"T"}\n',
          200,
        );

    test('subscribe sends Bearer token when accessToken is set', () async {
      final adapter = _CaptureAdapter(streamBody());
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = NtfyNotifClient(
        baseUrl: base,
        dio: dio,
        accessToken: 'test-token',
      );
      addTearDown(client.dispose);

      await client.subscribe('alerts');

      final req = adapter.requests.single;
      expect(req.uri.path, '/alerts/json');
      expect(req.headers['Authorization'], 'Bearer test-token');
    });

    test('subscribe sends no Authorization header without accessToken',
        () async {
      final adapter = _CaptureAdapter(streamBody());
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = NtfyNotifClient(baseUrl: base, dio: dio);
      addTearDown(client.dispose);

      await client.subscribe('alerts');

      final req = adapter.requests.single;
      expect(req.uri.path, '/alerts/json');
      expect(req.headers.containsKey('Authorization'), isFalse);
    });
  });
}