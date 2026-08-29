import 'package:dio/dio.dart';

import 'backend_settings.dart';
import 'config.dart';
import 'network_errors.dart';

/// Individual backend endpoint probed by [BackendProbe.probe].
enum BackendCheck { auth, inference, vision }

/// Human-readable label for a [BackendCheck], used by the settings screen.
extension BackendCheckLabel on BackendCheck {
  String get label => switch (this) {
        BackendCheck.auth => 'Auth',
        BackendCheck.inference => 'Inference',
        BackendCheck.vision => 'Vision (VL)',
      };
}

/// Verdict for a single check.
enum ProbeStatus {
  ok,
  error,

  /// The stored API key was rejected by the backend (HTTP 401). Downstream UI
  /// routes this to a re-authentication flow.
  unauthorized,

  /// No API key is stored, so the authenticated checks cannot run.
  noCredentials,
  unreachable,
}

/// Outcome of probing one backend endpoint.
class CheckResult {
  const CheckResult({
    required this.check,
    required this.status,
    required this.detail,
  });

  final BackendCheck check;
  final ProbeStatus status;
  final String detail;
}

/// Aggregated probe result over the full backend chain.
class BackendStatus {
  const BackendStatus({required this.checks});

  final List<CheckResult> checks;

  /// Result for [check], or null when the probe didn't run it.
  CheckResult? resultFor(BackendCheck check) {
    for (final result in checks) {
      if (result.check == check) return result;
    }
    return null;
  }

  /// True when at least one check ran and every check succeeded.
  bool get allOk =>
      checks.isNotEmpty && checks.every((c) => c.status == ProbeStatus.ok);
}

/// Reads the stored API key used to authenticate probe requests (injectable
/// for tests). Null/blank means no credentials are available.
typedef ApiKeyReader = Future<String?> Function();

/// Probes reachability and readiness of the backend gateway.
abstract interface class BackendProbe {
  /// Probes the gateway chain concurrently; results ordered
  /// [BackendCheck.auth, inference, vision].
  Future<BackendStatus> probe(BackendSettings settings);
}

/// [BackendProbe] over the authenticated gateway (auth, inference, vision).
///
/// All three checks authenticate with the API key from the injected
/// [ApiKeyReader]. HTTP 401 surfaces as [ProbeStatus.unauthorized] (so the UI
/// can route to re-auth); a missing key surfaces as
/// [ProbeStatus.noCredentials].
class DioBackendProbe implements BackendProbe {
  DioBackendProbe({
    Dio? dio,
    ApiKeyReader? apiKeyReader,
    this.model = 'Qwen3-8B-Q4_K_M.gguf',
    Duration authTimeout = const Duration(seconds: 8),
    Duration inferenceTimeout = const Duration(seconds: 25),
    Duration visionTimeout = const Duration(seconds: 5),
  })  : _dio = dio ??
            Dio(
              BaseOptions(
                connectTimeout: const Duration(seconds: 8),
                receiveTimeout: const Duration(seconds: 8),
              ),
            ),
        _apiKeyReader = apiKeyReader ?? (() async => null),
        _timeouts = (
          auth: authTimeout,
          inference: inferenceTimeout,
          vision: visionTimeout,
        );

  final Dio _dio;
  final ApiKeyReader _apiKeyReader;

  /// Model identifier used by the inference probe ping, mirroring the default
  /// the real chat client sends.
  final String model;
  final ({Duration auth, Duration inference, Duration vision}) _timeouts;

  @override
  Future<BackendStatus> probe(BackendSettings settings) async {
    final results = await Future.wait([
      _probeAuth(settings),
      _probeInference(settings),
      _probeVision(settings),
    ]);
    return BackendStatus(checks: results);
  }

  /// The stored API key, or null when absent/blank.
  Future<String?> _readApiKey() async {
    final key = await _apiKeyReader();
    return (key == null || key.isEmpty) ? null : key;
  }

  Future<CheckResult> _probeAuth(BackendSettings settings) async {
    final apiKey = await _readApiKey();
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.auth,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    return _guard(
      BackendCheck.auth,
      () async {
        final url = BackendConfig.llmProxy(
          host,
          environment: settings.environment,
        ).replace(path: '/v1/auth/check');
        final resp = await _dio
            .getUri(
              url,
              options: Options(
                headers: {'Authorization': 'Bearer $apiKey'},
                // The API key must never be replayed to a redirect target on
                // another origin.
                followRedirects: false,
              ),
            )
            .timeout(_timeouts.auth);
        if (resp.statusCode == 200) {
          return const CheckResult(
            check: BackendCheck.auth,
            status: ProbeStatus.ok,
            detail: 'API key valid',
          );
        }
        return CheckResult(
          check: BackendCheck.auth,
          status: ProbeStatus.error,
          detail: 'HTTP ${resp.statusCode}',
        );
      },
      httpError: (e) => _authHttpError(BackendCheck.auth, e),
    );
  }

