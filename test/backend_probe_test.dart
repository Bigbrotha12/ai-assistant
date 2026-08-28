import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';

const _host = 'myhost';
const _secret = 's3cret';
const _tokenMintUrl = 'http://myhost:17602/healthz';
const _tokenMintTokenUrl = 'http://myhost:17602/token';
const _llmProxyUrl = 'http://myhost:9091/v1/chat/completions';

final _settings = BackendSettings(host: _host, secret: _secret);

/// WebSocket channel double. The probe only awaits `sink.close()`, so the
/// remaining interface members are covered by [noSuchMethod].
class FakeWebSocketChannel implements WebSocketChannel {
  FakeWebSocketChannel({WebSocketSink? sink})
      : sink = sink ?? FakeWebSocketSink();

  @override
  final WebSocketSink sink;

  @override
  Future<void> get ready => Future.value();

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} is not stubbed');
}

class FakeWebSocketSink implements WebSocketSink {
  bool closed = false;

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    closed = true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} is not stubbed');
}

/// Fresh [Dio] wired to a mock adapter that matches on URL path only
/// (ignores request body/headers).
(Dio, DioAdapter) makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

WebSocketConnector okConnector = (Uri uri) async => FakeWebSocketChannel();

/// A non-2xx server response surfaced as a `badResponse` [DioException].
DioException httpError(String path, int statusCode) => DioException(
      requestOptions: RequestOptions(path: path),
      response: Response(
        requestOptions: RequestOptions(path: path),
        statusCode: statusCode,
      ),
      type: DioExceptionType.badResponse,
    );

/// A network-family failure with the given [DioExceptionType].
DioException networkError(String path, DioExceptionType type) => DioException(
      requestOptions: RequestOptions(path: path),
      type: type,
    );

/// Registers healthy HTTP routes for every non-WebSocket endpoint.
void registerAllOk(DioAdapter adapter) {
  adapter.onGet(_tokenMintUrl, (r) => r.reply(200, {'status': 'ok'}));
  adapter.onPost(_tokenMintTokenUrl, (r) => r.reply(200, {'token': 'tok'}));
  adapter.onPost(_llmProxyUrl, (r) => r.reply(200, {'id': 'chat-1'}));
  adapter.onGet('http://myhost:9091/v1/models', (r) {
    return r.reply(200, {'data': [
      {'id': 'model.vl', 'capabilities': {'vision': true}},
    ]});
  });
}

/// Minimal stand-in for a browser `DomException` (dart:html / package:web),
/// which is unavailable in VM tests. The classifier only relies on `Object`
/// typing, so any non-IO error shape can be substituted.
class DomExceptionLike {
  DomExceptionLike(this.name);

  final String name;

  @override
  String toString() => 'DOMException: $name';
}

