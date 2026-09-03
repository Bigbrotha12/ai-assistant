import 'dart:convert';

import 'package:dio/dio.dart';

import '../features/chat/message_model.dart';
import 'network_errors.dart';
import 'sse.dart';

/// Structured event from the LLM stream.
sealed class ChatEvent {}

/// A content delta (thinking already stripped by the SSE parser).
class ChatContentEvent extends ChatEvent {
  ChatContentEvent(this.text);

  final String text;
}

/// Terminal event signalling the end of the stream.
class ChatDoneEvent extends ChatEvent {
  ChatDoneEvent(this.finishReason);

  /// 'stop' | 'tool_calls' | null (clean EOF without an explicit reason).
  final String? finishReason;
}

/// The fully-assembled result of a chat completion turn.
class ChatResult {
  const ChatResult({
    required this.content,
    required this.toolCalls,
    required this.finishReason,
  });

  final String content;

  /// Non-empty iff [finishReason] == 'tool_calls'.
  final List<ToolCall> toolCalls;

  /// 'stop' | 'tool_calls'.
  final String finishReason;
}

/// Base class for all errors surfaced by [ChatApiClient].
sealed class ChatApiError implements Exception {
  const ChatApiError(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// Transport-level failure (timeout, connection refused, cancellation).
class ChatNetworkError extends ChatApiError {
  const ChatNetworkError(super.message);
}

/// The server responded with a non-2xx status.
class ChatServerError extends ChatApiError {
  const ChatServerError(super.message, {this.statusCode});

  final int? statusCode;
}

/// The server sent an error envelope inside the stream.
class ChatStreamError extends ChatApiError {
  const ChatStreamError(super.message);
}

/// Internal marker for a request that failed with zero bytes received; the
/// streaming path retries once to ride out cold-starts (~30s model reload).
class _ConnectionFailure implements Exception {
  _ConnectionFailure(this.message);

  final String message;
}

/// Accumulates the argument fragments of a single tool call during streaming.
class _ToolAccumulator {
  final StringBuffer args = StringBuffer();
  String? id;
  String? name;
}

/// Contract for the OpenAI-compatible chat completions client. Extracted so
/// tests can inject a fake without coupling to the Dio-backed implementation.
abstract interface class ChatClient {
  /// Streams a chat completion, calling [onContent] for each content delta and
  /// [onToolCallDelta] for each tool-call fragment. Returns the full result.
  Future<ChatResult> streamCompletions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)? onToolCallDelta,
    CancelToken? cancelToken,
  });

  /// Non-streaming chat completion (fallback when streamed tool args fail).
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking,
    CancelToken? cancelToken,
  });
}

/// OpenAI-compatible chat completions client for the gateway LLM proxy
/// (`POST $baseUrl/v1/chat/completions`).
class ChatApiClient implements ChatClient {
  ChatApiClient({
    required this.baseUrl,
    Dio? dio,
    this.model = 'Qwen3-8B-Q4_K_M.gguf',
    this.apiKey,
  }) : _dio = dio ?? Dio();

  /// llmProxy(host), e.g. http://192.168.1.5:17600. No trailing slash.
  final String baseUrl;

  final String model;

  /// Gateway bearer API key sent as `Authorization: Bearer <apiKey>` on every
  /// request. Null when no key is available; requests then go out
  /// unauthenticated (and the gateway 401s them).
  final String? apiKey;

  final Dio _dio;

  static const Duration _connectTimeout = Duration(seconds: 8);
  static const Duration _receiveTimeout = Duration(seconds: 60);
  static const Duration _retryBackoff = Duration(seconds: 1);

  String get _endpoint => '$baseUrl/v1/chat/completions';

  /// Builds the per-request [Options]. The bearer API key (when set) is
  /// attached to every request so the gateway never 401s a chat call. The
  /// streaming path also opts into an SSE `accept` header and stream response
  /// type.
  Options _options({bool stream = false}) {
    final headers = <String, Object?>{};
    if (stream) headers['accept'] = 'text/event-stream';
    final key = apiKey;
    if (key != null && key.isNotEmpty) {
      headers['Authorization'] = 'Bearer $key';
    }
    return Options(
      headers: headers,
      responseType: stream ? ResponseType.stream : null,
      connectTimeout: _connectTimeout,
      receiveTimeout: _receiveTimeout,
    );
  }