  Future<CheckResult> _probeInference(BackendSettings settings) async {
    final apiKey = await _readApiKey();
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.inference,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    return _guard(
      BackendCheck.inference,
      () async {
        final resp = await _dio
            .postUri(
              BackendConfig.llmCompletions(
                host,
                environment: settings.environment,
              ),
              data: {
                'model': model,
                'messages': [
                  {'role': 'user', 'content': 'ping'},
                ],
                'max_tokens': 1,
                'stream': false,
              },
              options: Options(
                headers: {'Authorization': 'Bearer $apiKey'},
                followRedirects: false,
              ),
            )
            .timeout(_timeouts.inference);
        if (resp.statusCode == 200) {
          return const CheckResult(
            check: BackendCheck.inference,
            status: ProbeStatus.ok,
            detail: 'inference ready',
          );
        }
        return CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.error,
          detail: 'HTTP ${resp.statusCode}',
        );
      },
      httpError: (e) => _inferenceHttpError(BackendCheck.inference, e),
    );
  }

  Future<CheckResult> _probeVision(BackendSettings settings) async {
    final apiKey = await _readApiKey();
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.vision,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    return _guard(
      BackendCheck.vision,
      () async {
        final modelsUrl = BackendConfig.llmProxy(
          host,
          environment: settings.environment,
        ).replace(path: '/v1/models');
        final response = await _dio
            .getUri(
              modelsUrl,
              options: Options(
                headers: {'Authorization': 'Bearer $apiKey'},
                connectTimeout: _timeouts.vision,
                receiveTimeout: _timeouts.vision,
                followRedirects: false,
              ),
            )
            .timeout(_timeouts.vision);
        if (response.statusCode != 200) {
          return CheckResult(
            check: BackendCheck.vision,
            status: ProbeStatus.error,
            detail: 'HTTP ${response.statusCode}',
          );
        }
        final data = response.data as Map<String, dynamic>?;
        final models = data?['data'] as List?;
        if (models == null) {
          return const CheckResult(
            check: BackendCheck.vision,
            status: ProbeStatus.unreachable,
            detail: 'no data in models response',
          );
        }
        for (final model in models) {
          if (model is Map<String, dynamic>) {
            final id = model['id'] as String?;
            if (id == 'model.vl') {
              return const CheckResult(
                check: BackendCheck.vision,
                status: ProbeStatus.ok,
                detail: 'model.vl available',
              );
            }
          }
        }
        return const CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.unreachable,
          detail: 'model.vl not found',
        );
      },
      httpError: (e) => _visionHttpError(BackendCheck.vision, e),
    );
  }

  /// Runs [run], translating non-2xx responses into error results and every
  /// other failure through [_classify]. [httpError] fully customizes the
  /// result of an HTTP error response (e.g. mapping 401 to unauthorized).
  Future<CheckResult> _guard(
    BackendCheck check,
    Future<CheckResult> Function() run, {
    CheckResult Function(DioException error)? httpError,
  }) async {
    try {
      return await run();
    } on DioException catch (e) {
      if (e.type == DioExceptionType.badResponse) {
        final result = httpError?.call(e) ??
            CheckResult(
              check: check,
              status: ProbeStatus.error,
              detail:
                  truncateText('HTTP ${e.response?.statusCode}: ${e.response?.data}'),
            );
        return result;
      }
      final (status, detail) = _classify(e);
      return CheckResult(check: check, status: status, detail: detail);
    } catch (e) {
      final (status, detail) = _classify(e);
      return CheckResult(check: check, status: status, detail: detail);
    }
  }

  static CheckResult _authHttpError(BackendCheck check, DioException e) {
    final code = e.response?.statusCode;
    if (code == 401) {
      return CheckResult(
        check: check,
        status: ProbeStatus.unauthorized,
        detail: 'API key rejected (401)',
      );
    }
    return CheckResult(
      check: check,
      status: ProbeStatus.error,
      detail: 'HTTP $code',
    );
  }

  static CheckResult _inferenceHttpError(BackendCheck check, DioException e) {
    final code = e.response?.statusCode;
    if (code == 401) {
      return CheckResult(
        check: check,
        status: ProbeStatus.unauthorized,
        detail: 'API key rejected (401)',
      );
    }
    return switch (code) {
      503 => CheckResult(
          check: check,
          status: ProbeStatus.error,
          detail: 'RabbitMQ not reachable (503)',
        ),
      502 || 504 => CheckResult(
          check: check,
          status: ProbeStatus.error,
          detail: 'backend not ready ($code)',
        ),
      400 || 422 => CheckResult(
          check: check,
          status: ProbeStatus.error,
          detail: 'proxy returned $code (unexpected request shape)',
        ),
      _ => CheckResult(
          check: check,
          status: ProbeStatus.error,
          detail: 'HTTP $code',
        ),
    };
  }

  static CheckResult _visionHttpError(BackendCheck check, DioException e) {
    final code = e.response?.statusCode;
    if (code == 401) {
      return CheckResult(
        check: check,
        status: ProbeStatus.unauthorized,
        detail: 'API key rejected (401)',
      );
    }
    return CheckResult(
      check: check,
      status: ProbeStatus.error,
      detail: 'HTTP $code',
    );
  }

  /// Classifies a non-HTTP failure into (status, detail). Network-family
  /// failures map to unreachable; anything else is an error carrying its own
  /// detail.
  (ProbeStatus, String) _classify(Object error) {
    if (isNetworkError(error)) {
      return (ProbeStatus.unreachable, 'unreachable');
    }
    return (ProbeStatus.error, describeDioError(error));
  }
}