/// Captures every request so tests can assert on headers/options without a
/// matching mock route.
class CapturingAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions requestOptions,
    Stream<Uint8List>? requestStream,
    Future? cancelFuture,
  ) async {
    requests.add(requestOptions);
    final body = requestOptions.path.contains('/healthz')
        ? '{"status":"ok"}'
        : '{"ok":true}';
    return ResponseBody.fromString(body, 200, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('tokenMint', () {
    test('returns ok on a healthy healthz', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_tokenMintUrl, (r) => r.reply(200, {'status': 'ok'}));
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.tokenMint);
      expect(result, isNotNull);
      expect(result!.status, ProbeStatus.ok);
    });

    test('returns error on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_tokenMintUrl, (r) => r.reply(500, {'status': 'down'}));
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.tokenMint)!.status,
        ProbeStatus.error,
      );
    });

    test('returns unreachable on a connection error', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _tokenMintUrl,
        (r) => r.throws(
          0,
          networkError(_tokenMintUrl, DioExceptionType.connectionError),
        ),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.tokenMint)!.status,
        ProbeStatus.unreachable,
      );
    });
  });

  group('tokenMintAuth', () {
    test('returns ok on 200', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(_tokenMintTokenUrl, (r) => r.reply(200, {'token': 'tok'}));
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.tokenMintAuth)!.status,
        ProbeStatus.ok,
      );
    });

    test('returns error with 401 in the detail', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _tokenMintTokenUrl,
        (r) => r.throws(401, httpError(_tokenMintTokenUrl, 401)),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.tokenMintAuth)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('401'));
    });

    test('returns error on 403', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _tokenMintTokenUrl,
        (r) => r.throws(403, httpError(_tokenMintTokenUrl, 403)),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.tokenMintAuth)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('403'));
    });

    test('returns unreachable on receive timeout', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _tokenMintTokenUrl,
        (r) => r.throws(
          0,
          networkError(_tokenMintTokenUrl, DioExceptionType.receiveTimeout),
        ),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.tokenMintAuth)!.status,
        ProbeStatus.unreachable,
      );
    });
  });

  group('liveKit', () {
    test('returns ok when the connection succeeds', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(
        dio: dio,
        wsConnector: (Uri uri) async => FakeWebSocketChannel(),
      );

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.liveKit)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'signaling reachable');
    });

    test('returns unreachable on SocketException', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(
        dio: dio,
        wsConnector: (Uri uri) async =>
            throw const SocketException('connection refused'),
      );

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.liveKit)!.status,
        ProbeStatus.unreachable,
      );
    });

    test('returns unreachable on TimeoutException', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(
        dio: dio,
        wsConnector: (Uri uri) async => throw TimeoutException('too slow'),
      );

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.liveKit)!.status,
        ProbeStatus.unreachable,
      );
    });

    test('returns ok when the server rejects the upgrade', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(
        dio: dio,
        wsConnector: (Uri uri) async =>
            throw WebSocketChannelException('upgrade rejected'),
      );

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.liveKit)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'signaling reachable (server responded)');
    });

    test('returns unreachable when the upgrade failure wraps a network error',
        () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(
        dio: dio,
        wsConnector: (Uri uri) async => throw WebSocketChannelException.from(
          const SocketException('connection reset'),
        ),
      );

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.liveKit)!.status,
        ProbeStatus.unreachable,
      );
    });

    group('web classification', () {
      tearDown(() => debugWebPlatform = false);

      test('classifies a channel failure wrapping a browser error as '
          'unreachable', () async {
        debugWebPlatform = true;
        final (dio, adapter) = makeDio();
        registerAllOk(adapter);
        final probe = DioBackendProbe(
          dio: dio,
          wsConnector: (Uri uri) async =>
              throw WebSocketChannelException.from(
            DomExceptionLike('NetworkError'),
          ),
        );

        final status = await probe.probe(_settings);

        final result = status.resultFor(BackendCheck.liveKit)!;
        expect(result.status, ProbeStatus.unreachable);
      });

      test('classifies a bare web connect failure as unreachable', () async {
        debugWebPlatform = true;
        final (dio, adapter) = makeDio();
        registerAllOk(adapter);
        final probe = DioBackendProbe(
          dio: dio,
          wsConnector: (Uri uri) async =>
              throw WebSocketChannelException('WebSocket connection failed.'),
        );

        final status = await probe.probe(_settings);

        expect(
          status.resultFor(BackendCheck.liveKit)!.status,
          ProbeStatus.unreachable,
        );
      });
    });
  });

  group('llmProxy', () {
    test('returns ok on 200', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(_llmProxyUrl, (r) => r.reply(200, {'id': 'chat-1'}));
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(status.resultFor(BackendCheck.llmProxy)!.status, ProbeStatus.ok);
    });

    test('returns error with 503 in the detail', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _llmProxyUrl,
        (r) => r.throws(503, httpError(_llmProxyUrl, 503)),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      final result = status.resultFor(BackendCheck.llmProxy)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('503'));
    });

    test('returns error on 502', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _llmProxyUrl,
        (r) => r.throws(502, httpError(_llmProxyUrl, 502)),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.llmProxy)!.status,
        ProbeStatus.error,
      );
    });

    test('returns unreachable on a network error', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _llmProxyUrl,
        (r) => r.throws(
          0,
          networkError(_llmProxyUrl, DioExceptionType.connectionError),
        ),
      );
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(
        status.resultFor(BackendCheck.llmProxy)!.status,
        ProbeStatus.unreachable,
      );
    });
  });

  group('aggregation', () {
    test('probe returns checks in the documented order', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(_settings);

      expect(status.checks.map((c) => c.check), [
        BackendCheck.tokenMint,
        BackendCheck.tokenMintAuth,
        BackendCheck.liveKit,
        BackendCheck.llmProxy,
        BackendCheck.vision,
      ]);
      for (final check in BackendCheck.values) {
        expect(status.resultFor(check)!.status, ProbeStatus.ok,
            reason: '$check should be ok');
      }
    });

    test('allOk is true only when every check is ok', () async {
      const ok = CheckResult(
        check: BackendCheck.tokenMint,
        status: ProbeStatus.ok,
        detail: 'ok',
      );

      final allOk = BackendStatus(checks: [
        ok,
        const CheckResult(
          check: BackendCheck.tokenMintAuth,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        const CheckResult(
          check: BackendCheck.liveKit,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        const CheckResult(
          check: BackendCheck.llmProxy,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
      ]);
      expect(allOk.allOk, isTrue);

      final withError = BackendStatus(checks: [
        ok,
        const CheckResult(
          check: BackendCheck.tokenMintAuth,
          status: ProbeStatus.error,
          detail: '401',
        ),
      ]);
      expect(withError.allOk, isFalse);
    });

    test('allOk is false when there are no checks', () {
      expect(const BackendStatus(checks: []).allOk, isFalse);
    });

    test('resultFor returns null for a check that was not run', () {
      const status = BackendStatus(checks: [
        CheckResult(
          check: BackendCheck.tokenMint,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
      ]);

      expect(status.resultFor(BackendCheck.llmProxy), isNull);
      expect(status.resultFor(BackendCheck.tokenMint), isNotNull);
    });

    test('probe completes and returns an aggregated BackendStatus', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status =
          await probe.probe(_settings).timeout(const Duration(seconds: 5));

      expect(status, isA<BackendStatus>());
      expect(status.checks, hasLength(5));
    });
  });

  group('request hardening', () {
    test('token-mint POST sends the bearer secret and never follows redirects',
        () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      await probe.probe(_settings);

      final tokenRequest =
          adapter.requests.firstWhere((r) => r.path.endsWith('/token'));
      expect(tokenRequest.method, 'POST');
      expect(tokenRequest.headers['Authorization'], 'Bearer $_secret');
      expect(tokenRequest.followRedirects, isFalse);
    });
  });

  group('invalid host', () {
    test('probe with a URL-like host reports failures instead of throwing',
        () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);
      final probe = DioBackendProbe(dio: dio, wsConnector: okConnector);

      final status = await probe.probe(
        const BackendSettings(host: 'https://evil.example', secret: 's3cret'),
      );

      expect(status.checks, hasLength(5));
      for (final check in status.checks) {
        expect(check.status, isNot(ProbeStatus.ok));
      }
    });
  });
}