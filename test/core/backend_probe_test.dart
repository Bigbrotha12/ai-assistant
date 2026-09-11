import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';

const _host = 'myhost';
const _apiKey = 'sk_test123';
const _authUrl = 'http://myhost:17600/v1/auth/check';

/// The external inference API (e.g. LibreChat agents endpoint) the probe now
/// targets instead of the gateway LLM proxy.
const _llmBase = 'https://librechat.example/api/agents/v1';
const _llmModel = 'agent_1';
const _inferenceUrl = '$_llmBase/chat/completions';

/// The vision models probe appends `/v1/models` to the version root (the LLM
/// base with its own `/v1` suffix stripped).
const _modelsUrl = 'https://librechat.example/api/agents/v1/models';

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
      inferenceBaseUrl: _llmBase,
      inferenceModel: _llmModel,
      inferenceApiKey: _apiKey,
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
        {'id': 'model.vl', 'capabilities': {'vision': true}},
      ],
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

    test('returns error (not unauthorized) on a 401 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        _inferenceUrl,
        (r) => r.throws(401, httpError(_inferenceUrl, 401)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.inference)!;
      // The 401 rejects the build-time LLM API key, which the gateway re-auth
      // flow cannot fix — it must surface as an error, not unauthorized.
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('LLM_API_KEY'));
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

    test('reports error (never falls back) when not configured', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_authUrl, (r) => r.reply(200, {'status': 'ok'}));

      // Compile-time LLM_* defines default to '' in a test build, so a probe
      // without explicit inference params is "unconfigured".
      final status =
          await DioBackendProbe(dio: dio, apiKeyReader: _key).probe(_settings);

      final inference = status.resultFor(BackendCheck.inference)!;
      expect(inference.status, ProbeStatus.error);
      expect(inference.detail, contains('LLM_BASE_URL'));
      final vision = status.resultFor(BackendCheck.vision)!;
      expect(vision.status, ProbeStatus.error);
      expect(vision.detail, contains('LLM_BASE_URL'));
    });
  });

  group('vision', () {
    test('returns ok when model.vl is available', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(_modelsUrl, (r) {
        return r.reply(200, {
          'data': [
            {'id': 'model.vl', 'capabilities': {'vision': true}},
          ],
        });
      });

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.ok);
      expect(result.detail, 'model.vl available');
    });

    test('returns unreachable when model.vl is missing', () async {
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
      expect(result.detail, 'model.vl not found');
    });

    test('returns error (not unauthorized) on a 401 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        _modelsUrl,
        (r) => r.throws(401, httpError(_modelsUrl, 401)),
      );

      final status = await probe(dio).probe(_settings);

      final result = status.resultFor(BackendCheck.vision)!;
      expect(result.status, ProbeStatus.error);
      expect(result.detail, contains('LLM_API_KEY'));
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

  group('aggregation', () {
    test(
        'a missing stored API key yields noCredentials on auth only; '
        'inference/vision use the configured LLM key', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);

      final status = await probe(dio, apiKeyReader: _noKey).probe(_settings);

      expect(
        status.resultFor(BackendCheck.auth)!.status,
        ProbeStatus.noCredentials,
      );
      expect(status.resultFor(BackendCheck.auth)!.detail, contains('no API key'));
      expect(status.resultFor(BackendCheck.inference)!.status, ProbeStatus.ok);
      expect(status.resultFor(BackendCheck.vision)!.status, ProbeStatus.ok);
    });

    test('probe returns checks in the documented order', () async {
      final (dio, adapter) = makeDio();
      registerAllOk(adapter);

      final status = await probe(dio).probe(_settings);

      expect(status.checks.map((c) => c.check), [
        BackendCheck.auth,
        BackendCheck.inference,
        BackendCheck.vision,
      ]);
      for (final check in BackendCheck.values) {
        expect(status.resultFor(check)!.status, ProbeStatus.ok,
            reason: '$check should be ok');
      }
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
      expect(status.checks, hasLength(3));
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

    test('inference check sends the LLM key and never follows redirects',
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

    test('vision check sends the LLM key on the models probe', () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final modelsRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/v1/models'));
      expect(modelsRequest.method, 'GET');
      expect(modelsRequest.headers['Authorization'], 'Bearer $_apiKey');
    });

    test('inference check pings with the configured model', () async {
      final adapter = CapturingAdapter();
      final dio = Dio()..httpClientAdapter = adapter;

      await probe(dio).probe(_settings);

      final inferenceRequest =
          adapter.requests.firstWhere((r) => r.path.contains('/v1/chat/completions'));
      final body = inferenceRequest.data as Map;
      expect(body['model'], _llmModel);
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

      expect(status.checks, hasLength(3));
      for (final check in status.checks) {
        expect(check.status, isNot(ProbeStatus.ok));
      }
    });
  });
}