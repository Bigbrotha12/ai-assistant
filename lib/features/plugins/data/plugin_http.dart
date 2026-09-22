import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;

import 'package:dio/dio.dart';

import '../../../core/http/dio_errors.dart';
import 'plugin_dto.dart';

class PluginClientException implements Exception {
  const PluginClientException(this.code, {this.statusCode, this.retryAfter});

  final String code;
  final int? statusCode;
  final Duration? retryAfter;

  @override
  String toString() => 'PluginClientException: $code';
}

const _safeCodes = {
  'unauthorized',
  'rate_limited',
  'busy',
  'invalid_request',
  'invalid_request_error',
  'invalid_credentials',
  'credentials_expired',
  'inference_unavailable',
  'background_unavailable',
  'internal',
  'plugin_not_found',
  'plugin_unavailable',
  'invalid_config',
  'resume_conflict',
  'conversation_in_flight',
  'managed_unavailable',
  'message_thread_conflict',
  'reseed_required',
  'not_found',
  'task_conflict',
  'tool_retry_forbidden',
  'job_failed',
  'budget_exhausted',
  'context_length_exceeded',
  'model_error',
  'tool_error',
  'tool_execution_failed',
  'server_error',
  'auth_error',
  'session_missing',
  'request_too_large',
};

String safePluginErrorCode(Object? envelope) {
  final error = envelope is Map ? envelope['error'] : envelope;
  if (error is String && _safeCodes.contains(error)) return error;
  if (error is Map) {
    for (final key in ['code', 'type']) {
      final code = error[key];
      if (code is String && _safeCodes.contains(code)) return code;
    }
  }
  return 'server_error';
}

Duration? _retryAfter(String? value) {
  if (value == null) return null;
  final seconds = int.tryParse(value);
  if (seconds != null) return seconds < 0 ? null : Duration(seconds: seconds);
  try {
    final delay = HttpDate.parse(value).difference(DateTime.now().toUtc());
    return delay.isNegative ? Duration.zero : delay;
  } catch (_) {
    return null;
  }
}

class PluginHttp {
  PluginHttp({
    required this.dio,
    required String baseUrl,
    this.timeout = const Duration(seconds: 180),
  }) {
    final uri = Uri.tryParse(baseUrl);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        timeout <= Duration.zero) {
      throw const PluginClientException('invalid_configuration');
    }
    _baseUrl = baseUrl.replaceFirst(RegExp(r'/+$'), '');
  }

  final Dio dio;
  late final String _baseUrl;
  final Duration timeout;

  Future<T> run<T>(
    CancelToken? callerToken,
    Future<T> Function(CancelToken token) operation,
  ) async {
    final token = CancelToken();
    var active = true;
    if (callerToken?.isCancelled == true) {
      throw const PluginClientException('cancelled');
    }
    unawaited(
      callerToken?.whenCancel.then((_) {
        if (active) token.cancel();
      }),
    );
    var timedOut = false;
    final timer = Timer(timeout, () {
      timedOut = true;
      token.cancel();
    });
    try {
      return await operation(token);
    } on PluginClientException {
      rethrow;
    } on PluginProtocolException {
      throw const PluginClientException('invalid_response');
    } on DioException catch (e) {
      if (timedOut) throw const PluginClientException('timeout');
      switch (classifyDioException(e)) {
        case DioErrorCategory.cancelled:
          throw const PluginClientException('cancelled');
        case DioErrorCategory.timeoutNetwork:
          throw PluginClientException(
            e.type == DioExceptionType.connectionError
                ? 'network_error'
                : 'timeout',
          );
        case DioErrorCategory.badResponse:
          throw PluginClientException(
            'server_error',
            statusCode: e.response?.statusCode,
          );
        case DioErrorCategory.other:
          throw const PluginClientException('network_error');
      }
    } catch (_) {
      if (timedOut) throw const PluginClientException('timeout');
      if (token.isCancelled) throw const PluginClientException('cancelled');
      throw const PluginClientException('invalid_response');
    } finally {
      active = false;
      timer.cancel();
      token.cancel();
    }
  }

  Future<Response<ResponseBody>> send({
    required String path,
    required String gatewayKey,
    required CancelToken cancelToken,
    Map<String, dynamic>? body,
    String? method,
  }) async {
    if (gatewayKey.trim().isEmpty || gatewayKey.contains(RegExp(r'[\r\n]'))) {
      throw const PluginClientException('missing_gateway_key');
    }
    final response = await dio.request<ResponseBody>(
      '$_baseUrl$path',
      data: body,
      cancelToken: cancelToken,
      options: Options(
        method: method ?? (body == null ? 'GET' : 'POST'),
        headers: {
          'Authorization': 'Bearer $gatewayKey',
          'accept': body == null ? 'application/json' : 'text/event-stream',
        },
        contentType: 'application/json',
        responseType: ResponseType.stream,
        followRedirects: false,
        maxRedirects: 0,
        connectTimeout: const Duration(seconds: 8),
        sendTimeout: timeout,
        receiveTimeout: timeout,
        validateStatus: (_) => true,
      ),
    );
    final status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      Object? json;
      try {
        json = await readJson(response.data);
      } on PluginProtocolException {
        json = null;
      }
      throw PluginClientException(
        safePluginErrorCode(json),
        statusCode: status,
        retryAfter: _retryAfter(response.headers.value('retry-after')),
      );
    }
    return response;
  }

  Future<Object?> readJson(ResponseBody? body) async {
    if (body == null) throw const PluginProtocolException();
    final bytes = <int>[];
    await for (final chunk in body.stream) {
      bytes.addAll(chunk);
      if (bytes.length > 4 * 1024 * 1024) {
        throw const PluginProtocolException();
      }
    }
    return decodePluginJson(utf8.decode(bytes, allowMalformed: true));
  }
}
