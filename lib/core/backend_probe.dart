import 'package:dio/dio.dart';

import 'backend_settings.dart';
import 'config.dart';
import 'network_errors.dart';

/// Individual backend endpoint probed by [BackendProbe.probe].
enum BackendCheck { auth, inference, vision, health }

/// Human-readable label for a [BackendCheck], used by the settings screen.
extension BackendCheckLabel on BackendCheck {
  String get label => switch (this) {
    BackendCheck.auth => 'Auth',
    BackendCheck.inference => 'Inference',
    BackendCheck.vision => 'Vision (VL)',
    BackendCheck.health => 'Health',
  };
}

/// Verdict for a single check.
enum ProbeStatus {
  ok,
  error,

  /// The stored gateway API key was rejected (HTTP 401).
  /// Downstream UI routes this to a re-authentication flow.
  unauthorized,

  /// The stored gateway API key is valid, but the owning account's email is
  /// unverified (HTTP 403 `email_not_verified`). Distinct from [unauthorized]:
  /// downstream UI must offer "verify your email" (resend), never re-auth.
  emailNotVerified,

  /// The server explicitly reported that the account owner is deleted
  /// (HTTP 403 `account_deleted`). This is terminal, not a credential action.
  accountDeleted,

  /// No API key is stored, so the authenticated checks cannot run.
  noCredentials,
  unreachable,

  /// The gateway's unauthenticated `GET /health` answered with a degraded
  /// body (`status: "degraded"`, typically HTTP 503): the gateway process is
  /// up but a dependency (auth/ledger DB) is failing. Distinct from [error]
  /// and [unreachable] — the gateway itself is responding and self-reporting
  /// the problem (M5 watchdog, client half).
  gatewayDegraded,
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

  bool get hasAuthenticatedAccountDeletedSignal => checks.any(
    (check) =>
        check.status == ProbeStatus.accountDeleted &&
        check.check != BackendCheck.health,
  );

  /// Aggregate verdict over [checks] (M5 gateway-degraded mapping).
  ///
  /// Precedence — first matching status present in [checks] wins:
  /// 1. [ProbeStatus.unauthorized] — the stored key was rejected; the
  ///    re-auth flow is required regardless of gateway health.
  /// 2. [ProbeStatus.emailNotVerified] — the account must verify its email
  ///    (never re-auth), also independent of gateway health.
  /// 3. [ProbeStatus.accountDeleted] — the server explicitly says the account
  ///    is gone. It outranks generic health/transport failures, but follows
  ///    the credential-actionable statuses above so an actionable auth result is
  ///    never hidden by a concurrent probe failure.
  /// 4. [ProbeStatus.gatewayDegraded] — `/health` self-reports degraded; it
  ///    surfaces as the overall verdict even when auth/inference/vision all
  ///    pass (the affirmative "server is up but broken" signal outranks the
  ///    absence-of-signal failures below).
  /// 5. [ProbeStatus.unreachable] — an endpoint (including `/health`
  ///    itself) could not be reached at all.
  /// 6. [ProbeStatus.error] — an endpoint responded but failed.
  /// 7. [ProbeStatus.noCredentials] — no API key stored (health still runs
  ///    unauthenticated and may pass).
  /// 8. [ProbeStatus.ok] — every check that ran succeeded.
  ///
  /// Null when [checks] is empty (nothing ran).
  ProbeStatus? get overall {
    if (checks.isEmpty) return null;
    const precedence = [
      ProbeStatus.unauthorized,
      ProbeStatus.emailNotVerified,
      ProbeStatus.accountDeleted,
      ProbeStatus.gatewayDegraded,
      ProbeStatus.unreachable,
      ProbeStatus.error,
      ProbeStatus.noCredentials,
      ProbeStatus.ok,
    ];
    for (final status in precedence) {
      if (status == ProbeStatus.accountDeleted &&
          !hasAuthenticatedAccountDeletedSignal) {
        continue;
      }
      if (checks.any((c) => c.status == status)) return status;
    }
    return ProbeStatus.error;
  }
}

/// Reads the stored API key used to authenticate probe requests (injectable
/// for tests). Null/blank means no credentials are available.
typedef ApiKeyReader = Future<String?> Function();

/// Probes reachability and readiness of the backend gateway.
abstract interface class BackendProbe {
  /// Probes the gateway chain concurrently; results ordered
  /// [BackendCheck.auth, inference, vision, health].
  Future<BackendStatus> probe(BackendSettings settings);
}

