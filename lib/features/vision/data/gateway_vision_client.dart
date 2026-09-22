import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'vision_client.dart';
import 'vision_config.dart';
import '../../../core/http/dio_errors.dart';

class GatewayVisionClient implements VisionClient {
  GatewayVisionClient({
    required String gatewayBase,
    required Dio dio,
    required this.gatewayKey,
    required this.modelPluginId,
    required this.credentials,
  }) : _endpoint = '${gatewayBase.endsWith('/') ? gatewayBase : '$gatewayBase/'}v1/chat/completions',
       // ignore: prefer_initializing_formals
       _dio = dio;

  final String _endpoint;
  final Dio _dio;
  final String gatewayKey;
  final String modelPluginId;
  final Map<String, Map<String, String>> credentials;

  static const Duration _connectTimeout = Duration(seconds: 8);
  static const Duration _receiveTimeout = Duration(seconds: 30);

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async {
    final dataUri = 'data:$mimeType;base64,${base64Encode(bytes)}';
    final body = <String, dynamic>{
      'model': modelPluginId,
      'messages': [
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': dataUri}},
          ],
        }
      ],
      'credentials': credentials,
      'max_tokens': kMaxDescriptionTokens,
    };

    Response<Map<String, dynamic>> response;
    try {
      response = await _dio.post<Map<String, dynamic>>(
        _endpoint,
        data: body,
        options: Options(
          headers: {'Authorization': 'Bearer $gatewayKey'},
          followRedirects: false,
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
    if (content.isEmpty && (message['tool_calls'] == null)) {
      throw VisionServerError('empty description');
    }
    return content;
  }

  Never _mapError(DioException e) {
    throw switch (classifyDioException(e)) {
      DioErrorCategory.cancelled => VisionUnavailableError('cancelled'),
      DioErrorCategory.timeoutNetwork => VisionNetworkError(describeDioException(e)),
      DioErrorCategory.badResponse => VisionServerError(describeDioException(e), statusCode: e.response?.statusCode),
      DioErrorCategory.other => VisionNetworkError(describeDioException(e)),
    };
  }
}