import 'dart:async';
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

/// Returns a different response body for each successive request, so a test can
/// model a dead stream followed by a successful reconnect.
class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.bodies);

  final List<ResponseBody Function()> bodies;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return bodies[requests.length - 1]();
  }

  @override
  void close({bool force = false}) {}
}

Future<void> _drain() async {
  for (var i = 0; i < 4; i++) {
    await Future<void>.delayed(Duration.zero);
  }
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

    test('a stream error frees the topic and allows a re-subscribe', () async {
      final adapter = _ScriptedAdapter([
        () => ResponseBody(Stream<Uint8List>.error(StateError('boom')), 200),
        () => ResponseBody.fromString('', 200),
      ]);
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = NtfyNotifClient(baseUrl: base, dio: dio);
      addTearDown(client.dispose);

      await client.subscribe('alerts');
      await _drain();
      // A dead stream must not leave `_subs` holding the topic: the second
      // subscribe has to open a fresh request rather than early-return.
      await client.subscribe('alerts');
      await _drain();

      expect(adapter.requests, hasLength(2));
    });

    test('a stream error is contained (no unhandled async error)', () async {
      final adapter = _ScriptedAdapter([
        () => ResponseBody(Stream<Uint8List>.error(StateError('boom')), 200),
      ]);
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = NtfyNotifClient(baseUrl: base, dio: dio);
      addTearDown(client.dispose);

      final uncaught = <Object>[];
      await runZonedGuarded(() async {
        await client.subscribe('alerts');
        await _drain();
      }, (error, _) => uncaught.add(error));

      expect(uncaught, isEmpty);
    });

    test('a completed stream frees the topic and allows a re-subscribe',
        () async {
      final adapter = _ScriptedAdapter([
        () => ResponseBody.fromString('', 200),
        () => ResponseBody.fromString('', 200),
      ]);
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = NtfyNotifClient(baseUrl: base, dio: dio);
      addTearDown(client.dispose);

      await client.subscribe('alerts');
      await _drain();
      await client.subscribe('alerts');
      await _drain();

      expect(adapter.requests, hasLength(2));
    });
  });
}