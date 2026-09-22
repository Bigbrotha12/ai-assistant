import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import 'chat_client.dart';
import 'message_model.dart';
import 'sse.dart';
import '../../../core/http/dio_errors.dart';
import '../../../core/network_errors.dart' show truncateText;

typedef CredentialResolver = Future<GatewayCredentials?> Function();

class GatewayCredentials {
  final String gatewayKey;
  final String modelPluginId;
  final Object? agent;
  final Map<String, Map<String, String>> credentials;

  const GatewayCredentials({
    required this.gatewayKey,
    required this.modelPluginId,
    this.agent,
    required this.credentials,
  });
}

class _ConnectionFailure implements Exception {
  _ConnectionFailure(this.message);

  final String message;
}

class GatewayChatClient implements ChatClient {
  GatewayChatClient({
    required this.baseUrl,
    required Dio dio,
    required this.credentialResolver,
    // ignore: prefer_initializing_formals
  }) : _dio = dio;

  final String baseUrl;
  final Dio _dio;
  final CredentialResolver credentialResolver;

  static const Duration _connectTimeout = Duration(seconds: 8);
  static const Duration _receiveTimeout = Duration(seconds: 180);
  static const Duration _retryBackoff = Duration(seconds: 1);

  String get _endpoint => '$baseUrl/chat/completions';