  /// Streams a chat completion. Calls [onContent] for each content delta
  /// (thinking already stripped by the SSE parser), [onToolCallDelta] for each
  /// tool-call fragment. Returns the complete result.
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
  }) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        return await _streamOnce(
          messages: messages,
          systemPrompt: systemPrompt,
          maxTokens: maxTokens,
          temperature: temperature,
          tools: tools,
          enableThinking: enableThinking,
          onContent: onContent,
          onToolCallDelta: onToolCallDelta,
          cancelToken: cancelToken,
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

  /// Non-streaming fallback (used when streamed tool args fail to decode).
  @override
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
  }) async {
    final body = _buildBody(
      messages: messages,
      systemPrompt: systemPrompt,
      maxTokens: maxTokens,
      temperature: temperature,
      tools: tools,
      enableThinking: enableThinking,
      stream: false,
    );

    Response<Map<String, dynamic>> response;
    try {
      response = await _dio.post<Map<String, dynamic>>(
        _endpoint,
        data: body,
        options: _options(),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      throw _mapRequestError(e);
    }

    final status = response.statusCode;
    if (status == null || status < 200 || status >= 300) {
      throw ChatServerError('HTTP $status', statusCode: status);
    }

    final data = response.data;
    final choices = data?['choices'];
    if (choices is! List || choices.isEmpty) {
      throw ChatStreamError('malformed completion response');
    }
    final choice = choices.isEmpty ? null : choices.first;
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
    required int maxTokens,
    int? temperature,
    List<Map<String, Object?>>? tools,
    required bool enableThinking,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    CancelToken? cancelToken,
  }) async {
    final body = _buildBody(
      messages: messages,
      systemPrompt: systemPrompt,
      maxTokens: maxTokens,
      temperature: temperature,
      tools: tools,
      enableThinking: enableThinking,
      stream: true,
    );

    Response<ResponseBody> response;
    try {
      response = await _dio.post<ResponseBody>(
        _endpoint,
        data: body,
        options: _options(stream: true),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      throw _mapRequestError(e);
    }

    final responseBody = response.data;
    if (responseBody == null) {
      throw ChatStreamError('empty stream response');
    }

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
            if (delta.argsFragment.isNotEmpty) {
              acc.args.write(delta.argsFragment);
              onToolCallDelta
                  ?.call(delta.index, acc.name ?? '', delta.argsFragment);
            }
          case SseEventType.done:
            finishReason = event.finishReason;
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
        throw _ConnectionFailure(describeDioError(e));
      }
      throw ChatNetworkError(describeDioError(e));
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
          return completions(
            messages: messages,
            systemPrompt: systemPrompt,
            maxTokens: maxTokens,
            temperature: temperature,
            tools: tools,
            enableThinking: enableThinking,
            cancelToken: cancelToken,
          );
        }
        toolCalls.add(
          ToolCall(id: acc.id ?? '', name: acc.name ?? '', args: args),
        );
      }
    }

    return ChatResult(
      content: content.toString(),
      toolCalls: toolCalls,
      finishReason: effectiveFinish,
    );
  }

  Map<String, Object?> _buildBody({
    required List<ApiMessage> messages,
    String? systemPrompt,
    required int maxTokens,
    int? temperature,
    List<Map<String, Object?>>? tools,
    required bool enableThinking,
    required bool stream,
  }) {
    final body = <String, Object?>{
      'model': model,
      'messages': [
        if (systemPrompt != null)
          _serializeMessage(
            ApiMessage(role: 'system', content: systemPrompt),
          ),
        ...messages.map(_serializeMessage),
      ],
      'stream': stream,
      'max_tokens': maxTokens,
    };
    if (temperature != null) body['temperature'] = temperature;
    if (!enableThinking) {
      body['chat_template_kwargs'] = {'enable_thinking': false};
    }
    if (tools != null && tools.isNotEmpty) body['tools'] = tools;
    return body;
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

  Never _mapRequestError(DioException e) {
    switch (e.type) {
      case DioExceptionType.cancel:
        throw ChatNetworkError('cancelled');
      case DioExceptionType.badResponse:
        throw ChatServerError(
          describeDioError(e),
          statusCode: e.response?.statusCode,
        );
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.connectionError:
        throw _ConnectionFailure(describeDioError(e));
      case DioExceptionType.badCertificate:
      case DioExceptionType.unknown:
      case DioExceptionType.transformTimeout:
        throw ChatNetworkError(describeDioError(e));
    }
  }

  /// Decodes a tool-call `arguments` JSON string into a map. Returns null for
  /// empty or malformed payloads, and for JSON that is not an object.
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

/// True when [error] is a gateway authentication rejection (HTTP 401 from a
/// chat/vision call), which drives the re-auth affordances in the chat and
/// voice UIs.
bool isAuthRequiredError(Object error) =>
    error is ChatServerError && error.statusCode == 401;
