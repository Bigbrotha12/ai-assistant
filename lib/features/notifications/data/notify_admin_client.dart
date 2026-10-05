import 'package:dio/dio.dart';

import '../../plugins/data/plugin_dto.dart';
import '../../plugins/data/plugin_http.dart';

/// Client for the ntfy provisioning surface (`server/src/notify/routes.ts`,
/// mounted at `/api/notify` on the gateway origin).
///
/// Auth is the stored gateway API key in the `Authorization: Bearer` header —
/// the same key every other `/api/*` client sends. Failures surface through
/// [PluginHttp] as [PluginClientException] (with `safePluginErrorCode`), so the
/// UI error mapper handles them like any other gateway failure.
///
/// Endpoints mirrored exactly:
///   POST /api/notify/provision — first call mints topic+token (returned ONCE);
///       a repeat call returns the topic with `accessToken: null`.
///   GET  /api/notify/provision — topic + null token; `404 not_configured`
///       until provisioned (a normal "not provisioned" state, not a fault).
///   POST /api/notify/rotate     — a new token for the SAME topic (404 until
///       provisioned).
///   POST /api/notify/revoke     — deletes the owner's stored credentials.
class NotifyAdminClient {
  NotifyAdminClient({
    required Dio dio,
    required String baseUrl,
    Duration timeout = const Duration(seconds: 20),
  })  : _http = PluginHttp(dio: dio, baseUrl: baseUrl, timeout: timeout),
        _baseUrl = baseUrl.replaceFirst(RegExp(r'/+$'), '');

  final PluginHttp _http;
  final String _baseUrl;

  static const provisionPath = '/api/notify/provision';
  static const rotatePath = '/api/notify/rotate';
  static const revokePath = '/api/notify/revoke';

  /// `GET /api/notify/provision`. Returns `null` — not an error — only when the
  /// server reports `404 {error:"not_configured"}`, i.e. this owner has never
  /// provisioned. Any other failure (including a different 404) propagates as a
  /// typed [PluginClientException].
  ///
  /// Sent through Dio directly rather than [PluginHttp.send]: the latter runs
  /// the error body through `safePluginErrorCode`, whose reachability allowlist
  /// deliberately excludes `not_configured`, so the code would degrade to
  /// `server_error` and the expected state could not be told apart from any
  /// other 404. Success and non-404 failures are classified exactly as `send`
  /// would.
  Future<NotifyProvision?> get({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    return _http.run(cancelToken, (token) async {
      if (gatewayKey.trim().isEmpty || gatewayKey.contains(RegExp(r'[\r\n]'))) {
        throw const PluginClientException('missing_gateway_key');
      }
      final response = await _http.dio.request<ResponseBody>(
        '$_baseUrl$provisionPath',
        cancelToken: token,
        options: Options(
          method: 'GET',
          headers: {
            'Authorization': 'Bearer $gatewayKey',
            'accept': 'application/json',
          },
          contentType: 'application/json',
          responseType: ResponseType.stream,
          followRedirects: false,
          maxRedirects: 0,
          connectTimeout: const Duration(seconds: 8),
          sendTimeout: _http.timeout,
          receiveTimeout: _http.timeout,
          validateStatus: (_) => true,
        ),
      );
      final status = response.statusCode ?? 0;
      Object? json;
      try {
        json = await _http.readJson(response.data);
      } on PluginProtocolException {
        json = null;
      }
      if (status >= 200 && status < 300) {
        return NotifyProvision.fromJson(json);
      }
      // Key on the RAW body's typed code: `safePluginErrorCode` drops
      // `not_configured`, so the allowlisted code alone cannot identify it.
      if (status == 404 &&
          json is Map &&
          json['error'] == 'not_configured') {
        return null;
      }
      throw PluginClientException(safePluginErrorCode(json), statusCode: status);
    });
  }

  /// `POST /api/notify/provision`. The FIRST call for an owner reveals the
  /// access token ([NotifyProvision.newlyProvisioned] true, non-null token);
  /// repeat calls return the topic with a null token.
  Future<NotifyProvision> provision({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _http.run(cancelToken, (token) async {
    // An explicit POST with no body: `PluginHttp.send` would otherwise infer
    // GET from a null body.
    final response = await _http.send(
      path: provisionPath,
      gatewayKey: gatewayKey,
      cancelToken: token,
      method: 'POST',
    );
    return NotifyProvision.fromJson(await _http.readJson(response.data));
  });

  /// `POST /api/notify/rotate`. Mints a NEW token for the SAME topic. Throws
  /// [NotifyNotConfiguredException] when the server reports 404 (never
  /// provisioned).
  Future<NotifyRotation> rotate({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    try {
      return await _http.run(cancelToken, (token) async {
        final response = await _http.send(
          path: rotatePath,
          gatewayKey: gatewayKey,
          cancelToken: token,
          method: 'POST',
        );
        return NotifyRotation.fromJson(await _http.readJson(response.data));
      });
    } on PluginClientException catch (error) {
      if (error.statusCode == 404) {
        throw const NotifyNotConfiguredException();
      }
      rethrow;
    }
  }

  /// `POST /api/notify/revoke`. Deletes the owner's stored credentials; the
  /// next provision starts a brand-new topic+token.
  Future<void> revoke({required String gatewayKey, CancelToken? cancelToken}) =>
      _http.run(cancelToken, (token) async {
        await _http.send(
          path: revokePath,
          gatewayKey: gatewayKey,
          cancelToken: token,
          method: 'POST',
        );
      });
}

/// The server has no notify credentials for this owner (`404 not_configured`
/// on rotate). A state, not a transport fault.
class NotifyNotConfiguredException implements Exception {
  const NotifyNotConfiguredException();

  @override
  String toString() => 'NotifyNotConfiguredException: not_configured';
}

/// `POST /api/notify/provision` response, and the `GET` shape (token always
/// null on read).
class NotifyProvision {
  const NotifyProvision({
    required this.topic,
    required this.accessToken,
    required this.newlyProvisioned,
  });

  factory NotifyProvision.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    final rawToken = json['accessToken'];
    return NotifyProvision(
      topic: pluginJsonString(json['topic']),
      // The token is revealed exactly once; null on every later call.
      accessToken: rawToken is String && rawToken.trim().isNotEmpty
          ? rawToken
          : null,
      newlyProvisioned: json['newlyProvisioned'] == true,
    );
  }

  final String topic;

  /// Non-null only on the FIRST provision.
  final String? accessToken;
  final bool newlyProvisioned;
}

/// `POST /api/notify/rotate` response: a fresh token for the same topic.
class NotifyRotation {
  const NotifyRotation({
    required this.topic,
    required this.accessToken,
    required this.rotated,
  });

  factory NotifyRotation.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    return NotifyRotation(
      topic: pluginJsonString(json['topic']),
      accessToken: pluginJsonString(json['accessToken']),
      rotated: json['rotated'] == true,
    );
  }

  final String topic;
  final String accessToken;
  final bool rotated;
}