  @override
  Future<ChatResult> streamCompletions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) async {
    var ackFired = false;
    void onReceivedAck() {
      if (!ackFired) {
        ackFired = true;
        onReceived?.call();
      }
    }

    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        return await _streamOnce(
          messages: messages,
          systemPrompt: systemPrompt,
          onContent: onContent,
          onToolCallDelta: onToolCallDelta,
          cancelToken: cancelToken,
          onReceived: onReceivedAck,
        );
      } on _ConnectionFailure catch (e) {
        if (attempt == 1) {
          throw ChatNetworkError(e.message);
        }
        await Future<void>.delayed(_retryBackoff);
      }
    }
    throw StateError('unreachable');
  }

  @override
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) async {
    final creds = await credentialResolver();
    if (creds == null) {
      throw ChatNetworkError(
        'Plugin configuration is unavailable. Sign in again from Settings to continue.',
      );
    }

    final body = <String, Object?>{
      'model': creds.modelPluginId,
      if (creds.agent != null) 'agent': creds.agent,
      'messages': [
        if (systemPrompt != null)
          _serializeMessage(
            ApiMessage(role: 'system', content: systemPrompt),
          ),
        ...messages.map(_serializeMessage),
      ],
      'credentials': creds.credentials,
    };

    Response<Map<String, dynamic>> response;
    try {
      response = await _dio.post<Map<String, dynamic>>(
        _endpoint,
        data: body,
        options: Options(
          headers: {
            'Authorization': 'Bearer ${creds.gatewayKey}',
          },
          followRedirects: false,
          connectTimeout: _connectTimeout,
          receiveTimeout: _receiveTimeout,
        ),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      throw await _mapRequestError(e);
    }

    final status = response.statusCode;
    if (status == null || status < 200 || status >= 300) {
      if (status == 401) {
        throw const ChatServerError(
          'Inference unavailable – check your credentials.',
          statusCode: 401,
        );
      }
      throw ChatServerError(
        await _describeBody(response.data, status),
        statusCode: status,
      );
    }

    onReceived?.call();

    final data = response.data;
    final choices = data?['choices'];
    if (choices is! List || choices.isEmpty) {
      throw ChatStreamError('malformed completion response');
    }
    final choice = choices.first;
    final message = choice is Map<String, dynamic> ? choice['message'] : null;
    if (message is! Map<String, dynamic>) {
      throw ChatStreamError('malformed completion response');
    }

    final content = (message['content'] as String?) ?? '';
    final finishReason = (choice?['finish_reason'] as String?) ?? 'stop';
    final toolCalls = <ToolCall>[];
    final rawToolCalls = message['tool_calls'];
    if (rawToolCalls is List) {
      for (final raw in rawToolCalls) {
        if (raw is! Map<String, dynamic>) continue;
        final function = raw['function'];
        final name = function is Map<String, dynamic>
            ? (function['name'] as String? ?? '')
            : '';
        final argsRaw =
            function is Map<String, dynamic> ? function['arguments'] : null;
        final args = argsRaw is String ? _decodeToolArgs(argsRaw) : null;
        toolCalls.add(ToolCall(
          id: raw['id'] as String? ?? '',
          name: name,
          args: args,
        ));
      }
    }

    return ChatResult(
      content: content,
      toolCalls: toolCalls,
      finishReason: finishReason == 'tool_calls' ? 'tool_calls' : 'stop',
    );
  }

  Future<ChatResult> _streamOnce({
    required List<ApiMessage> messages,
    String? systemPrompt,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) async {
    final creds = await credentialResolver();
    if (creds == null) {
      throw ChatNetworkError(
        'Plugin configuration is unavailable. Sign in again from Settings to continue.',
      );
    }

    final body = <String, Object?>{
      'model': creds.modelPluginId,
      if (creds.agent != null) 'agent': creds.agent,
      'messages': [
        if (systemPrompt != null)
          _serializeMessage(
            ApiMessage(role: 'system', content: systemPrompt),
          ),
        ...messages.map(_serializeMessage),
      ],
      'stream': true,
      'credentials': creds.credentials,
    };

    Response<ResponseBody> response;
    try {
      response = await _dio.post<ResponseBody>(
        _endpoint,
        data: body,
        options: Options(
          headers: {
            'Authorization': 'Bearer ${creds.gatewayKey}',
            'accept': 'text/event-stream',
          },
          responseType: ResponseType.stream,
          followRedirects: false,
          connectTimeout: _connectTimeout,
          receiveTimeout: _receiveTimeout,
        ),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      throw await _mapRequestError(e);
    }

    final responseBody = response.data;
    if (responseBody == null) {
      throw ChatStreamError('empty stream response');
    }

    onReceived?.call();

    final content = StringBuffer();
    final toolAccums = <int, _ToolAccumulator>{};
    String? finishReason;
    var bytesReceived = false;

    try {
      await for (final event in parseSse(responseBody.stream)) {
        bytesReceived = true;
        switch (event.type) {
          case SseEventType.content:
            final text = event.content;
            if (text == null || text.isEmpty) break;
            content.write(text);
            onContent?.call(text);
          case SseEventType.toolCall:
            final delta = event.toolCall!;
            final acc =
                toolAccums.putIfAbsent(delta.index, _ToolAccumulator.new);
            if (delta.id != null) acc.id = delta.id;
            if (delta.name != null) acc.name = delta.name;
            if (delta.name != null || delta.argsFragment.isNotEmpty) {
              if (delta.argsFragment.isNotEmpty) {
                acc.args.write(delta.argsFragment);
              }
              onToolCallDelta
                  ?.call(delta.index, acc.name ?? '', delta.argsFragment);
            }
          case SseEventType.done:
            if (event.finishReason != null) finishReason = event.finishReason;
          case SseEventType.error:
            throw ChatStreamError(event.error ?? 'stream error');
        }
      }
    } on ChatStreamError {
      rethrow;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) {
        throw ChatNetworkError('cancelled');
      }
      if (!bytesReceived) {
        throw _ConnectionFailure(describeDioException(e));
      }
      throw ChatNetworkError(describeDioException(e));
    } catch (e) {
      if (!bytesReceived) {
        throw _ConnectionFailure('connection failed before any data: $e');
      }
      throw ChatNetworkError('stream error: $e');
    }

    final effectiveFinish = finishReason ?? 'stop';
    final toolCalls = <ToolCall>[];
    if (effectiveFinish == 'tool_calls' && toolAccums.isNotEmpty) {
      for (final acc in toolAccums.values) {
        final args = _decodeToolArgs(acc.args.toString());
        if (args == null) {
          return ChatResult(
            content: stripStructuredTokens(content.toString()),
            toolCalls: toolCalls,
            finishReason: effectiveFinish,
          );
        }
        toolCalls.add(
          ToolCall(id: acc.id ?? '', name: acc.name ?? '', args: args),
        );
      }
    }

    return ChatResult(
      content: stripStructuredTokens(content.toString()),
      toolCalls: toolCalls,
      finishReason: effectiveFinish,
    );
  }

  Map<String, dynamic> _serializeMessage(ApiMessage message) {
    final map = <String, dynamic>{'role': message.role};
    if (message.content != null) map['content'] = message.content;
    if (message.toolCalls != null && message.toolCalls!.isNotEmpty) {
      map['tool_calls'] = message.toolCalls;
    }
    if (message.toolCallId != null) map['tool_call_id'] = message.toolCallId;
    return map;
  }

  Future<Never> _mapRequestError(DioException e) async {
    switch (classifyDioException(e)) {
      case DioErrorCategory.cancelled:
        throw ChatNetworkError('cancelled');
      case DioErrorCategory.badResponse:
        final status = e.response?.statusCode;
        if (status == 401) {
          throw ChatServerError(
            'Inference unavailable – check your credentials.',
            statusCode: 401,
          );
        }
        throw ChatServerError(
          await _describeResponseError(e, status),
          statusCode: status,
        );
      case DioErrorCategory.timeoutNetwork:
        throw _ConnectionFailure(describeDioException(e));
      case DioErrorCategory.other:
        throw ChatNetworkError(describeDioException(e));
    }
  }

  /// Builds the most useful message for a non-2xx response, preferring the
  /// gateway's JSON `message`/`error` over a raw body dump. A streaming
  /// response hands back a [ResponseBody] that must be drained to see the
  /// payload, which is why this is async.
  Future<String> _describeResponseError(DioException e, int? status) =>
      _describeBody(e.response?.data, status);

  Future<String> _describeBody(Object? data, int? status) async {
    Object? decoded;
    if (data is ResponseBody) {
      try {
        final bytes = await data.stream.fold<List<int>>(
          <int>[],
          (acc, chunk) => acc..addAll(chunk),
        );
        decoded = jsonDecode(utf8.decode(bytes, allowMalformed: true));
      } catch (_) {
        decoded = null;
      }
    } else if (data is String) {
      try {
        decoded = jsonDecode(data);
      } catch (_) {
        decoded = null;
      }
    } else {
      decoded = data;
    }
    if (decoded is Map) {
      for (final key in const ['message', 'error']) {
        final value = decoded[key];
        if (value is String && value.trim().isNotEmpty) {
          return value.trim();
        }
      }
    }
    final raw = (data == null ? '' : '$data').trim();
    if (raw.isEmpty) return 'HTTP $status';
    return 'HTTP $status: ${truncateText(raw)}';
  }

  static Map<String, dynamic>? _decodeToolArgs(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    return decoded is Map<String, dynamic> ? decoded : null;
  }
}

class _ToolAccumulator {
  final StringBuffer args = StringBuffer();
  String? id;
  String? name;
}