import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/notifications/data/notif_client.dart';

/// Scripts one response per call and records every request.
class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.respond);

  final ResponseBody Function(RequestOptions options, int call) respond;
  final List<RequestOptions> requests = [];
  int _calls = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final call = _calls++;
    requests.add(options);
    return respond(options, call);
  }

  @override
  void close({bool force = false}) {}
}

Uint8List _bytes(String text) => Uint8List.fromList(utf8.encode(text));

Future<void> _pump() => Future<void>.delayed(Duration.zero);

Future<void> _waitFor(bool Function() condition, {String? reason}) async {
  for (var i = 0; i < 500; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  fail(reason ?? 'condition not met');
}

GatewaySseNotifClient _client(
  Dio dio, {
  required Future<String?> Function() resolveApiKey,
}) => GatewaySseNotifClient(
  dio: dio,
  backendOrigin: 'https://gw.example',
  resolveApiKey: resolveApiKey,
  initialRetryDelay: const Duration(milliseconds: 5),
  maxRetryDelay: const Duration(milliseconds: 10),
);

void main() {
  group('parseNotifData', () {
    test('parses title and body', () {
      final message = parseNotifData('{"title":"Job t1","body":"done"}');
      expect(message, isNotNull);
      expect(message!.title, 'Job t1');
      expect(message.body, 'done');
    });

    test('returns null for malformed, non-object, or missing fields', () {
      expect(parseNotifData(''), isNull);
      expect(parseNotifData('not json'), isNull);
      expect(parseNotifData('{'), isNull);
      expect(parseNotifData('[1,2]'), isNull);
      expect(parseNotifData('{"title":"Job t1"}'), isNull);
      expect(parseNotifData('{"title":"","body":""}'), isNull);
    });
  });

  group('SseNotifParser', () {
    test('emits one message per data frame terminated by a blank line', () {
      final parser = SseNotifParser();
      expect(parser.addLine('data: {"title":"Job a","body":"1"}'), isNull);
      final message = parser.addLine('');
      expect(message, isNotNull);
      expect(message!.title, 'Job a');
    });

    test('ignores heartbeat comments', () {
      final parser = SseNotifParser();
      expect(parser.addLine(': keepalive'), isNull);
      expect(parser.addLine(''), isNull);
    });

    test('ignores non-data fields', () {
      final parser = SseNotifParser();
      expect(parser.addLine('event: message'), isNull);
      expect(parser.addLine('data: {"title":"Job a","body":"1"}'), isNull);
      final message = parser.addLine('');
      expect(message!.title, 'Job a');
    });
  });

  group('GatewaySseNotifClient', () {
    test('opens the owner-wide endpoint with bearer auth', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(() async {
        if (!controller.isClosed) await controller.close();
      });
      final adapter = _ScriptedAdapter(
        (_, _) => ResponseBody(controller.stream, 200),
      );
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = _client(dio, resolveApiKey: () async => 'key-1');
      addTearDown(client.dispose);

      await _waitFor(() => adapter.requests.isNotEmpty);
      final request = adapter.requests.single;
      expect(request.uri.toString(), 'https://gw.example/v1/notify/events');
      expect(request.headers['Authorization'], 'Bearer key-1');
      expect(request.headers['Accept'], 'text/event-stream');
      expect(request.responseType, ResponseType.stream);
    });

    test('emits parsed frames and ignores heartbeats', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(() async {
        if (!controller.isClosed) await controller.close();
      });
      final adapter = _ScriptedAdapter(
        (_, _) => ResponseBody(controller.stream, 200),
      );
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = _client(dio, resolveApiKey: () async => 'key-1');
      addTearDown(client.dispose);
      final received = <NotifMessage>[];
      final sub = client.messages.listen(received.add);
      addTearDown(sub.cancel);

      await _waitFor(() => adapter.requests.isNotEmpty);
      controller.add(_bytes('data: {"title":"Job t1","body":"one"}\n\n'));
      controller.add(_bytes(': keepalive\n\n'));
      controller.add(_bytes('data: {"title":"Job t2","body":"two"}\n\n'));
      await _waitFor(() => received.length == 2);

      expect(received.map((m) => m.title).toList(), ['Job t1', 'Job t2']);
      expect(received.map((m) => m.body).toList(), ['one', 'two']);
    });

    test('re-resolves credentials fresh and retries after a 401', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(() async {
        if (!controller.isClosed) await controller.close();
      });
      final keys = ['stale', 'fresh'];
      var resolved = 0;
      final adapter = _ScriptedAdapter((_, call) {
        if (call == 0) return ResponseBody.fromString('', 401);
        return ResponseBody(controller.stream, 200);
      });
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = _client(
        dio,
        resolveApiKey: () async =>
            keys[resolved < keys.length ? resolved++ : keys.length - 1],
      );
      addTearDown(client.dispose);
      final sub = client.messages.listen((_) {});
      addTearDown(sub.cancel);

      await _waitFor(() => adapter.requests.length >= 2);
      expect(adapter.requests[0].headers['Authorization'], 'Bearer stale');
      expect(adapter.requests[1].headers['Authorization'], 'Bearer fresh');
    });

    test('recovers from a network error by reconnecting', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(() async {
        if (!controller.isClosed) await controller.close();
      });
      final adapter = _ScriptedAdapter((options, call) {
        if (call == 0) {
          throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
          );
        }
        return ResponseBody(controller.stream, 200);
      });
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = _client(dio, resolveApiKey: () async => 'key-1');
      addTearDown(client.dispose);
      final sub = client.messages.listen((_) {});
      addTearDown(sub.cancel);

      await _waitFor(() => adapter.requests.length >= 2);
      expect(adapter.requests.length, greaterThanOrEqualTo(2));
      expect(adapter.requests[1].headers['Authorization'], 'Bearer key-1');
    });

    test('dispose cancels the request, stops reconnecting, closes the '
        'stream', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(() async {
        if (!controller.isClosed) await controller.close();
      });
      final adapter = _ScriptedAdapter(
        (_, _) => ResponseBody(controller.stream, 200),
      );
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = _client(dio, resolveApiKey: () async => 'key-1');
      var done = false;
      final sub = client.messages.listen((_) {}, onDone: () => done = true);

      await _waitFor(() => adapter.requests.isNotEmpty);
      final before = adapter.requests.length;

      await client.dispose();
      await _pump();

      expect(adapter.requests.first.cancelToken?.isCancelled, isTrue);
      expect(controller.hasListener, isFalse);
      expect(done, isTrue);
      expect(
        adapter.requests.length,
        before,
        reason: 'dispose must prevent reconnection',
      );
      await sub.cancel();
    });
  });
}
