import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import './vision_config.dart';
import '../../../core/network_errors.dart';

/// Contract for the vision describe call. Testable via a fake.
abstract interface class VisionClient {
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  });
}

sealed class VisionError implements Exception {
  const VisionError(this.message);
  final String message;
}

class VisionNetworkError extends VisionError {
  const VisionNetworkError(super.message);
}

class VisionServerError extends VisionError {
  const VisionServerError(super.message, {this.statusCode});
  final int? statusCode;
}

class VisionValidationError extends VisionError {
  const VisionValidationError(super.message);
}

class VisionUnavailableError extends VisionError {
  const VisionUnavailableError(super.message);
}

/// NoOp implementation: vision is not available. Throws [VisionUnavailableError].
class NoOpVisionClient implements VisionClient {
  const NoOpVisionClient();

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async {
    throw VisionUnavailableError('vision is unavailable');
  }
}

/// Dio-backed implementation against the queues proxy `model.vl` route.
class VisionApiClient implements VisionClient {
  VisionApiClient({
    required this.baseUrl,
    Dio? dio,
    this.apiKey,
  }) : _dio = dio ?? Dio();

  final String baseUrl;

  /// Gateway bearer API key sent as `Authorization: Bearer <apiKey>` on every
  /// request. Null when no key is available.
  final String? apiKey;

  final Dio _dio;

  static const Duration _connectTimeout = Duration(seconds: 8);
  static const Duration _receiveTimeout = Duration(seconds: 30);

  String get _endpoint => '$baseUrl/v1/chat/completions';

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async {
    final dataUri = 'data:$mimeType;base64,${base64.encode(bytes)}';
    final body = <String, dynamic>{
      'model': kVisionModelRoute,
      'messages': [
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': dataUri}},
          ],
        }
      ],
      'max_tokens': kMaxDescriptionTokens,
    };

    final headers = <String, Object?>{};
    final key = apiKey;
    if (key != null && key.isNotEmpty) {
      headers['Authorization'] = 'Bearer $key';
    }

    Response<Map<String, dynamic>> response;
    try {
      response = await _dio.post<Map<String, dynamic>>(
        _endpoint,
        data: body,
        options: Options(
          headers: headers,
          connectTimeout: _connectTimeout,
          receiveTimeout: _receiveTimeout,
        ),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      throw _mapError(e);
    }

    final status = response.statusCode;
    if (status == null || status < 200 || status >= 300) {
      throw VisionServerError('HTTP $status', statusCode: status);
    }

    final data = response.data;
    final choices = data?['choices'];
    if (choices is! List || choices.isEmpty) {
      throw VisionServerError('malformed completion response');
    }
    final choice = choices.first;
    final message = choice is Map<String, dynamic> ? choice['message'] : null;
    if (message is! Map<String, dynamic>) {
      throw VisionServerError('malformed completion response');
    }
    final content = (message['content'] as String?) ?? '';
    if (content.isEmpty) {
      throw VisionServerError('empty description');
    }
    return content;
  }

  Never _mapError(DioException e) {
    throw switch (e.type) {
      DioExceptionType.cancel => VisionUnavailableError('cancelled'),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.connectionError =>
          VisionNetworkError(describeDioError(e)),
      DioExceptionType.badResponse =>
          VisionServerError(describeDioError(e), statusCode: e.response?.statusCode),
      DioExceptionType.badCertificate ||
      DioExceptionType.unknown ||
      DioExceptionType.transformTimeout =>
          VisionNetworkError(describeDioError(e)),
    };
  }
}