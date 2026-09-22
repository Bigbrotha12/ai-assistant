import 'dart:convert';

import 'package:dio/dio.dart';

import '../../chat/data/chat_client.dart';
import '../../chat/data/message_model.dart';
import '../../chat/data/sse.dart';
import 'langchain_request.dart';
import 'ledger_client.dart';
import 'managed_conversation_dto.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

/// Terminal statuses a background submission can echo on its JSON response
/// (`200 {status: <terminalStatus>}` — the job already finished before the
/// submission round-tripped). Single source of truth lives on [LedgerTaskStatus]
///'s export in [terminalTaskStatuses]; `accepted` is the non-terminal admission
/// result.
const _backgroundTerminalStatuses = terminalTaskStatuses;

/// Result of a background submission: `accepted` (the job is queued/running —
/// poll the ledger) or a terminal status (the job already finished).
class BackgroundTurnResult {
  const BackgroundTurnResult({
    required this.status,
    required this.taskId,
    this.threadId,
  });

  /// 'accepted' or a terminal status ('succeeded' | 'failed' | 'cancelled' |
  /// 'awaiting_review').
  final String status;
  final String taskId;

  /// The background job's worker label (the raw client thread handle).
  final String? threadId;

  bool get accepted => status == 'accepted';
}

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

  /// Submits a background job (plan §5 async submission). The gateway admits
  /// an idempotent task (keyed by `messageId`) and responds with plain JSON —
  /// NOT an SSE stream: `202 {status:"accepted",taskId}` (queued/running),
  /// `200 {status:<terminalStatus>,taskId}` (the job already finished), or
  /// `200 {status:"already_completed",terminalStatus,taskId,threadId}` (a
  /// re-submission of an already-terminal messageId — mapped back onto the
  /// terminal [BackgroundTurnResult]). A job that fails at admission surfaces
  /// the normal error envelope via the transport. The caller polls the ledger
  /// for the terminal status and reads the reply back via the full task.
  Future<BackgroundTurnResult> backgroundTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
  }) async {
    if (!request.background) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/chat/completions',
        gatewayKey: request.gatewayKey,
        cancelToken: token,
        body: request.toJson(),
      );
      final json = pluginJsonObject(await _http.readJson(response.data));
      final status = pluginJsonString(json['status']);
      if (status != 'accepted' &&
          status != 'already_completed' &&
          !_backgroundTerminalStatuses.contains(status)) {
        throw const PluginProtocolException();
      }
      // `already_completed` reports the job's terminal status in a separate
      // field (`terminalStatus`); surface it as the terminal result so the
      // caller can learn the job's fate instead of a protocol error.
      final effectiveStatus = status == 'already_completed'
          ? pluginJsonString(json['terminalStatus'])
          : status;
      if (effectiveStatus != 'accepted' &&
          !_backgroundTerminalStatuses.contains(effectiveStatus)) {
        throw const PluginProtocolException();
      }
      final taskId = managedPublicId(json['taskId']);
      final rawThread = json['threadId'];
      final threadId =
          rawThread is String && rawThread.isNotEmpty ? rawThread : null;
      return BackgroundTurnResult(
        status: effectiveStatus,
        taskId: taskId,
        threadId: threadId,
      );
    });
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
    var sessionId = '';
    var state = '';
    if (request.managed) {
      sessionId = managedPublicId(response.headers.value('x-session-id'));
      state = response.headers.value('x-conversation-state') ?? '';
      if (request.conversationPublicId != null &&
          request.conversationPublicId != sessionId) {
        throw const PluginProtocolException();
      }
      if (!['seeded', 'resumed'].contains(state)) {
        throw const PluginProtocolException();
      }
      if (response.headers.value('content-type')?.split(';').first ==
          'application/json') {
        final json = pluginJsonObject(await _http.readJson(response.data));
        if (json['status'] != 'already_completed' ||
            json['sessionId'] != sessionId) {
          throw const PluginProtocolException();
        }
        return ManagedTurnResult(
          sessionId: sessionId,
          state: state,
          alreadyCompleted: true,
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
      sessionId: sessionId,
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

  Future<ManagedSessionHistory> loadSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _session(
    '/sessions/${Uri.encodeComponent(managedPublicId(sessionId))}',
    gatewayKey,
    cancelToken,
    (json) {
      final history = ManagedSessionHistory.fromJson(json);
      if (history.sessionId != sessionId) {
        throw const PluginProtocolException();
      }
      return history;
    },
  );

  Future<void> deleteSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _session(
    '/sessions/${Uri.encodeComponent(managedPublicId(sessionId))}',
    gatewayKey,
    cancelToken,
    (json) {
      if (pluginJsonObject(json)['status'] != 'ok') {
        throw const PluginProtocolException();
      }
    },
    method: 'DELETE',
  );

  Future<T> _session<T>(
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
