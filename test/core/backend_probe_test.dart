import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';

const _host = 'myhost';
const _apiKey = 'sk_test123';
const _authUrl = 'http://myhost:17600/v1/auth/check';
const _inferenceUrl = 'http://myhost:17600/v1/chat/completions';
const _modelsUrl = 'http://myhost:17600/v1/models';
const _healthUrl = 'http://myhost:17600/health';

final _settings = const BackendSettings(host: _host);
Future<String?> _key() async => _apiKey;
Future<String?> _noKey() async => null;

/// Fresh [Dio] wired to a mock adapter that matches on URL path only
/// (ignores request body/headers).
(Dio, DioAdapter) makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

DioBackendProbe probe(Dio dio, {Future<String?> Function()? apiKeyReader}) =>
    DioBackendProbe(
      dio: dio,
      apiKeyReader: apiKeyReader ?? _key,
    );

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

/// Registers healthy routes for every probe endpoint.
void registerAllOk(DioAdapter adapter) {
  adapter.onGet(_authUrl, (r) => r.reply(200, {'status': 'ok'}));
  adapter.onPost(_inferenceUrl, (r) => r.reply(200, {'id': 'chat-1'}));
  adapter.onGet(_modelsUrl, (r) {
    return r.reply(200, {
      'data': [
        {'id': 'model.vl', 'vision_capable': true},
      ],
    });
  });
  adapter.onGet(_healthUrl, (r) {
    return r.reply(200, {
      'status': 'ok',
      'version': '1.0.0',
      'uptime': 12.5,
      'checks': {'authDb': 'ok', 'ledgerDb': 'ok'},
    });
  });
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
    return ResponseBody.fromString('{"ok":true}', 200, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('auth', () {
    test('returns ok on a 200 with a valid API key', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_authUrl, (r) => r.reply(200, {'status': 'ok'}));

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.auth);
      expect(result, isNotNull);
      expect(result!.status, ProbeStatus.ok);
    });

    test('returns unauthorized on a 401 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.throws(401, httpError(_authUrl, 401)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.auth)!;
      expect(result.status, ProbeStatus.unauthorized);
      expect(result.detail, contains('401'));
    });

    test('returns error on a 403 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.throws(403, httpError(_authUrl, 403)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.auth)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('403'));
    });

    test('returns emailNotVerified on a 403 email_not_verified response',
        () async {
      // C2: a valid key whose owner is unverified gets a DISTINCT outcome —
      // "verify your email", never the 401 re-auth flow.
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.reply(403, {'error': 'email_not_verified'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.auth)!;
      expect(result.status, ProbeStatus.emailNotVerified);
      expect(result.status, isNot(ProbeStatus.unauthorized));
      expect(result.detail, contains('verify your email'));
    });

    test('returns error on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.throws(500, httpError(_authUrl, 500)),
      );

      final status = await probe(dio).probe(_settings);

      expect(status.resultFor(BackendCheck.auth)!.status, ProbeStatus.error);
    });

    test('returns unreachable on a connection error', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.throws(
          0,
          networkError(_authUrl, DioExceptionType.connectionError),
        ),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.auth)!.status,
        ProbeStatus.unreachable,
      );
    });
  });

  group('inference', () {
    test('returns ok on 200', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(_inferenceUrl, (r) => r.reply(200, {'id': 'chat-1'}));

      final status = await probe(dio).probe(_settings);

      expect(status.resultFor(BackendCheck.inference)!.status, ProbeStatus.ok);
    });

    test('returns ok on 400 (probe model not found, gateway alive)', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.reply(400, {'error': 'model not found'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'gateway inference reachable');
    });

    test('returns ok on 422 (probe model not found, gateway alive)', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.reply(422, {'error': 'unprocessable'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.ok);
    });

    test('returns unauthorized on a 401 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.throws(401, httpError(_inferenceUrl, 401)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.unauthorized);
      expect(result.detail, contains('gateway API key'));
    });

    test('returns unauthorized when the gateway replies 401 (validateStatus bypass)',
        () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.reply(401, {'error': 'invalid_api_key'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.unauthorized);
      expect(result.detail, contains('gateway API key'));
    });

    test('returns emailNotVerified on a 403 email_not_verified response',
        () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.reply(403, {'error': 'email_not_verified'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.emailNotVerified);
      expect(result.status, isNot(ProbeStatus.unauthorized));
      expect(result.detail, contains('verify your email'));
    });

    test('returns error on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.reply(500, {'error': 'internal'}),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.inference)!.status,
        ProbeStatus.error,
      );
    });

    test('returns error with 503 in the detail', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.throws(503, httpError(_inferenceUrl, 503)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('503'));
    });

    test('returns error on 502', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.throws(502, httpError(_inferenceUrl, 502)),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.inference)!.status,
        ProbeStatus.error,
      );
    });

    test('returns unreachable on a network error', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.throws(
          0,
          networkError(_inferenceUrl, DioExceptionType.connectionError),
        ),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.inference)!.status,
        ProbeStatus.unreachable,
      );
    });

    test('returns noCredentials when no API key is stored', () async {
      final (dio, adapter) = makeDio();

      final status =
          await DioBackendProbe(dio: dio, apiKeyReader: _noKey)
              .probe(_settings);

      final inference = status.resultFor(BackendCheck.inference)!;
      expect(inference.status, ProbeStatus.noCredentials);
      expect(inference.detail, contains('no API key'));
      final vision = status.resultFor(BackendCheck.vision)!;
      expect(vision.status, ProbeStatus.noCredentials);
      expect(vision.detail, contains('no API key'));
    });
  });

  group('vision', () {
    test('returns ok when model.vl is available', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_modelsUrl, (r) {
        return r.reply(200, {
          'data': [
            {'id': 'model.vl', 'vision_capable': true},
          ],
        });
      });

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'vision-capable model available');
    });

    test('returns ok when a vision_capable model is found', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_modelsUrl, (r) {
        return r.reply(200, {
          'data': [
            {'id': 'model.audio'},
            {'id': 'model.vision', 'vision_capable': true},
          ],
        });
      });

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.ok);
    });

    test('returns unreachable when no vision-capable model', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.reply(200, {
          'data': [
            {'id': 'model.audio'},
          ],
        }),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.unreachable);
      expect(result.detail, 'no vision-capable model');
    });

    test('returns unauthorized on a 401 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.throws(401, httpError(_modelsUrl, 401)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.unauthorized);
      expect(result.detail, contains('gateway API key'));
    });

    test('returns emailNotVerified on a 403 email_not_verified response',
        () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.reply(403, {'error': 'email_not_verified'}),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.emailNotVerified);
      expect(result.status, isNot(ProbeStatus.unauthorized));
      expect(result.detail, contains('verify your email'));
    });

    test('returns error on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.throws(500, httpError(_modelsUrl, 500)),
      );

      final status = await probe(dio).probe(_settings);

      expect(status.resultFor(BackendCheck.vision)!.status, ProbeStatus.error);
    });

    test('returns unreachable on a connection error', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.throws(
          0,
          networkError(_modelsUrl, DioExceptionType.connectionError),
        ),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.vision)!.status,
        ProbeStatus.unreachable,
      );
    });
  });

  group('health', () {
    test('returns ok on a 200 with status ok', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_healthUrl, (r) {
        return r.reply(200, {
          'status': 'ok',
          'version': '1.0.0',
          'uptime': 3.5,
          'checks': {'authDb': 'ok', 'ledgerDb': 'ok'},
        });
      });

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.health)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'gateway healthy');
      expect(status.overall, isNot(ProbeStatus.gatewayDegraded));
    });

    test('returns gatewayDegraded on a 503 with status degraded', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_healthUrl, (r) {
        return r.reply(503, {
          'status': 'degraded',
          'version': '1.0.0',
          'uptime': 3.5,
          'checks': {'authDb': 'ok', 'ledgerDb': 'error'},
        });
      });

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.health)!;
      expect(result.status, ProbeStatus.gatewayDegraded);
      expect(result.status, isNot(ProbeStatus.error));
      expect(result.status, isNot(ProbeStatus.unreachable));
      expect(result.detail, contains('degraded'));
      expect(result.detail, contains('ledgerDb'));
      expect(result.detail, contains('503'));
    });

    test('any body saying degraded maps to gatewayDegraded (200 included)',
        () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _healthUrl,
        (r) => r.reply(200, {'status': 'degraded', 'checks': {}}),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.health)!.status,
        ProbeStatus.gatewayDegraded,
      );
    });

    test('returns error on a non-degraded non-ok response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_healthUrl, (r) => r.reply(500, {'error': 'boom'}));

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.health)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('500'));
    });

    test('returns unreachable on a connection error', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _healthUrl,
        (r) => r.throws(
          0,
          networkError(_healthUrl, DioExceptionType.connectionError),
        ),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.health)!;
      expect(result.status, ProbeStatus.unreachable);
      expect(status.overall, isNot(ProbeStatus.gatewayDegraded));
    });

    test('overall surfaces gatewayDegraded even when auth/inference pass',
        () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_authUrl, (r) => r.reply(200, {'status': 'ok'}));
      adapter.onPost(_inferenceUrl, (r) => r.reply(200, {'id': 'chat-1'}));
      adapter.onGet(_modelsUrl, (r) {
        return r.reply(200, {
          'data': [
            {'id': 'model.vl', 'vision_capable': true},
          ],
        });
      });
      adapter.onGet(
        _healthUrl,
        (r) => r.reply(503, {'status': 'degraded', 'checks': {}}),
      );

      final status = await probe(dio).probe(_settings);

      expect(status.resultFor(BackendCheck.auth)!.status, ProbeStatus.ok);
      expect(status.resultFor(BackendCheck.inference)!.status, ProbeStatus.ok);
      expect(status.resultFor(BackendCheck.vision)!.status, ProbeStatus.ok);
      expect(
        status.resultFor(BackendCheck.health)!.status,
        ProbeStatus.gatewayDegraded,
      );
      expect(status.allOk, isFalse);
      expect(status.overall, ProbeStatus.gatewayDegraded);
    });

    test('overall prefers unauthorized over gatewayDegraded', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.throws(401, httpError(_authUrl, 401)),
      );
      adapter.onGet(
        _healthUrl,
        (r) => r.reply(503, {'status': 'degraded', 'checks': {}}),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.health)!.status,
        ProbeStatus.gatewayDegraded,
      );
      expect(status.resultFor(BackendCheck.auth)!.status,
          ProbeStatus.unauthorized);
      expect(status.overall, ProbeStatus.unauthorized);
    });

    test('overall prefers emailNotVerified over gatewayDegraded', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _authUrl,
        (r) => r.reply(403, {'error': 'email_not_verified'}),
      );
      adapter.onGet(
        _healthUrl,
        (r) => r.reply(503, {'status': 'degraded', 'checks': {}}),
      );

      final status = await probe(dio).probe(_settings);

      expect(
        status.resultFor(BackendCheck.health)!.status,
        ProbeStatus.gatewayDegraded,
      );
      expect(status.resultFor(BackendCheck.auth)!.status,
          ProbeStatus.emailNotVerified);
      expect(status.overall, ProbeStatus.emailNotVerified);
    });

    test('health check sends no Authorization header', () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final healthRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/health'));
      expect(healthRequest.method, 'GET');
      expect(healthRequest.headers['Authorization'], isNull);
      expect(healthRequest.followRedirects, isFalse);
    });
  });

  group('credential read', () {
    test('returns a four-check status when the API key reader throws', () async {
      final (dio, adapter) = makeDio();
      var healthRequests = 0;
      adapter.onGet(_healthUrl, (r) {
        healthRequests++;
        return r.reply(200, {'status': 'ok'});
      });
      const secret = 'storage-secret-value';

      final status = await probe(
        dio,
        apiKeyReader: () async => throw StateError(secret),
      ).probe(_settings);

      expect(status.checks.map((check) => check.check), [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
        BackendCheck.health,
      ]);
      expect(healthRequests, 1);
      expect(status.resultFor(BackendCheck.health)!.status, ProbeStatus.ok);
      for (final check in [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
      ]) {
        final result = status.resultFor(check)!;
        expect(result.status, ProbeStatus.noCredentials);
        expect(result.detail, isNot(contains(secret)));
      }
      expect(
        status.checks.map((check) => check.detail).join('|'),
        isNot(contains(_apiKey)),
      );
    });

    test('reads the API key once and uses it for every authenticated leg',
        () async {
      final (dio, adapter) = makeDio();
      final authorizationHeaders = <String?>[];
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            if (!options.path.contains('/health')) {
              authorizationHeaders.add(
                options.headers['Authorization'] as String?,
              );
            }
            handler.next(options);
          },
        ),
      );
      adapter.onGet(_authUrl, (r) => r.reply(200, {'status': 'ok'}));
      adapter.onPost(_inferenceUrl, (r) => r.reply(200, {'id': 'chat-1'}));
      adapter.onGet(_modelsUrl, (r) {
        return r.reply(200, {
          'data': [
            {'id': 'model.vl', 'vision_capable': true},
          ],
        });
      });
      adapter.onGet(_healthUrl, (r) {
        return r.reply(200, {'status': 'ok'});
      });
      const firstKey = 'sk_first_probe_key';
      var reads = 0;

      final status = await probe(
        dio,
        apiKeyReader: () async {
          reads++;
          if (reads > 1) throw StateError('rotated-key-secret');
          return firstKey;
        },
      ).probe(_settings);

      expect(reads, 1);
      expect(authorizationHeaders, hasLength(3));
      expect(authorizationHeaders, everyElement('Bearer $firstKey'));
      for (final check in [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
      ]) {
        expect(status.resultFor(check)!.status, ProbeStatus.ok);
      }
      expect(status.resultFor(BackendCheck.health)!.status, ProbeStatus.ok);
    });
  });

  group('aggregation', () {
    test('a missing stored API key yields noCredentials on the authenticated '
        'checks while health still runs unauthenticated', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_healthUrl, (r) {
        return r.reply(200, {
          'status': 'ok',
          'checks': {'authDb': 'ok', 'ledgerDb': 'ok'},
        });
      });

      final status =
          await DioBackendProbe(dio: dio, apiKeyReader: _noKey)
              .probe(_settings);

      for (final check in [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
      ]) {
        expect(status.resultFor(check)!.status, ProbeStatus.noCredentials,
            reason: '$check should be noCredentials');
      }
      final health = status.resultFor(BackendCheck.health)!;
      expect(health.status, ProbeStatus.ok);
      expect(status.overall, ProbeStatus.noCredentials);
    });

    test('probe returns checks in the documented order', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);

      final status = await probe(dio).probe(_settings);

      expect(status.checks.map((c) => c.check), [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
        BackendCheck.health,
      ]);
      for (final check in BackendCheck.values) {
        expect(status.resultFor(check)!.status, ProbeStatus.ok,
            reason: '$check should be ok');
      }
      expect(status.overall, ProbeStatus.ok);
    });

    test('allOk is true only when every check is ok', () async {
      const ok = CheckResult(
        check: BackendCheck.auth,
        status: ProbeStatus.ok,
        detail: 'ok',
      );

      const allOk = BackendStatus(checks: [
        ok,
        CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
      ]);
      expect(allOk.allOk, isTrue);

      const withUnauthorized = BackendStatus(checks: [
        ok,
        CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.unauthorized,
          detail: 'API key rejected (401)',
        ),
      ]);
      expect(withUnauthorized.allOk, isFalse);

      const withNoCredentials = BackendStatus(checks: [
        ok,
        CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.noCredentials,
          detail: 'no API key stored',
        ),
      ]);
      expect(withNoCredentials.allOk, isFalse);
    });

    test('allOk is false when there are no checks', () {
      expect(const BackendStatus(checks: []).allOk, isFalse);
    });

    test('overall is null when no checks ran', () {
      expect(const BackendStatus(checks: []).overall, isNull);
    });

    test('overall surfaces gatewayDegraded when only health is degraded', () {
      const status = BackendStatus(checks: [
        CheckResult(
          check: BackendCheck.auth,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
        CheckResult(
          check: BackendCheck.health,
          status: ProbeStatus.gatewayDegraded,
          detail: 'gateway degraded (HTTP 503)',
        ),
      ]);
      expect(status.overall, ProbeStatus.gatewayDegraded);
      expect(status.allOk, isFalse);
    });

    test('overall precedence follows unauthorized > emailNotVerified > '
        'gatewayDegraded > unreachable > error > noCredentials > ok', () {
      CheckResult r(BackendCheck check, ProbeStatus status) =>
          CheckResult(check: check, status: status, detail: 'd');

      // Credential-action statuses outrank a degraded gateway.
      expect(
        BackendStatus(checks: [
          r(BackendCheck.auth, ProbeStatus.unauthorized),
          r(BackendCheck.health, ProbeStatus.gatewayDegraded),
        ]).overall,
        ProbeStatus.unauthorized,
      );
      expect(
        BackendStatus(checks: [
          r(BackendCheck.auth, ProbeStatus.emailNotVerified),
          r(BackendCheck.health, ProbeStatus.gatewayDegraded),
        ]).overall,
        ProbeStatus.emailNotVerified,
      );
      // Degraded outranks absence/failure signals below it.
      expect(
        BackendStatus(checks: [
          r(BackendCheck.health, ProbeStatus.gatewayDegraded),
          r(BackendCheck.inference, ProbeStatus.unreachable),
          r(BackendCheck.vision, ProbeStatus.error),
          r(BackendCheck.auth, ProbeStatus.noCredentials),
        ]).overall,
        ProbeStatus.gatewayDegraded,
      );
      expect(
        BackendStatus(checks: [
          r(BackendCheck.auth, ProbeStatus.unreachable),
          r(BackendCheck.inference, ProbeStatus.error),
        ]).overall,
        ProbeStatus.unreachable,
      );
      expect(
        BackendStatus(checks: [
          r(BackendCheck.auth, ProbeStatus.noCredentials),
          r(BackendCheck.health, ProbeStatus.ok),
        ]).overall,
        ProbeStatus.noCredentials,
      );
      expect(
        BackendStatus(checks: [
          r(BackendCheck.auth, ProbeStatus.ok),
          r(BackendCheck.health, ProbeStatus.ok),
        ]).overall,
        ProbeStatus.ok,
      );
    });

    test('resultFor returns null for a check that was not run', () {
      const status = BackendStatus(checks: [
        CheckResult(
          check: BackendCheck.auth,
          status: ProbeStatus.ok,
          detail: 'ok',
        ),
      ]);

      expect(status.resultFor(BackendCheck.inference), isNull);
      expect(status.resultFor(BackendCheck.auth), isNotNull);
    });

    test('probe completes and returns an aggregated BackendStatus', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);

      final status =
          await probe(dio).probe(_settings).timeout(const Duration(seconds: 5));

      expect(status, isA<BackendStatus>());
      expect(status.checks, hasLength(4));
    });
  });

  group('request hardening', () {
    test('auth check sends the bearer API key and never follows redirects',
        () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final authRequest = adapter.requests
          .firstWhere((r) => r.path.contains('/v1/auth/check'));
      expect(authRequest.method, 'GET');
      expect(authRequest.headers['Authorization'], 'Bearer $_apiKey');
      expect(authRequest.followRedirects, isFalse);
    });

    test('inference check sends the stored API key and never follows redirects',
        () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final inferenceRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/v1/chat/completions'));
      expect(inferenceRequest.method, 'POST');
      expect(inferenceRequest.headers['Authorization'], 'Bearer $_apiKey');
      expect(inferenceRequest.followRedirects, isFalse);
    });

    test('vision check sends the stored API key on the models probe', () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final modelsRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/v1/models'));
      expect(modelsRequest.method, 'GET');
      expect(modelsRequest.headers['Authorization'], 'Bearer $_apiKey');
    });

    test('inference check pings with the probe model name', () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final inferenceRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/v1/chat/completions'));
      final body = inferenceRequest.data as Map;
      expect(body['model'], '_probe');
    });
  });

  group('invalid host', () {
    test('probe with a URL-like host reports failures instead of throwing',
        () async {
      final (dio, adapter) = makeDio();

      // No routes registered: every request errors without throwing.
      final status = await probe(dio).probe(
        const BackendSettings(host: 'https://evil.example'),
      );

      expect(status.checks, hasLength(4));
      for (final check in status.checks) {
        expect(check.status, isNot(ProbeStatus.ok));
      }
      expect(status.overall, isNot(ProbeStatus.gatewayDegraded));
    });
  });
}