/// Probes the gateway's auth, inference, vision, and health endpoints.
class DioBackendProbe implements BackendProbe {
  DioBackendProbe({
    Dio? dio,
    ApiKeyReader? apiKeyReader,
    Duration authTimeout = const Duration(seconds: 8),
    Duration inferenceTimeout = const Duration(seconds: 25),
    Duration visionTimeout = const Duration(seconds: 5),
    Duration healthTimeout = const Duration(seconds: 5),
  }) : _dio =
           dio ??
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
         health: healthTimeout,
       );

  final Dio _dio;
  final ApiKeyReader _apiKeyReader;
  final ({Duration auth, Duration inference, Duration vision, Duration health})
  _timeouts;

  @override
  Future<BackendStatus> probe(BackendSettings settings) async {
    try {
      final apiKey = await _readApiKey();
      final results = await Future.wait([
        _probeAuth(settings, apiKey),
        _probeInference(settings, apiKey),
        _probeVision(settings, apiKey),
        _probeHealth(settings),
      ]);
      return BackendStatus(checks: results);
    } catch (_) {
      return const BackendStatus(
        checks: [
          CheckResult(
            check: BackendCheck.auth,
            status: ProbeStatus.error,
            detail: 'probe failed',
          ),
          CheckResult(
            check: BackendCheck.inference,
            status: ProbeStatus.error,
            detail: 'probe failed',
          ),
          CheckResult(
            check: BackendCheck.vision,
            status: ProbeStatus.error,
            detail: 'probe failed',
          ),
          CheckResult(
            check: BackendCheck.health,
            status: ProbeStatus.error,
            detail: 'probe failed',
          ),
        ],
      );
    }
  }

  /// The stored API key, or null when absent/blank.
  Future<String?> _readApiKey() async {
    try {
      final key = await _apiKeyReader();
      return (key == null || key.isEmpty) ? null : key;
    } catch (_) {
      return null;
    }
  }

  Future<CheckResult> _probeAuth(
    BackendSettings settings,
    String? apiKey,
  ) async {
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.auth,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    return _guard(BackendCheck.auth, () async {
      final url = BackendConfig.gatewayBase(
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
    }, httpError: (e) => _authHttpError(BackendCheck.auth, e));
  }

  Future<CheckResult> _probeInference(
    BackendSettings settings,
    String? apiKey,
  ) async {
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.inference,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    final url = BackendConfig.gatewayBase(
      host,
      environment: settings.environment,
    ).replace(path: '/v1/chat/completions');

    return _guard(BackendCheck.inference, () async {
      final resp = await _dio
          .postUri(
            url,
            data: {
              'model': '_probe',
              'messages': [
                {'role': 'user', 'content': 'ping'},
              ],
              'max_tokens': 1,
              'stream': false,
            },
            options: Options(
              headers: {'Authorization': 'Bearer $apiKey'},
              followRedirects: false,
              validateStatus: (status) => true,
            ),
          )
          .timeout(_timeouts.inference);
      // 401: the stored gateway API key was rejected. validateStatus above
      // accepts every status, so this arrives as a normal response rather
      // than a badResponse DioException.
      if (resp.statusCode == 401) {
        return const CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.unauthorized,
          detail: 'gateway API key rejected (401)',
        );
      }
      if (resp.statusCode == 403 && _isAccountDeletedBody(resp.data)) {
        return const CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.accountDeleted,
          detail: 'account deleted (403)',
        );
      }
      // 403 `email_not_verified`: the key is valid but the account's email
      // is unconfirmed (C2) — surface verification, not re-auth.
      if (resp.statusCode == 403 && _isEmailNotVerifiedBody(resp.data)) {
        return const CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.emailNotVerified,
          detail: 'verify your email (403)',
        );
      }
      // 2xx, 400, or 422: gateway endpoint is reachable and auth works;
      // the test model '_probe' won't resolve but the response confirms the
      // gateway is alive and the API key is valid.
      if (resp.statusCode == 200 ||
          resp.statusCode == 400 ||
          resp.statusCode == 422) {
        return const CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.ok,
          detail: 'gateway inference reachable',
        );
      }
      return CheckResult(
        check: BackendCheck.inference,
        status: ProbeStatus.error,
        detail: 'HTTP ${resp.statusCode}',
      );
    }, httpError: (e) => _inferenceHttpError(BackendCheck.inference, e));
  }

  Future<CheckResult> _probeVision(
    BackendSettings settings,
    String? apiKey,
  ) async {
    if (apiKey == null) {
      return const CheckResult(
        check: BackendCheck.vision,
        status: ProbeStatus.noCredentials,
        detail: 'no API key stored',
      );
    }
    final host = settings.trimmedHost;
    final modelsUrl = BackendConfig.gatewayBase(
      host,
      environment: settings.environment,
    ).replace(path: '/v1/models');

    return _guard(BackendCheck.vision, () async {
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
      if (response.statusCode == 403 && _isAccountDeletedBody(response.data)) {
        return const CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.accountDeleted,
          detail: 'account deleted (403)',
        );
      }
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
          if (model['vision_capable'] == true || model['id'] == 'model.vl') {
            return const CheckResult(
              check: BackendCheck.vision,
              status: ProbeStatus.ok,
              detail: 'vision-capable model available',
            );
          }
        }
      }
      return const CheckResult(
        check: BackendCheck.vision,
        status: ProbeStatus.unreachable,
        detail: 'no vision-capable model',
      );
    }, httpError: (e) => _visionHttpError(BackendCheck.vision, e));
  }

  /// M5 watchdog (client half): unauthenticated `GET {origin}/health`.
  ///
  /// Deliberately sends no Authorization header (the endpoint is public by
  /// contract so infrastructure probes can hit it) and never follows
  /// redirects. Interpretation is body-driven:
  /// - body `status: "degraded"` (any 2xx/5xx code, normally 503) →
  ///   [ProbeStatus.gatewayDegraded],
  /// - 200 + `status: "ok"` → [ProbeStatus.ok],
  /// - anything else → [ProbeStatus.error];
  /// network failures flow through [_guard]/[_classify] like every other
  /// check (→ [ProbeStatus.unreachable]).
  Future<CheckResult> _probeHealth(BackendSettings settings) async {
    final host = settings.trimmedHost;
    final url = BackendConfig.gatewayBase(
      host,
      environment: settings.environment,
    ).replace(path: '/health');

    return _guard(BackendCheck.health, () async {
      final resp = await _dio
          .getUri(
            url,
            options: Options(
              // Public endpoint: never attach the API key, and keep the
              // probe's no-redirect hardening consistent with the rest.
              followRedirects: false,
              // 503 is the degraded signal — accept every status so the
              // body arrives as a normal response, not a badResponse throw.
              validateStatus: (status) => true,
            ),
          )
          .timeout(_timeouts.health);
      final data = resp.data;
      if (_healthBodyStatus(data) == 'degraded') {
        return CheckResult(
          check: BackendCheck.health,
          status: ProbeStatus.gatewayDegraded,
          detail: _degradedDetail(data, resp.statusCode),
        );
      }
      if (resp.statusCode == 200 && _healthBodyStatus(data) == 'ok') {
        return const CheckResult(
          check: BackendCheck.health,
          status: ProbeStatus.ok,
          detail: 'gateway healthy',
        );
      }
      return CheckResult(
        check: BackendCheck.health,
        status: ProbeStatus.error,
        detail: 'HTTP ${resp.statusCode}',
      );
    }, httpError: _healthHttpError);
  }

  /// Runs [run], translating non-2xx responses into error results and every
  /// other failure through [_classify]. [httpError] fully customizes the
  /// result of an HTTP error response (e.g. the auth check mapping 401 to
  /// unauthorized).
  Future<CheckResult> _guard(
    BackendCheck check,
    Future<CheckResult> Function() run, {
    CheckResult Function(DioException error)? httpError,
  }) async {
    try {
      return await run();
    } on DioException catch (e) {
      if (e.type == DioExceptionType.badResponse) {
        final result =
            httpError?.call(e) ??
            CheckResult(
              check: check,
              status: ProbeStatus.error,
              detail: truncateText(
                'HTTP ${e.response?.statusCode}: ${e.response?.data}',
              ),
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
    if (code == 403 && _isAccountDeletedBody(e.response?.data)) {
      return const CheckResult(
        check: BackendCheck.auth,
        status: ProbeStatus.accountDeleted,
        detail: 'account deleted (403)',
      );
    }
    // C2: `GET /v1/auth/check` answers 403 {error: "email_not_verified"} for
    // a valid key whose owner is unverified — a distinct outcome from the
    // 401 re-auth path. A bare 403 without the signal stays a generic error.
    if (code == 403 && _isEmailNotVerifiedBody(e.response?.data)) {
      return CheckResult(
        check: check,
        status: ProbeStatus.emailNotVerified,
        detail: 'verify your email (403)',
      );
    }
    return CheckResult(
      check: check,
      status: ProbeStatus.error,
      detail: 'HTTP $code',
    );
  }

  static bool _isAccountDeletedBody(Object? data) {
    if (data is! Map) return false;
    if (data['error'] == 'account_deleted' ||
        data['code'] == 'account_deleted') {
      return true;
    }
    final error = data['error'];
    return error is Map &&
        (error['code'] == 'account_deleted' ||
            error['error'] == 'account_deleted');
  }

  /// True when an HTTP (error) body carries the gateway's distinct
  /// `email_not_verified` signal — the `{error: "email_not_verified"}` shape,
  /// a `code` twin, or a raw string body containing it.
  static bool _isEmailNotVerifiedBody(Object? data) {
    if (data is Map) {
      return data['error'] == 'email_not_verified' ||
          data['code'] == 'email_not_verified' ||
          data['code'] == 'EMAIL_NOT_VERIFIED';
    }
    if (data is String) return data.contains('email_not_verified');
    return false;
  }

  static CheckResult _inferenceHttpError(BackendCheck check, DioException e) {
    final code = e.response?.statusCode;
    if (code == 401) {
      return CheckResult(
        check: check,
        status: ProbeStatus.unauthorized,
        detail: 'gateway API key rejected (401)',
      );
    }
    if (code == 403 && _isAccountDeletedBody(e.response?.data)) {
      return const CheckResult(
        check: BackendCheck.inference,
        status: ProbeStatus.accountDeleted,
        detail: 'account deleted (403)',
      );
    }
    if (code == 403 && _isEmailNotVerifiedBody(e.response?.data)) {
      return CheckResult(
        check: check,
        status: ProbeStatus.emailNotVerified,
        detail: 'verify your email (403)',
      );
    }
    return switch (code) {
      503 => CheckResult(
        check: check,
        status: ProbeStatus.error,
        detail: 'inference backend loading (503)',
      ),
      502 || 504 => CheckResult(
        check: check,
        status: ProbeStatus.error,
        detail: 'inference backend not ready ($code)',
      ),
      400 || 422 => CheckResult(
        check: check,
        status: ProbeStatus.error,
        // The probe does NOT produce 400/422 via badResponse (Dio throws
        // for these only when validateStatus rejects them; the probe path
        // accepts any status). This branch is here for non-probe callers
        // that may re-use the same error formatting.
        detail: 'request rejected ($code)',
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
        detail: 'gateway API key rejected (401)',
      );
    }
    if (code == 403 && _isAccountDeletedBody(e.response?.data)) {
      return const CheckResult(
        check: BackendCheck.vision,
        status: ProbeStatus.accountDeleted,
        detail: 'account deleted (403)',
      );
    }
    if (code == 403 && _isEmailNotVerifiedBody(e.response?.data)) {
      return CheckResult(
        check: check,
        status: ProbeStatus.emailNotVerified,
        detail: 'verify your email (403)',
      );
    }
    return CheckResult(
      check: check,
      status: ProbeStatus.error,
      detail: 'HTTP $code',
    );
  }

  static CheckResult _healthHttpError(DioException e) {
    final code = e.response?.statusCode;
    return CheckResult(
      check: BackendCheck.health,
      status: ProbeStatus.error,
      detail: 'HTTP $code',
    );
  }

  /// The `status` field of a `/health` body (`"ok"` / `"degraded"`), or null
  /// when unreadable. A raw string body tolerates the load-bearing
  /// `degraded` token; a decoded Map is the normal (JSON) shape.
  static String? _healthBodyStatus(Object? data) {
    if (data is Map) {
      final status = data['status'];
      return status is String ? status : null;
    }
    if (data is String && data.contains('degraded')) return 'degraded';
    return null;
  }

  /// Detail line for a degraded health response, naming the failing
  /// dependency checks when the body carries them (e.g.
  /// `gateway degraded: ledgerDb (HTTP 503)`).
  static String _degradedDetail(Object? data, int? code) {
    final suffix = code == null ? '' : ' (HTTP $code)';
    if (data is Map && data['checks'] is Map) {
      final failing = (data['checks'] as Map).entries
          .where((e) => e.value != 'ok')
          .map((e) => e.key)
          .join(', ');
      if (failing.isNotEmpty) return 'gateway degraded: $failing$suffix';
    }
    return 'gateway degraded$suffix';
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
