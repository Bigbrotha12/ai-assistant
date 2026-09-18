import 'dart:convert';

import 'package:dio/dio.dart';

import '../../chat/data/chat_client.dart';
import '../../chat/data/message_model.dart';
import '../../chat/data/sse.dart';
import 'langchain_request.dart';
import 'managed_conversation_dto.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

class LangChainClient {
  LangChainClient({
    required Dio dio,
    required String baseUrl,
    Duration timeout = const Duration(seconds: 180),
  }) : _http = PluginHttp(dio: dio, baseUrl: baseUrl, timeout: timeout);

  final PluginHttp _http;

  Future<ChatResult> streamTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function()? onReceived,
    void Function(String text)? onContent,
    void Function(ToolCallDelta delta)? onToolCallDelta,
  }) async => (await _turn(
    request,
    cancelToken: cancelToken,
    onReceived: onReceived,
    onContent: onContent,
    onToolCallDelta: onToolCallDelta,
  )).result!;

  Future<ManagedTurnResult> managedTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function(String text)? onContent,
  }) {
    if (!request.managed) throw const PluginClientException('invalid_request');
    return _turn(request, cancelToken: cancelToken, onContent: onContent);
  }

  Future<ManagedTurnResult> _turn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function()? onReceived,
    void Function(String text)? onContent,
    void Function(ToolCallDelta delta)? onToolCallDelta,
  }) => _http.run(cancelToken, (token) async {
    final response = await _http.send(
      path: '/chat/completions',
      gatewayKey: request.gatewayKey,
      cancelToken: token,
      body: request.toJson(),
    );
    var threadId = '';
    var state = '';
    if (request.managed) {
      threadId = managedPublicId(response.headers.value('x-thread-id'));
      state = response.headers.value('x-conversation-state') ?? '';
      if (request.conversationPublicId != null &&
          request.conversationPublicId != threadId) {
        throw const PluginProtocolException();
      }
      if (!['seeded', 'resumed', 'recreated'].contains(state)) {
        throw const PluginProtocolException();
      }
      if (response.headers.value('content-type')?.split(';').first ==
          'application/json') {
        final json = pluginJsonObject(await _http.readJson(response.data));
        if (json['status'] != 'already_completed' ||
            json['threadId'] != threadId) {
          throw const PluginProtocolException();
        }
        return ManagedTurnResult(
          threadId: threadId,
          state: state,
          taskId: managedPublicId(json['taskId']),
          terminalStatus: parseManagedTerminalStatus(json['terminalStatus']),
        );
      }
    }
    if (response.data == null ||
        response.headers
                .value('content-type')
                ?.split(';')
                .first
                .trim()
                .toLowerCase() !=
            'text/event-stream') {
      throw const PluginClientException('invalid_response');
    }
    onReceived?.call();
    final content = StringBuffer();
    final tools = <int, _DisplayTool>{};
    final wire = _StagedSse();
    String? finishReason;
    await for (final event in parseSse(wire.validate(response.data!.stream))) {
      switch (event.type) {
        case SseEventType.content:
          content.write(event.content!);
          onContent?.call(event.content!);
        case SseEventType.toolCall:
          final delta = event.toolCall!;
          if (delta.index < 0) throw const PluginProtocolException();
          final tool = tools.putIfAbsent(delta.index, _DisplayTool.new);
          tool.id ??= delta.id;
          tool.name ??= delta.name;
          tool.arguments.write(delta.argsFragment);
          onToolCallDelta?.call(delta);
        case SseEventType.error:
          throw PluginClientException(safePluginErrorCode(event.error));
        case SseEventType.done:
          finishReason = event.finishReason;
      }
    }
    if (!wire.terminated ||
        finishReason == null && (content.isNotEmpty || tools.isNotEmpty)) {
      throw const PluginClientException('incomplete_stream');
    }
    final indexes = tools.keys.toList()..sort();
    return ManagedTurnResult(
      threadId: threadId,
      state: state,
      result: ChatResult(
        content: stripStructuredTokens(content.toString()),
        toolCalls: List.unmodifiable(
          indexes.map((index) => tools[index]!.build()),
        ),
        finishReason: finishReason ?? 'stop',
      ),
    );
  });

  Future<List<ManagedThreadSummary>> listThreads({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _threads('/threads', gatewayKey, cancelToken, (json) {
    final rows = pluginJsonObject(json)['threads'];
    if (rows is! List) throw const PluginProtocolException();
    return List.unmodifiable(rows.map(ManagedThreadSummary.fromJson));
  });

  Future<ManagedThreadHistory> loadThread(
    String threadId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _threads(
    '/threads/${Uri.encodeComponent(managedPublicId(threadId))}',
    gatewayKey,
    cancelToken,
    (json) {
      final history = ManagedThreadHistory.fromJson(json);
      if (history.threadId != threadId) throw const PluginProtocolException();
      return history;
    },
  );

  Future<void> deleteThread(
    String threadId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _threads(
    '/threads/${Uri.encodeComponent(managedPublicId(threadId))}',
    gatewayKey,
    cancelToken,
    (json) {
      if (pluginJsonObject(json)['status'] != 'ok') {
        throw const PluginProtocolException();
      }
    },
    method: 'DELETE',
  );

  Future<T> _threads<T>(
    String path,
    String key,
    CancelToken? token,
    T Function(Object?) parse, {
    String? method,
  }) => _http.run(token, (local) async {
    final response = await _http.send(
      path: path,
      gatewayKey: key,
      cancelToken: local,
      method: method,
    );
    return parse(await _http.readJson(response.data));
  });
}

class _DisplayTool {
  String? id;
  String? name;
  final arguments = StringBuffer();

  ToolCall build() {
    if (id == null || name == null) throw const PluginProtocolException();
    final args = pluginJsonObject(decodePluginJson(arguments.toString()));
    return ToolCall(
      id: id!,
      name: name!,
      args: freezePluginJson(args) as Map<String, dynamic>,
    );
  }
}

class _StagedSse {
  bool terminated = false;

  Stream<List<int>> validate(Stream<List<int>> bytes) async* {
    final lines = const Utf8Decoder()
        .bind(bytes)
        .transform(const LineSplitter());
    await for (final line in lines) {
      if (!line.startsWith('data:')) {
        yield utf8.encode('$line\n');
        continue;
      }
      final payload = line.substring(5).trim();
      if (payload.isEmpty) continue;
      if (payload == '[DONE]') {
        terminated = true;
        yield utf8.encode('$line\n');
        return;
      }
      final json = pluginJsonObject(decodePluginJson(payload));
      if (json.containsKey('error')) {
        yield utf8.encode(
          'data: ${jsonEncode({'error': safePluginErrorCode(json)})}\n',
        );
        return;
      }
      yield utf8.encode('$line\n');
    }
  }
}
