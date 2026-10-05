import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/notifications/data/notify_admin_client.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';

/// Captures every request and returns a scripted [ResponseBody].
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter(this.responder);

  final ResponseBody Function(RequestOptions options) responder;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return responder(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(Map<String, Object?> body, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );

NotifyAdminClient _client(_CaptureAdapter adapter) => NotifyAdminClient(
  dio: Dio()..httpClientAdapter = adapter,
  baseUrl: 'https://gw.test',
);

void main() {
  group('NotifyAdminClient', () {
    test('provision POSTs and parses the freshly minted token', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({
          'topic': 'assistant-owner-abc',
          'accessToken': 'tok-1',
          'newlyProvisioned': true,
        }),
      );
      final result = await _client(adapter)
          .provision(gatewayKey: 'gateway-key');

      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.uri.path, '/api/notify/provision');
      expect(request.uri.host, 'gw.test');
      expect(request.headers['Authorization'], 'Bearer gateway-key');
      expect(request.data, isNull);
      expect(result.topic, 'assistant-owner-abc');
      expect(result.accessToken, 'tok-1');
      expect(result.newlyProvisioned, isTrue);
    });

    test('provision parses a repeat call with a null token', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({
          'topic': 'assistant-owner-abc',
          'accessToken': null,
          'newlyProvisioned': false,
        }),
      );
      final result = await _client(adapter)
          .provision(gatewayKey: 'gateway-key');

      expect(result.accessToken, isNull);
      expect(result.newlyProvisioned, isFalse);
    });

    test('get GETs the topic with a null token', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({
          'topic': 'assistant-owner-abc',
          'accessToken': null,
          'newlyProvisioned': false,
        }),
      );
      final result = await _client(adapter).get(gatewayKey: 'gateway-key');

      expect(adapter.requests.single.method, 'GET');
      expect(adapter.requests.single.uri.path, '/api/notify/provision');
      expect(adapter.requests.single.data, isNull);
      expect(result, isNotNull);
      expect(result!.topic, 'assistant-owner-abc');
      expect(result.accessToken, isNull);
    });

    test('get 404 not_configured is the "not provisioned" state', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({'error': 'not_configured'}, status: 404),
      );
      final result = await _client(adapter).get(gatewayKey: 'gateway-key');
      expect(result, isNull);
    });

    test('get 404 with any other body surfaces instead of reading as absent',
        () async {
      final adapter = _CaptureAdapter(
        (_) => _json({'error': 'not_found'}, status: 404),
      );
      await expectLater(
        _client(adapter).get(gatewayKey: 'gateway-key'),
        throwsA(
          isA<PluginClientException>()
              .having((e) => e.code, 'code', 'not_found')
              .having((e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });

    test('get 404 with a non-JSON body surfaces as server_error', () async {
      final adapter = _CaptureAdapter(
        (_) => ResponseBody.fromString('<html>not found</html>', 404),
      );
      await expectLater(
        _client(adapter).get(gatewayKey: 'gateway-key'),
        throwsA(
          isA<PluginClientException>()
              .having((e) => e.code, 'code', 'server_error')
              .having((e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });

    test('rotate POSTs and parses the new token for the same topic', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({
          'topic': 'assistant-owner-abc',
          'accessToken': 'tok-2',
          'rotated': true,
        }),
      );
      final result = await _client(adapter).rotate(gatewayKey: 'gateway-key');

      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.uri.path, '/api/notify/rotate');
      expect(request.data, isNull);
      expect(result.topic, 'assistant-owner-abc');
      expect(result.accessToken, 'tok-2');
      expect(result.rotated, isTrue);
    });

    test('rotate 404 surfaces as NotifyNotConfiguredException', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({'error': 'not_configured'}, status: 404),
      );
      await expectLater(
        _client(adapter).rotate(gatewayKey: 'gateway-key'),
        throwsA(isA<NotifyNotConfiguredException>()),
      );
    });

    test('revoke POSTs to the revoke route', () async {
      final adapter = _CaptureAdapter((_) => _json({'revoked': true}));
      await _client(adapter).revoke(gatewayKey: 'gateway-key');

      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.uri.path, '/api/notify/revoke');
      expect(request.data, isNull);
    });

    test('a 401 maps to a typed unauthorized PluginClientException', () async {
      final adapter = _CaptureAdapter(
        (_) => _json({'error': 'unauthorized'}, status: 401),
      );
      await expectLater(
        _client(adapter).get(gatewayKey: 'gateway-key'),
        throwsA(
          isA<PluginClientException>()
              .having((e) => e.code, 'code', 'unauthorized')
              .having((e) => e.statusCode, 'statusCode', 401),
        ),
      );
    });

    test('a malformed response maps to invalid_response', () async {
      final adapter = _CaptureAdapter(
        (_) => ResponseBody.fromString('not json', 200),
      );
      await expectLater(
        _client(adapter).get(gatewayKey: 'gateway-key'),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'invalid_response',
          ),
        ),
      );
    });
  });
}
