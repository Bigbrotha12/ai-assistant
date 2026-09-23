import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/context_trimmer.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/data/sse.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/langchain_request.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_dto.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/notifications/data/notif_client.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeLangChainClient implements LangChainClient {
  FakeLangChainClient(this.respond);

  final Future<ManagedTurnResult> Function(LangChainRequest) respond;
  Future<BackgroundTurnResult> Function(LangChainRequest) respondBackground =
      (_) async => const BackgroundTurnResult(
        status: 'accepted',
        taskId: 'task-1',
      );
  final requests = <LangChainRequest>[];
  final cancelTokens = <CancelToken?>[];
  final sessionLoads = <String>[];
  final deletedSessions = <({String sessionId, String gatewayKey})>[];
  Object? loadSessionError;

  /// When set, returns this scripted session for [loadSession] instead of
  /// the default fixed history.
  ManagedSessionHistory Function(String sessionId)? historyBuilder;

  /// Deltas delivered via [onContent] before [respond] runs (when
  /// [respondWithEmit] is null).
  List<String> emitDeltas = const [];

  /// When set, called with an emit closure before [respond] so tests can
  /// drive mid-stream effects (e.g. [ManagedConversationRepository.cancelScope]
  /// between deltas). Exceptions from the closure propagate out of
  /// [managedTurn] exactly as a real SSE stream would.
  void Function(void Function(String text) emit)? respondWithEmit;

  @override
  Future<ManagedTurnResult> managedTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function(String text)? onContent,
  }) async {
    requests.add(request);
    cancelTokens.add(cancelToken);
    final emit = respondWithEmit;
    if (onContent != null) {
      if (emit != null) {
        emit(onContent);
      } else {
        for (final delta in emitDeltas) {
          onContent(delta);
        }
      }
    }
    return respond(request);
  }

  @override
  Future<BackgroundTurnResult> backgroundTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
  }) async {
    requests.add(request);
    cancelTokens.add(cancelToken);
    return respondBackground(request);
  }

  @override
  Future<ChatResult> streamTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function()? onReceived,
    void Function(String text)? onContent,
    void Function(ToolCallDelta delta)? onToolCallDelta,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<ManagedSessionHistory> loadSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    if (loadSessionError != null) throw loadSessionError!;
    sessionLoads.add(sessionId);
    final builder = historyBuilder;
    if (builder != null) return builder(sessionId);
    return ManagedSessionHistory.fromJson({
      'sessionId': sessionId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'from server'},
      ],
    });
  }

  @override
  Future<void> deleteSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    deletedSessions.add((sessionId: sessionId, gatewayKey: gatewayKey));
  }
}

Map<String, dynamic> backgroundTaskJson({
  required String status,
  required String messageId,
  required String taskId,
}) => {
  'id': taskId,
  'owner': 'owner-a',
  'intent_key': messageId,
  'status': status,
  'created_ts': 1,
  'updated_ts': 2,
  'last_heartbeat_ts': 2,
};

ResponseBody jsonResponse(
  Object? value, {
  int status = 200,
}) => ResponseBody.fromString(
  jsonEncode(value),
  status,
  headers: {
    'content-type': ['application/json'],
  },
);

class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.respond);
  final FutureOr<ResponseBody> Function(RequestOptions) respond;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

class FakeScheduler implements LedgerScheduler {
  @override
  Duration elapsed = Duration.zero;
  final jobs = <({Duration at, void Function() callback, List<bool> active})>[];

  @override
  LedgerCancel schedule(Duration delay, void Function() callback) {
    final active = [true];
    jobs.add((at: elapsed + delay, callback: callback, active: active));
    return () => active[0] = false;
  }

  Future<void> advance(Duration duration) async {
    final target = elapsed + duration;
    await flush();
    while (true) {
      jobs.sort((a, b) => a.at.compareTo(b.at));
      final ready = jobs
          .where((j) => j.active[0] && j.at <= target)
          .firstOrNull;
      if (ready == null) break;
      elapsed = ready.at;
      ready.active[0] = false;
      ready.callback();
      await flush();
    }
    elapsed = target;
    await flush();
  }
}

Future<void> flush() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// A ledger poller over the fake adapter, driven by the fake clock. The
/// poller's credentials resolver returns scope-matching [AuthCredentials].
LedgerPoller testPoller(
  AuthAccountScope scope,
  FakeAdapter adapter,
  FakeScheduler clock,
) => LedgerPoller(
  client: LedgerClient(dio: (Dio()..httpClientAdapter = adapter), scope: scope),
  credentials: () async => AuthCredentials(
    apiKey: 'gateway-secret',
    ownerId: 'owner-a',
    backendOrigin: 'https://gw.test',
  ),
  scheduler: clock,
  maxAttempts: 12,
  maxElapsed: const Duration(seconds: 30),
  maxDelay: const Duration(seconds: 3),
);

/// Pumps microtasks until [condition] holds (async reconciliation after a
/// terminal poll runs off the fake scheduler's timer callbacks).
Future<void> waitFor(Future<bool> Function() condition) async {
  for (var i = 0; i < 100; i++) {
    if (await condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  throw StateError('waitFor timed out');
}

class FakeNotifClient implements NotifClient {
  final subscribed = <String>[];
  final unsubscribed = <String>[];

  @override
  Future<void> subscribe(String topic) async => subscribed.add(topic);

  @override
  Future<void> unsubscribe(String topic) async => unsubscribed.add(topic);
}

/// Session id of the first recorded managed request (handy inside gate
/// completions where the request variable is not in scope).
String request0Session(FakeLangChainClient client) =>
    client.requests.first.conversationPublicId ?? '';

void main() {
  late AppDatabase db;
  late ManagedConversationRepository repo;
  late FakeLangChainClient client;
  late ManagedConversationService service;
  late AuthAccountScope scope;
  var gatewayKey = 'gateway-secret';
  var turns = 0;
  late Future<ManagedTurnResult> Function(LangChainRequest) respondWith;

  setUp(() {
    turns = 0;
    respondWith = (request) async {
      turns++;
      return ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: turns == 1 ? 'seeded' : 'resumed',
        result: const ChatResult(
          content: 'local reply',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
    };
    db = AppDatabase(NativeDatabase.memory());
    repo = ManagedConversationRepository(db);
    client = FakeLangChainClient((request) => respondWith(request));
    scope = AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gw.test',
      ownerId: 'owner-a',
    )!;
    service = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
    );
  });

  tearDown(() async => db.close());

  test('seed turn persists messageId + envelope BEFORE dispatch and binds the '
      'client-minted session id', () async {
    final outcome = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
    );
    expect(outcome.sessionId, isNotEmpty);
    expect(outcome.state, 'seeded');
    expect(client.requests.single.turnId, isNotNull);
    expect(client.requests.single.conversationPublicId, outcome.sessionId);
    expect(client.requests.single.toJson()['conversation_mode'], 'managed');
    expect(client.requests.single.toJson()['enabled_plugins'], ['web']);
    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNull);
    final mapped = await repo.mappedSession('c1');
    expect(mapped, outcome.sessionId);
  });

  test('sendTurn threads onContent deltas through the dispatch wrapper',
      () async {
    client.emitDeltas = const ['Hel', 'lo'];
    final seen = <String>[];
    final outcome = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
      onContent: seen.add,
    );
    expect(seen, ['Hel', 'lo']);
    expect(outcome, isA<ManagedStreamedTurn>());
  });

  test('onContent deltas are epoch-checked: cancelScope mid-stream drops the '
      'late delta and surfaces ManagedTurnError(cancelled)', () async {
    final seen = <String>[];
    client.respondWithEmit = (emit) {
      emit('first');
      repo.cancelScope(scope);
      emit('second'); // _checkEpoch throws before the collector sees it
    };
    await expectLater(
      service.sendTurn(
        'c1',
        history: const [],
        userText: 'hi',
        onContent: seen.add,
      ),
      throwsA(
        isA<ManagedTurnError>().having((e) => e.code, 'code', 'cancelled'),
      ),
    );
    expect(seen, ['first']);
  });

  test('establish sends the FULL local history and the server seeds', () async {
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'earlier'),
        Message(
          id: 'm2',
          role: MessageRole.assistant,
          content: 'earlier reply',
        ),
      ],
      userText: 'hi',
    );
    expect(outcome.state, 'seeded');
    final body = client.requests.single.toJson();
    expect(body['session_id'], outcome.sessionId);
    expect((body['messages'] as List).map((m) => m['content']), [
      'earlier',
      'earlier reply',
      'hi',
    ]);
    expect(await repo.mappedSession('c1'), outcome.sessionId);
  });

  test('a subsequent turn on a mapped session sends a single-message delta '
      'and is resumed', () async {
    final first = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
    );
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(
          id: 'm2',
          role: MessageRole.assistant,
          content: 'local reply',
        ),
      ],
      userText: 'second',
    );
    expect(outcome.sessionId, first.sessionId);
    expect(outcome.state, 'resumed');
    final last = client.requests.last.toJson();
    expect((last['messages'] as List).map((m) => m['content']), ['second']);
  });

  test('duplicate inflight 409 throws ManagedTurnError with session id, keeps '
      'pending row for explicit retry', () async {
    respondWith = (request) {
      throw const PluginClientException(
        'conversation_in_flight',
        statusCode: 409,
      );
    };
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(
        isA<ManagedTurnError>().having(
          (e) => e.code,
          'code',
          'conversation_in_flight',
        ),
      ),
    );
    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNotNull);
    final messageId = pending!.messageId;
    final session = await repo.mappedSession('c1');

    respondWith = (request) async => ManagedTurnResult(
      sessionId: session!,
      state: 'resumed',
      result: const ChatResult(
        content: 'late reply',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    final outcome = await service.retryTurn('c1');
    expect(outcome.state, 'resumed');
    expect(client.requests.last.turnId, messageId);
    expect(client.requests.last.conversationPublicId, session);
    expect(await repo.pending(scope, 'c1'), isNull);
  });

  test('already_completed duplicate success returns no result and clears the '
      'pending row without a second inference body', () async {
    // Stage a turn that fails on the wire (pending row survives), then the
    // explicit retry hits a turn the server already completed.
    respondWith = (request) {
      throw const PluginClientException('network_error');
    };
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final session = await repo.mappedSession('c1');
    respondWith = (request) async => ManagedTurnResult(
      sessionId: session!,
      state: 'resumed',
      alreadyCompleted: true,
    );
    final outcome = await service.retryTurn('c1');
    expect(outcome, isA<ManagedAlreadyCompleted>());
    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNull);
  });

  test('retryTurn re-sends the EXACT same envelope (messageId, session, '
      'messages) after a network drop', () async {
    respondWith = (request) {
      throw const PluginClientException('network_error');
    };
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final before = await repo.pending(scope, 'c1');
    final firstBody = client.requests.single.toJson();

    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'resumed',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await service.retryTurn('c1');
    final secondRequest = client.requests.last;
    expect(secondRequest.turnId, before!.messageId);
    expect(secondRequest.conversationPublicId, firstBody['session_id']);
    final secondBody = secondRequest.toJson();
    expect(secondBody['messages'], firstBody['messages']);
    expect(secondBody['session_id'], firstBody['session_id']);
    expect(secondBody['messageId'], firstBody['messageId']);
  });

  test('the persisted retry envelope stores session_id', () async {
    respondWith = (request) {
      throw const PluginClientException('network_error');
    };
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final pending = await repo.pending(scope, 'c1');
    final envelope = jsonDecode(pending!.envelope) as Map<String, dynamic>;
    expect(envelope['session_id'], await repo.mappedSession('c1'));
    expect(envelope.containsKey('threadId'), isFalse);
    expect(envelope.containsKey('taskId'), isFalse);
    expect(envelope.containsKey('terminalStatus'), isFalse);
  });

  test('reconcileFromServer replaces local history from the session without '
      'inference', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    final session = await repo.mappedSession('c1');
    final messages = await service.reconcileFromServer('c1');
    expect(client.sessionLoads, [session]);
    expect(messages, hasLength(2));
    expect(messages.last.content, 'from server');
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.content, 'from server');
    expect(await repo.pending(scope, 'c1'), isNull);
  });

  test('reconcileFromServer surfaces reseed_required explicitly', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    client.loadSessionError = const PluginClientException(
      'reseed_required',
      statusCode: 409,
    );
    await expectLater(
      service.reconcileFromServer('c1'),
      throwsA(
        isA<PluginClientException>().having(
          (e) => e.code,
          'code',
          'reseed_required',
        ),
      ),
    );
  });

  test('reconcileFromServer on session_missing returns local history and '
      'clears the marker without dropping the mapping', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    client.loadSessionError = const PluginClientException(
      'session_missing',
      statusCode: 409,
    );
    final messages = await service.reconcileFromServer('c1');
    expect(messages.map((m) => m.content), ['hi', 'local reply']);
    expect(await repo.pending(scope, 'c1'), isNull);
    expect(await repo.mappedSession('c1'), isNotNull);
  });

  test(
    'account switch: other scope cannot see or overwrite this history',
    () async {
      await service.sendTurn('c1', history: const [], userText: 'hi');
      final scopeB = AuthAccountScope.fromIdentity(
        backendOrigin: 'https://gw.test',
        ownerId: 'owner-b',
      )!;
      final serviceB = ManagedConversationService(
        client: client,
        repo: repo,
        scope: scopeB,
        credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      );
      // Primary keys are global in the shared DB, so account B uses its own
      // conversation id — mirroring the app, where ids are random UUIDs.
      await serviceB.sendTurn('c2', history: const [], userText: 'other user');
      final a = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      final b = await repo.access(
        scopeB,
        repo.epoch(scopeB),
        () {},
        (store) => store.loadConversation('c2'),
      );
      expect(a!.messages, hasLength(2));
      expect(a.messages.first.content, 'hi');
      expect(b!.messages, hasLength(2));
      expect(b.messages.first.content, 'other user');
      expect(await repo.pending(scope, 'c1'), isNull);
      expect(await repo.pending(scopeB, 'c2'), isNull);
      expect(await repo.mappedSession('c1'), isNotNull);
      expect(await repo.mappedSession('c2'), isNotNull);
    },
  );

  test('clearAccountData cancels in-flight writes and prevents late history '
      'repopulation', () async {
    final sent = service.sendTurn('c1', history: const [], userText: 'hi');
    // Simulate a scope clear while the send is awaiting the response.
    respondWith = (request) async {
      await service.clearAccountData();
      return ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: 'seeded',
        result: const ChatResult(
          content: 'late reply',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
    };
    await expectLater(sent, throwsA(anything));
    final rows = await db.select(db.conversations).get();
    expect(rows, isEmpty);
  });

  test('deleteSession passes the gateway key through and hits the session '
      'path', () async {
    await service.deleteSession('session-1');
    expect(client.deletedSessions, [
      (sessionId: 'session-1', gatewayKey: 'gateway-secret'),
    ]);
  });

  test('reconciliation persists distinct stable message ids and keeps tool '
      'linkage (no row collapse, no cross-conversation bleed)', () async {
    client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
      'sessionId': sessionId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {
          'role': 'assistant',
          'content': null,
          'tool_calls': [
            {
              'id': 'call_1',
              'type': 'function',
              'function': {
                'name': 'web_search',
                'arguments': '{"q":"weather"}',
              },
            },
          ],
        },
        {'role': 'tool', 'content': 'sunny', 'tool_call_id': 'call_1'},
        {'role': 'assistant', 'content': 'done'},
      ],
    });
    await service.sendTurn('c1', history: const [], userText: 'hi');

    final first = await service.reconcileFromServer('c1');
    final ids = first.map((m) => m.id).toList();
    expect(ids.every((id) => id.isNotEmpty), isTrue,
        reason: 'a blank primary key collapses history to one row');
    expect(ids.toSet(), hasLength(first.length));
    expect(first.any((m) => m.id.contains('call_1')), isFalse);

    // Re-reconciling is stable: the same ids come back.
    final second = await service.reconcileFromServer('c1');
    expect(second.map((m) => m.id).toList(), ids);

    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages, hasLength(4));
    expect(loaded.messages.map((m) => m.id).toSet(), hasLength(4));
    final tool = loaded.messages.firstWhere((m) => m.role == MessageRole.tool);
    expect(tool.toolCallId, 'call_1');

    // A second session's reconciliation never shares rows with this one.
    final other = ManagedSessionHistory.fromJson({
      'sessionId': 'session-other',
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'hello'},
        {'role': 'user', 'content': 'again'},
      ],
    });
    expect(
      other.messages.map((m) => m.id).toSet().intersection(ids.toSet()),
      isEmpty,
    );
  });

  test('logout mid-send cancels the turn and leaves no pending row or '
      'conversation behind (admission + clear atomicity)', () async {
    final sent = service.sendTurn('c1', history: const [], userText: 'hi');
    // The server replies only after a scope-wide clear has run: the clear
    // must win the race — no pending row, no conversation may resurge.
    respondWith = (request) async {
      await service.clearAccountData();
      return ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: 'seeded',
        result: const ChatResult(
          content: 'late reply',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
    };
    await expectLater(sent, throwsA(isA<Exception>()));
    expect(await db.select(db.conversations).get(), isEmpty);
    expect(await db.select(db.managedPendingTurns).get(), isEmpty);
  });

  test('a second send while a turn is unresolved throws pending_turn_exists '
      'and the first completion owns its pending row', () async {
    var dispatchedSession = '';
    final gate = Completer<ManagedTurnResult>();
    respondWith = (request) {
      dispatchedSession = request.conversationPublicId!;
      return gate.future;
    };
    final first = service.sendTurn('c1', history: const [], userText: 'first');
    while ((await repo.pending(scope, 'c1')) == null) {
      await Future<void>.delayed(Duration.zero);
    }
    final messageId = (await repo.pending(scope, 'c1'))!.messageId;

    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'second'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'pending_turn_exists'),
      ),
    );
    // The rejected send neither replaced the pending row nor appended.
    expect((await repo.pending(scope, 'c1'))!.messageId, messageId);
    final conversation = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (s) => s.loadConversation('c1'),
    );
    expect(conversation!.messages, hasLength(1));

    gate.complete(
      ManagedTurnResult(
        sessionId: dispatchedSession,
        state: 'seeded',
        result: const ChatResult(
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop',
        ),
      ),
    );
    await first;
    expect(await repo.pending(scope, 'c1'), isNull);
  });

  test('already_completed reconciles server history via loadSession without '
      'fabricating an assistant reply', () async {
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final session = await repo.mappedSession('c1');
    client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
      'sessionId': sessionId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'checkpoint reply'},
      ],
    });
    respondWith = (request) async => ManagedTurnResult(
      sessionId: session!,
      state: 'resumed',
      alreadyCompleted: true,
    );
    final outcome = await service.retryTurn('c1');
    expect(outcome, isA<ManagedAlreadyCompleted>());
    expect(client.sessionLoads, [session]);
    expect(await repo.pending(scope, 'c1'), isNull);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages, hasLength(2));
    expect(loaded.messages.last.content, 'checkpoint reply');
    expect(
      loaded.messages.any(
        (m) => m.role == MessageRole.assistant && m.content.isEmpty,
      ),
      isFalse,
    );
  });

  test('a mid-reconcile failure persists a reconcileOnly marker; retry is '
      'refused and explicit reconcile completes it', () async {
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final session = await repo.mappedSession('c1');
    client.loadSessionError = const PluginClientException('network_error');
    respondWith = (request) async => ManagedTurnResult(
      sessionId: session!,
      state: 'resumed',
      alreadyCompleted: true,
    );
    await expectLater(service.retryTurn('c1'), throwsA(isA<PluginClientException>()));

    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNotNull);
    expect(pending!.reconcileOnly, isTrue);
    final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
    expect(envelope['session_id'], session);
    expect(envelope.containsKey('taskId'), isFalse);
    expect(envelope.containsKey('terminalStatus'), isFalse);

    // Inference replay of an already-reconciled turn is explicit, not silent.
    await expectLater(
      service.retryTurn('c1'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'reconcile_required'),
      ),
    );

    client.loadSessionError = null;
    client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
      'sessionId': sessionId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'checkpoint reply'},
      ],
    });
    final history = await service.reconcileFromServer('c1');
    expect(history, hasLength(2));
    expect(await repo.pending(scope, 'c1'), isNull);
    expect(await repo.mappedSession('c1'), session);
  });

  test('retryTurn replays the persisted envelope config, never the current '
      'service instance model/plugins', () async {
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final before = await repo.pending(scope, 'c1');
    final other = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      modelPluginId: 'unrelated-model',
      enabledPlugins: const ['images'],
    );
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'resumed',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await other.retryTurn('c1');
    final request = client.requests.last;
    expect(request.turnId, before!.messageId);
    expect(request.modelPluginId, 'openrouter');
    expect(request.enabledPlugins, ['web']);
    expect(request.toJson()['model'], 'openrouter');
    expect(request.toJson()['enabled_plugins'], ['web']);
  });

  test('retryTurn fails loudly on a corrupted envelope instead of replaying '
      'the current config', () async {
    await repo.savePending(
      'c1',
      scope,
      'msg-broken',
      {'model': 'anything'},
    );
    await expectLater(
      service.retryTurn('c1'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'invalid_config'),
      ),
    );
    // The pending row survives an invalid config so a repair can replace it.
    expect((await repo.pending(scope, 'c1'))!.messageId, 'msg-broken');
  });

  test('session_missing re-establishes under the SAME session_id with full '
      'history and a fresh messageId (bounded single retry)', () async {
    final first = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
    );
    final session = first.sessionId;
    var calls = 0;
    final messageIds = <String>[];
    respondWith = (request) {
      calls++;
      messageIds.add(request.turnId!);
      if (calls == 1) {
        throw const PluginClientException('session_missing', statusCode: 409);
      }
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'resumed',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(
          id: 'm2',
          role: MessageRole.assistant,
          content: 'local reply',
        ),
      ],
      userText: 'second',
    );
    expect(calls, 2);
    expect(outcome.sessionId, session);
    expect(outcome.state, 'resumed');
    final bodies = client.requests.map((r) => r.toJson()).toList();
    // [0] is the first turn's establish; [1] the delta on the now-evicted
    // session; [2] the re-establish under the SAME session id with the FULL
    // local history (which already includes the user's message).
    expect(bodies, hasLength(3));
    expect(bodies[0]['session_id'], session);
    expect((bodies[0]['messages'] as List).map((m) => m['content']), ['hi']);
    expect(bodies[1]['session_id'], session);
    expect((bodies[1]['messages'] as List).map((m) => m['content']), ['second']);
    expect(bodies[2]['session_id'], session);
    expect(
      (bodies[2]['messages'] as List).map((m) => m['content']),
      ['hi', 'local reply', 'second'],
    );
    // A fresh messageId was minted for the re-establish.
    expect(messageIds.toSet(), hasLength(2));
    expect(await repo.pending(scope, 'c1'), isNull);
    // The mapping is retained — never dropped-and-minted.
    expect(await repo.mappedSession('c1'), session);
  });

  test('session_missing on the re-establish itself surfaces the error '
      'instead of looping', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    respondWith = (_) =>
        throw const PluginClientException('session_missing', statusCode: 409);
    await expectLater(
      service.sendTurn(
        'c1',
        history: const [
          Message(id: 'm1', role: MessageRole.user, content: 'hi'),
          Message(
            id: 'm2',
            role: MessageRole.assistant,
            content: 'local reply',
          ),
        ],
        userText: 'second',
      ),
      throwsA(
        isA<ManagedTurnError>().having(
          (e) => e.code,
          'code',
          'session_missing',
        ),
      ),
    );
    // Original turn + delta + exactly one re-establish attempt — then the
    // error surfaces instead of looping.
    expect(client.requests, hasLength(3));
    expect(await repo.mappedSession('c1'), isNotNull);
    expect(await repo.pending(scope, 'c1'), isNotNull);
  });

  test('silent reseed: a DELTA answered seeded discards the context-free reply, '
      're-establishes under the SAME session_id with the full local history + a '
      'fresh messageId, and only then completes', () async {
    final first = await service.sendTurn('c1', history: const [], userText: 'hi');
    final session = first.sessionId;
    final messageIds = <String>[];
    var calls = 0;
    respondWith = (request) {
      calls++;
      messageIds.add(request.turnId!);
      if (calls == 1) {
        // The single-message delta — the server (its session cache wiped by a
        // restart) silently re-seeded and ran context-free.
        return Future.value(
          ManagedTurnResult(
            sessionId: request.conversationPublicId!,
            state: 'seeded',
            result: const ChatResult(
              content: 'context-free reply',
              toolCalls: [],
              finishReason: 'stop',
            ),
          ),
        );
      }
      // The recovery re-establish: full local history under the SAME id.
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'seeded',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
      ],
      userText: 'second',
    );
    expect(calls, 2);
    expect(outcome.sessionId, session);
    expect(outcome.state, 'seeded');
    final bodies = client.requests.map((r) => r.toJson()).toList();
    // [0] first-turn establish; [1] the delta (answered seeded); [2] the
    // re-establish under the SAME session id with the FULL local history.
    expect(bodies, hasLength(3));
    expect(bodies[2]['session_id'], session);
    expect(
      (bodies[2]['messages'] as List).map((m) => m['content']),
      ['hi', 'local reply', 'second'],
    );
    // A fresh messageId was minted for the re-establish (the delta's was
    // replaced, so only two distinct ids exist across three sends).
    expect(messageIds.toSet(), hasLength(2));
    // The context-free reply was discarded — the store only ever sees 'ok'.
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.content, 'ok');
    expect(loaded.messages.any((m) => m.content == 'context-free reply'), isFalse);
    expect(await repo.pending(scope, 'c1'), isNull);
    expect(await repo.mappedSession('c1'), session);
  });

  test('a legitimate first-turn establish answered seeded completes normally '
      'with no recovery', () async {
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'first reply',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    final outcome = await service.sendTurn('c1', history: const [], userText: 'hi');
    expect(outcome.state, 'seeded');
    // Exactly one request: the empty-history establish (single message) is NOT
    // a delta, so a seeded response never triggers silent-reseed recovery.
    expect(client.requests, hasLength(1));
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.content, 'first reply');
  });

  test('silent-reseed recovery is bounded: a re-established seeded is a '
      'legitimate establish and never re-triggers recovery (no loop)',
      () async {
    final first = await service.sendTurn('c1', history: const [], userText: 'hi');
    var calls = 0;
    respondWith = (request) {
      calls++;
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'seeded',
          result: ChatResult(
            content: calls == 1 ? 'context-free reply' : 'ok',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'first reply'),
      ],
      userText: 'second',
    );
    // Establish + delta(seeded) + exactly ONE re-establish(seeded, legit) —
    // the re-established seeded must NOT recurse into another reseed.
    expect(client.requests, hasLength(3));
    expect(outcome.state, 'seeded');
    expect(outcome.sessionId, first.sessionId);
    expect(await repo.pending(scope, 'c1'), isNull);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.content, 'ok');
  });

  test('window filled: a mapped session COMPACTION re-establishes with the '
      'trimmed full history under the SAME session id (never mints a new one)',
      () async {
    service = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
      trimmer: const ContextTrimmer(maxTokens: 8),
    );
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    final first = await service.sendTurn('c1', history: const [], userText: 'hi');
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
      ],
      userText: 'a much longer follow-up that pushes the window over',
    );
    expect(outcome.sessionId, first.sessionId);
    expect(outcome.state, 'seeded');
    final body = client.requests.last.toJson();
    expect(body['session_id'], first.sessionId);
    final contents =
        (body['messages'] as List).map((m) => m['content']).toList();
    // The newest user message is present; trimmed-away older messages are not.
    expect(
      contents,
      contains('a much longer follow-up that pushes the window over'),
    );
    expect(contents, isNot(contains('local reply')));
    expect(contents, isNot(contains('hi')));
    // The mapping is unchanged — compaction never mints a fresh session id.
    expect(await repo.mappedSession('c1'), first.sessionId);
  });

  test('the newest user message survives the compaction establish even when it '
      'alone exceeds the budget', () async {
    service = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
      trimmer: const ContextTrimmer(maxTokens: 4),
    );
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await service.sendTurn('c1', history: const [], userText: 'hi');
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
      ],
      userText: 'this message alone exceeds the tiny four token budget',
    );
    expect(outcome.state, 'seeded');
    final contents = (client.requests.last.toJson()['messages'] as List)
        .map((m) => m['content'])
        .toList();
    expect(
      contents,
      ['this message alone exceeds the tiny four token budget'],
    );
  });

  test('session_missing recovery re-establishes with the TRIMMED full history '
      'under the same session id', () async {
    service = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
      trimmer: const ContextTrimmer(maxTokens: 8),
    );
    final first = await service.sendTurn('c1', history: const [], userText: 'hi');
    final session = first.sessionId;
    var calls = 0;
    respondWith = (request) {
      calls++;
      if (calls == 1) {
        throw const PluginClientException('session_missing', statusCode: 409);
      }
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'seeded',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final outcome = await service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
      ],
      userText: 'a much longer follow-up that pushes the window over',
    );
    expect(calls, 2);
    expect(outcome.sessionId, session);
    expect(outcome.state, 'seeded');
    // [0] first establish; [1] the compaction on the evicted session; [2] the
    // re-establish under the SAME session id with the TRIMMED local history.
    expect(client.requests, hasLength(3));
    final reestablish = client.requests.last.toJson();
    expect(reestablish['session_id'], session);
    expect(
      (reestablish['messages'] as List).map((m) => m['content']).toList(),
      ['a much longer follow-up that pushes the window over'],
    );
    expect(await repo.mappedSession('c1'), session);
  });

  test('retryTurn replays a compaction establish exactly (same trimmed '
      'messages, same messageId)', () async {
    service = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
      trimmer: const ContextTrimmer(maxTokens: 8),
    );
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await service.sendTurn('c1', history: const [], userText: 'hi');
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn(
        'c1',
        history: const [
          Message(id: 'm1', role: MessageRole.user, content: 'hi'),
          Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
        ],
        userText: 'a much longer follow-up that pushes the window over',
      ),
      throwsA(isA<ManagedTurnError>()),
    );
    final before = await repo.pending(scope, 'c1');
    final firstBody = client.requests.last.toJson();
    // The compaction establish was persisted as the trimmed single message.
    expect(
      (firstBody['messages'] as List).map((m) => m['content']).toList(),
      ['a much longer follow-up that pushes the window over'],
    );
    respondWith = (request) async => ManagedTurnResult(
      sessionId: request.conversationPublicId!,
      state: 'seeded',
      result: const ChatResult(
        content: 'ok',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await service.retryTurn('c1');
    final replay = client.requests.last.toJson();
    expect(replay['messages'], firstBody['messages']);
    expect(replay['session_id'], firstBody['session_id']);
    expect(replay['messageId'], firstBody['messageId']);
    expect(replay['messageId'], before!.messageId);
  });

  test('deleted-thread reseed clears the stale mapping + pending and the next '
      'send mints a fresh session retaining local history', () async {
    final first = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
    );
    final deadSession = first.sessionId;
    var calls = 0;
    respondWith = (request) {
      calls++;
      if (calls == 1) {
        throw const PluginClientException('reseed_required', statusCode: 409);
      }
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: calls == 1 ? 'seeded' : 'resumed',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    await expectLater(
      service.sendTurn(
        'c1',
        history: const [
          Message(id: 'm1', role: MessageRole.user, content: 'hi'),
          Message(
            id: 'm2',
            role: MessageRole.assistant,
            content: 'ok',
          ),
        ],
        userText: 'second',
      ),
      throwsA(
        isA<ManagedTurnError>().having((e) => e.code, 'code', 'reseed_required'),
      ),
    );

    // Stale mapping + pending dropped; local history retained.
    expect(await repo.mappedSession('c1'), isNull);
    expect(await repo.pending(scope, 'c1'), isNull);
    final retained = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(retained!.messages, hasLength(3));
    expect(retained.messages.last.content, 'second');

    // The next send seeds a brand-new session (full history).
    final reseeded = await service.sendTurn(
      'c1',
      history: retained.messages,
      userText: 'third',
    );
    expect(reseeded.sessionId, isNot(deadSession));
    expect(await repo.mappedSession('c1'), reseeded.sessionId);
  });

  test('submitBackground persists a background pending envelope, watches the '
      'ledger, and appends the reply on terminal succeeded', () async {
    final clock = FakeScheduler();
    var messageId = '';
    var polls = 0;
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        polls++;
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        expect(byKey, messageId,
            reason: 'the poll must use the submitted messageId');
        return jsonResponse(backgroundTaskJson(
          status: polls == 1 ? 'running' : 'succeeded',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      if (request.uri.path == '/ledger/tasks/task-1') {
        return jsonResponse({
          ...backgroundTaskJson(
            status: 'succeeded',
            messageId: messageId,
            taskId: 'task-1',
          ),
          'steps': [
            {
              'stage': 'reply',
              'action': 'assistant_message',
              'result': 'background reply',
            },
          ],
        });
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      enabledPlugins: const ['web'],
      poller: poller,
    );
    final handle = await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    final pending = (await repo.pending(scope, 'c1'))!;
    messageId = pending.messageId;
    final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
    expect(envelope['background'], isTrue);
    expect(envelope.containsKey('session_id'), isFalse);

    final request = client.requests.single;
    expect(request.background, isTrue);
    expect(request.conversationPublicId, isNull);
    expect(request.turnId, messageId);
    final body = request.toJson();
    expect(body['background'], isTrue);
    expect(body['messageId'], messageId);
    expect(body.containsKey('session_id'), isFalse);
    expect((body['messages'] as List).map((m) => m['content']), ['hi']);

    poller.setForeground(true);
    await clock.advance(const Duration(seconds: 1));
    expect((await handle.done).task?.status, LedgerTaskStatus.succeeded);
    await waitFor(() async => (await repo.pending(scope, 'c1')) == null);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages, hasLength(2));
    expect(loaded.messages.last.role, MessageRole.assistant);
    expect(loaded.messages.last.content, 'background reply');
  });

  test('submitBackground: a failed terminal surfaces and clears the pending '
      'marker without fabricating a reply', () async {
    final clock = FakeScheduler();
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        return jsonResponse(backgroundTaskJson(
          status: 'failed',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    final handle = await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    poller.setForeground(true);
    await clock.advance(Duration.zero);
    final result = await handle.done;
    expect(result.task?.status, LedgerTaskStatus.failed);
    await waitFor(() async => (await repo.pending(scope, 'c1')) == null);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages, hasLength(1));
    expect(loaded.messages.single.role, MessageRole.user);
  });

  test('background retry replays the same messageId with background: true',
      () async {
    client.respondBackground =
        (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.submitBackground('c1', history: const [], userText: 'hi'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'network_error'),
      ),
    );
    final pending = (await repo.pending(scope, 'c1'))!;
    final messageId = pending.messageId;
    final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
    expect(envelope['background'], isTrue);

    client.respondBackground = (_) async =>
        const BackgroundTurnResult(status: 'accepted', taskId: 'task-1');
    final outcome = await service.retryTurn('c1');
    expect(outcome, isA<ManagedBackgroundResubmitted>());
    final last = client.requests.last;
    expect(last.turnId, messageId);
    expect(last.conversationPublicId, isNull);
    expect(last.toJson()['background'], isTrue);
    expect(last.toJson()['messageId'], messageId);
    expect(await repo.pending(scope, 'c1'), isNotNull,
        reason: 'pending stays until the terminal poll');
  });

  test('background succeeded WITHOUT a stored reply keeps the pending marker '
      '(retryTurn still re-submits, no no_pending_turn)', () async {
    final clock = FakeScheduler();
    var messageId = '';
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        return jsonResponse(backgroundTaskJson(
          status: 'succeeded',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      if (request.uri.path == '/ledger/tasks/task-1') {
        // Full task WITHOUT a reply step — the job succeeded but stored none.
        return jsonResponse(backgroundTaskJson(
          status: 'succeeded',
          messageId: messageId,
          taskId: 'task-1',
        ));
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    final handle = await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    messageId = (await repo.pending(scope, 'c1'))!.messageId;
    poller.setForeground(true);
    await clock.advance(Duration.zero);
    expect((await handle.done).task?.status, LedgerTaskStatus.succeeded);
    // Wait for the async terminal handler to run its full-task read-back.
    await waitFor(
      () async => adapter.requests.any((r) => r.uri.path == '/ledger/tasks/task-1'),
    );
    await flush();
    expect(await repo.pending(scope, 'c1'), isNotNull,
        reason: 'a succeeded job with no stored reply keeps its retry identity');
    // The retry identity survives: an explicit retryTurn still re-submits.
    client.respondBackground = (_) async =>
        const BackgroundTurnResult(status: 'accepted', taskId: 'task-2');
    final outcome = await backgroundService.retryTurn('c1');
    expect(outcome, isA<ManagedBackgroundResubmitted>());
    expect(client.requests.last.turnId, messageId);
  });

  test('background retry replays the envelope model + plugins, never the new '
      'service instance config', () async {
    final serviceA = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      modelPluginId: 'model-a',
      enabledPlugins: const ['web'],
    );
    client.respondBackground =
        (_) => throw const PluginClientException('network_error');
    await expectLater(
      serviceA.submitBackground('c1', history: const [], userText: 'hi'),
      throwsA(isA<PluginClientException>()),
    );
    final messageId = (await repo.pending(scope, 'c1'))!.messageId;

    // A brand-new instance configured with model B must NOT leak into the retry.
    final serviceB = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      modelPluginId: 'model-b',
      enabledPlugins: const ['images'],
    );
    client.respondBackground = (_) async =>
        const BackgroundTurnResult(status: 'accepted', taskId: 'task-1');
    final outcome = await serviceB.retryTurn('c1');
    expect(outcome, isA<ManagedBackgroundResubmitted>());
    final last = client.requests.last;
    expect(last.turnId, messageId);
    expect(last.modelPluginId, 'model-a');
    expect(last.enabledPlugins, ['web']);
    expect(last.toJson()['model'], 'model-a');
    expect(last.toJson()['enabled_plugins'], ['web']);
  });

  test('request_too_large on an establish retries ONCE with image blocks '
      'pruned from all but the newest image-bearing message', () async {
    final session = 'session-1';
    final envelope = {
      'session_id': session,
      'model': 'openrouter',
      'enabledPlugins': <String>[],
      'messages': [
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': 'old image'},
            {
              'type': 'image_url',
              'image_url': {'url': 'data:image/png;base64,AAA'},
            },
          ],
        },
        {'role': 'assistant', 'content': 'between'},
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': 'new image'},
            {
              'type': 'image_url',
              'image_url': {'url': 'data:image/png;base64,BBB'},
            },
          ],
        },
      ],
    };
    await repo.savePending('c1', scope, 'msg-1', envelope);
    var calls = 0;
    respondWith = (request) {
      calls++;
      if (calls == 1) {
        throw const PluginClientException('request_too_large', statusCode: 413);
      }
      return Future.value(
        ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'seeded',
          result: const ChatResult(
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final outcome = await service.retryTurn('c1');
    expect(calls, 2, reason: 'exactly one bounded prune retry');
    expect(outcome.state, 'seeded');
    final retried = client.requests.last.toJson();
    final messages = (retried['messages'] as List).cast<Map<String, dynamic>>();
    expect(messages, hasLength(3));
    final older = messages[0]['content'] as List;
    final newest = messages[2]['content'] as List;
    expect(
      older.any((b) => (b as Map)['type'] == 'image_url'),
      isFalse,
      reason: 'the older image-bearing message lost its image blocks',
    );
    expect(
      older.any((b) => (b as Map)['type'] == 'text'),
      isTrue,
      reason: 'leading text is preserved',
    );
    expect(
      newest.any((b) => (b as Map)['type'] == 'image_url'),
      isTrue,
      reason: 'the newest image-bearing message keeps its image',
    );
    expect(await repo.pending(scope, 'c1'), isNull);
  });

  test('request_too_large on a text-only establish surfaces (nothing to prune) '
      'and a repeated 413 after pruning still surfaces', () async {
    await repo.savePending(
      'c1',
      scope,
      'msg-1',
      {
        'session_id': 'session-1',
        'model': 'openrouter',
        'enabledPlugins': <String>[],
        'messages': [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'local reply'},
          {'role': 'user', 'content': 'second'},
        ],
      },
    );
    respondWith = (_) => throw const PluginClientException(
      'request_too_large',
      statusCode: 413,
    );
    await expectLater(
      service.retryTurn('c1'),
      throwsA(
        isA<ManagedTurnError>().having(
          (e) => e.code,
          'code',
          'request_too_large',
        ),
      ),
    );
    // Text-only history: no image to prune, so a single dispatch — no retry.
    expect(client.requests, hasLength(1));
    expect(await repo.pending(scope, 'c1'), isNotNull,
        reason: 'the failed turn stays retryable');
  });

  test('logout racing the session_missing re-establish leaves no zombie '
      'pending row', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    final gate = Completer<void>();
    var calls = 0;
    respondWith = (request) {
      calls++;
      if (calls == 1) {
        // The delta — the evicted session answers 409 session_missing.
        throw const PluginClientException('session_missing', statusCode: 409);
      }
      // The recovery re-establish — held open until the logout has run.
      return gate.future.then(
        (_) => ManagedTurnResult(
          sessionId: request.conversationPublicId!,
          state: 'seeded',
          result: const ChatResult(
            content: 'late reply',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
    };
    final sent = service.sendTurn(
      'c1',
      history: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
        Message(id: 'm2', role: MessageRole.assistant, content: 'local reply'),
      ],
      userText: 'second',
    );
    // Wait until the recovery has dispatched the re-establish (its pending
    // row already written), then clear the scope while it is still in flight.
    while (client.requests.length < 3) {
      await Future<void>.delayed(Duration.zero);
    }
    final clearing = service.clearAccountData();
    gate.complete();
    await expectLater(sent, throwsA(isA<Exception>()));
    await clearing;
    expect(await db.select(db.managedPendingTurns).get(), isEmpty,
        reason: 'no zombie pending row may survive a logout racing the '
            're-establish');
    expect(await db.select(db.conversations).get(), isEmpty);
  });

  test('a second submitBackground on the SAME conversation is rejected, but '
      'two different conversations proceed independently', () async {
    final clock = FakeScheduler();
    final messageIds = <String, String>{};
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        final taskId = messageIds[byKey] ?? 'task-x';
        return jsonResponse(backgroundTaskJson(
          status: 'succeeded',
          messageId: byKey,
          taskId: taskId,
        ));
      }
      final taskId = request.uri.pathSegments.last;
      final messageId = messageIds.entries
          .firstWhere((entry) => entry.value == taskId)
          .key;
      return jsonResponse({
        ...backgroundTaskJson(
          status: 'succeeded',
          messageId: messageId,
          taskId: taskId,
        ),
        'steps': [
          {
            'stage': 'reply',
            'action': 'assistant_message',
            'result': taskId == 'task-a' ? 'reply-a' : 'reply-b',
          },
        ],
      });
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    final first = await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'first',
    );
    messageIds[(await repo.pending(scope, 'c1'))!.messageId] = 'task-a';

    // Same conversation: one pending turn per conversation.
    await expectLater(
      backgroundService.submitBackground('c1', history: const [], userText: 'dup'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'pending_turn_exists'),
      ),
    );

    // Different conversation: independent watch.
    final second = await backgroundService.submitBackground(
      'c2',
      history: const [],
      userText: 'second',
    );
    messageIds[(await repo.pending(scope, 'c2'))!.messageId] = 'task-b';

    poller.setForeground(true);
    await clock.advance(Duration.zero);
    expect((await first.done).task?.status, LedgerTaskStatus.succeeded);
    expect((await second.done).task?.status, LedgerTaskStatus.succeeded);
    await waitFor(() async =>
        (await repo.pending(scope, 'c1')) == null &&
        (await repo.pending(scope, 'c2')) == null);
    final c1 = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    final c2 = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c2'),
    );
    expect(c1!.messages.last.content, 'reply-a');
    expect(c2!.messages.last.content, 'reply-b');
    expect(c1.messages, isNot(contains(c2.messages.last)));
  });

  test('watchWithPush re-polls immediately when a completion push references '
      'the task', () async {
    final clock = FakeScheduler();
    var messageId = '';
    var polls = 0;
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        polls++;
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        return jsonResponse(backgroundTaskJson(
          status: polls == 1 ? 'running' : 'succeeded',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      if (request.uri.path == '/ledger/tasks/task-1') {
        return jsonResponse({
          ...backgroundTaskJson(
            status: 'succeeded',
            messageId: messageId,
            taskId: 'task-1',
          ),
          'steps': [
            {
              'stage': 'reply',
              'action': 'assistant_message',
              'result': 'push reply',
            },
          ],
        });
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    messageId = (await repo.pending(scope, 'c1'))!.messageId;

    final controller = StreamController<NotifMessage>.broadcast();
    final notif = FakeNotifClient();
    final subscription = backgroundService.watchWithPush(
      notif,
      'jobs',
      controller.stream,
      conversationId: 'c1',
      messageId: messageId,
      history: const [],
    );
    expect(notif.subscribed, ['jobs']);

    poller.setForeground(true);
    await clock.advance(Duration.zero);
    final before = adapter.requests.length;
    expect(before, 1, reason: 'the initial by-messageId poll ran');

    controller.add(
      const NotifMessage(
        topic: 'jobs',
        title: 'Job task-1',
        body: '{"status":"succeeded"}',
      ),
    );
    await clock.advance(Duration.zero);
    expect(
      adapter.requests.any((r) => r.uri.path == '/ledger/tasks/task-1'),
      isTrue,
      reason: 'the push must trigger an immediate full-task re-poll',
    );
    await waitFor(() async => (await repo.pending(scope, 'c1')) == null);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.content, 'push reply');

    await subscription.cancel();
    await controller.close();
  });

  test('foreground resume re-watches a still-pending background job after the '
      'original handle\'s deadline expired (exhausted handle misses nothing)',
      () async {
    final clock = FakeScheduler();
    var messageId = '';
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        return jsonResponse(backgroundTaskJson(
          status: 'succeeded',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      if (request.uri.path == '/ledger/tasks/task-1') {
        return jsonResponse({
          ...backgroundTaskJson(
            status: 'succeeded',
            messageId: messageId,
            taskId: 'task-1',
          ),
          'steps': [
            {
              'stage': 'reply',
              'action': 'assistant_message',
              'result': 'bg reply',
            },
          ],
        });
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    messageId = (await repo.pending(scope, 'c1'))!.messageId;

    // Backgrounded past the handle's fixed deadline (maxElapsed = 30s): a
    // suspended app runs no timers, so the deadline elapses unseen.
    poller.setForeground(false);
    await clock.advance(const Duration(seconds: 31));
    expect(adapter.requests, isEmpty,
        reason: 'no polls may run while the app is backgrounded');

    // Resume: re-arm the poller, then re-watch with a FRESH handle (the old
    // one would finish `exhausted` with zero polls).
    poller.setForeground(true);
    final fresh = await backgroundService.rewatchPendingBackground('c1');
    expect(fresh, isNotNull);
    await clock.advance(const Duration(seconds: 1));
    final result = await fresh!.done;
    expect(result.end, LedgerPollEnd.observed,
        reason: 'the fresh watch must observe the terminal task, not expire');
    expect(result.task?.status, LedgerTaskStatus.succeeded);
    await waitFor(() async => (await repo.pending(scope, 'c1')) == null);
    final loaded = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(loaded!.messages.last.role, MessageRole.assistant);
    expect(loaded.messages.last.content, 'bg reply');
  });

  test('foreground-gated polling: a submitted job does not poll until the '
      'lifecycle path arms it, then completes on setForeground(true)',
      () async {
    final clock = FakeScheduler();
    var messageId = '';
    final adapter = FakeAdapter((request) {
      if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
        final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
        return jsonResponse(backgroundTaskJson(
          status: 'succeeded',
          messageId: byKey,
          taskId: 'task-1',
        ));
      }
      if (request.uri.path == '/ledger/tasks/task-1') {
        return jsonResponse({
          ...backgroundTaskJson(
            status: 'succeeded',
            messageId: messageId,
            taskId: 'task-1',
          ),
          'steps': [
            {
              'stage': 'reply',
              'action': 'assistant_message',
              'result': 'bg reply',
            },
          ],
        });
      }
      throw StateError('unexpected ledger path ${request.uri.path}');
    });
    final poller = testPoller(scope, adapter, clock);
    final backgroundService = ManagedConversationService(
      client: client,
      repo: repo,
      scope: scope,
      credentials: () async => ManagedCredentials(gatewayKey: gatewayKey),
      poller: poller,
    );
    final handle = await backgroundService.submitBackground(
      'c1',
      history: const [],
      userText: 'hi',
    );
    messageId = (await repo.pending(scope, 'c1'))!.messageId;

    // Backgrounded: advance well past initialDelay — no timer runs, no poll.
    await clock.advance(const Duration(seconds: 5));
    expect(adapter.requests, isEmpty,
        reason: 'the poller must refuse to poll while suspended');

    // The lifecycle observer arms the poller on resume; the handle polls.
    poller.setForeground(true);
    await clock.advance(const Duration(seconds: 1));
    expect(adapter.requests, isNotEmpty,
        reason: 'setForeground(true) from the lifecycle path arms the handle');
    expect((await handle.done).task?.status, LedgerTaskStatus.succeeded);
    await waitFor(() async => (await repo.pending(scope, 'c1')) == null);
  });

  group('P1c: abandonTurn', () {
    Future<void> admitHangingTurn({
      required Completer<ManagedTurnResult> gate,
      String conversationId = 'c1',
      String userText = 'hi',
    }) async {
      respondWith = (request) => gate.future;
      final sent = service.sendTurn(
        conversationId,
        history: const [],
        userText: userText,
      );
      while ((await repo.pending(scope, conversationId)) == null) {
        await Future<void>.delayed(Duration.zero);
      }
      // Keep the unawaited send from tripping the test's unhandled-error
      // zone when the gate later completes with a cancellation.
      sent.ignore();
    }

    test('abandonTurn mid-dispatch cancels the token, clears pending, and '
        'persists the partial so the next send is immediately sendable',
        () async {
      final gate = Completer<ManagedTurnResult>();
      await admitHangingTurn(gate: gate);
      // Mid-flight first turn: the server has the user message but no reply
      // yet — abandon must take the partial-retention path, not reconcile.
      client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
        'sessionId': sessionId,
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
      });
      final dispatched = client.cancelTokens.single;
      expect(dispatched!.isCancelled, isFalse);

      await service.abandonTurn('c1', partialText: 'partial ');

      expect(dispatched.isCancelled, isTrue,
          reason: 'abandon cancels exactly this turn\'s dispatch token');
      expect(await repo.pending(scope, 'c1'), isNull);
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(loaded!.messages, hasLength(2));
      expect(loaded.messages.last.role, MessageRole.assistant);
      expect(loaded.messages.last.content, 'partial ');

      // (b) a delta right after abandon is sendable — no pending_turn_exists.
      respondWith = (request) async => ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: 'resumed',
        result: const ChatResult(
          content: 'next',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      final next = await service.sendTurn(
        'c1',
        history: loaded.messages,
        userText: 'second',
      );
      expect(next.state, 'resumed');
      expect(await repo.pending(scope, 'c1'), isNull);
    });

    test('abandonTurn with no pending row is a no-op', () async {
      await service.abandonTurn('c1', partialText: 'ignored');
      expect(client.cancelTokens, isEmpty);
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(loaded, isNull);
    });

    test('abandonTurn with empty partial clears pending without writing an '
        'assistant row', () async {
      final gate = Completer<ManagedTurnResult>();
      await admitHangingTurn(gate: gate);
      // No server reply yet → partial path (with empty partial: clear only).
      client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
        'sessionId': sessionId,
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
      });
      await service.abandonTurn('c1');
      expect(await repo.pending(scope, 'c1'), isNull);
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(loaded!.messages, hasLength(1));
      expect(loaded.messages.single.role, MessageRole.user);
    });

    test('abandonTurn when the server holds a terminal assistant turn '
        'reconciles instead of persisting the partial', () async {
      final gate = Completer<ManagedTurnResult>();
      await admitHangingTurn(gate: gate);
      final session = await repo.mappedSession('c1');
      client.historyBuilder = (sessionId) => ManagedSessionHistory.fromJson({
        'sessionId': sessionId,
        'messages': [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'full server reply'},
        ],
      });

      await service.abandonTurn('c1', partialText: 'partial ');

      expect(client.sessionLoads, [session]);
      expect(await repo.pending(scope, 'c1'), isNull);
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(loaded!.messages, hasLength(2));
      expect(loaded.messages.last.content, 'full server reply');
      expect(
        loaded.messages.any((m) => m.content == 'partial '),
        isFalse,
        reason: 'the server\'s terminal reply replaces the local partial');
    });

    test('abandonTurn when the server fetch fails falls back to the '
        'partial-clear path (pending cleared, partial persisted)', () async {
      final gate = Completer<ManagedTurnResult>();
      await admitHangingTurn(gate: gate);
      // Default server history is terminal ([user, assistant]); make the
      // loadSession fail so the fallback runs.
      client.loadSessionError = const PluginClientException('network_error');

      await service.abandonTurn('c1', partialText: 'partial ');

      expect(await repo.pending(scope, 'c1'), isNull);
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(loaded!.messages, hasLength(2));
      expect(loaded.messages.last.content, 'partial ');
    });

    test('a late completion after abandon surfaces cancelled and never '
        'persists the assistant reply', () async {
      final gate = Completer<ManagedTurnResult>();
      // Route dispatch through the gate BEFORE the send starts — otherwise
      // the default responder can finish the turn and clear pending before
      // the wait loop ever observes it (spinning forever).
      respondWith = (request) => gate.future;
      final sent = service.sendTurn('c1', history: const [], userText: 'hi');
      while ((await repo.pending(scope, 'c1')) == null) {
        await Future<void>.delayed(Duration.zero);
      }
      // Abandon while the dispatch is still awaiting the gate.
      await service.abandonTurn('c1');
      gate.complete(
        ManagedTurnResult(
          sessionId: request0Session(client),
          state: 'seeded',
          result: const ChatResult(
            content: 'late reply',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
      await expectLater(
        sent,
        throwsA(
          isA<ManagedTurnError>().having((e) => e.code, 'code', 'cancelled'),
        ),
      );
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      expect(
        loaded!.messages.any((m) => m.content == 'late reply'),
        isFalse,
        reason: 'a completion after abandon must not persist');
      expect(await repo.pending(scope, 'c1'), isNull);
    });
  });

  group('P1b: service-minted user-message id', () {
    test('sendTurn outcome.userMessageId matches the persisted trailing user '
        'row', () async {
      final outcome = await service.sendTurn(
        'c1',
        history: const [],
        userText: 'hi',
      );
      final loaded = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) => store.loadConversation('c1'),
      );
      final users = loaded!.messages.where(
        (m) => m.role == MessageRole.user,
      );
      expect(users, hasLength(1));
      expect(outcome.userMessageId, users.single.id);
      expect(outcome.userMessageId, isNotEmpty);
    });

    test('the persisted envelope carries userMessageId; the failure '
        'ManagedTurnError and a later retryTurn both reuse it', () async {
      respondWith = (_) => throw const PluginClientException('network_error');
      Object? thrown;
      try {
        await service.sendTurn('c1', history: const [], userText: 'hi');
      } catch (e) {
        thrown = e;
      }
      expect(thrown, isA<ManagedTurnError>());
      final failure = thrown! as ManagedTurnError;
      final pending = (await repo.pending(scope, 'c1'))!;
      final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
      expect(envelope['userMessageId'], isA<String>());
      final admittedId = envelope['userMessageId'] as String;
      expect(admittedId, isNotEmpty);
      // The post-admission failure surfaces the SAME id the envelope stored.
      expect(failure.userMessageId, admittedId);

      respondWith = (request) async => ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: 'resumed',
        result: const ChatResult(
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      final outcome = await service.retryTurn('c1');
      expect(outcome.userMessageId, admittedId,
          reason: 'retry replays the envelope id, never re-mints');
    });

    test('a pre-P1b envelope without userMessageId derives the trailing user '
        'row id on retryTurn', () async {
      respondWith = (_) => throw const PluginClientException('network_error');
      await expectLater(
        service.sendTurn('c1', history: const [], userText: 'hi'),
        throwsA(isA<ManagedTurnError>()),
      );
      final pending = (await repo.pending(scope, 'c1'))!;
      final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
      final admittedId = envelope.remove('userMessageId');
      expect(admittedId, isA<String>(),
          reason: 'this test starts from a real envelope, then strips the '
              'key to simulate a pre-P1b mint');
      await repo.savePending('c1', scope, pending.messageId, envelope);
      final rewritten =
          jsonDecode((await repo.pending(scope, 'c1'))!.envelope)
              as Map<String, dynamic>;
      expect(rewritten.containsKey('userMessageId'), isFalse);

      respondWith = (request) async => ManagedTurnResult(
        sessionId: request.conversationPublicId!,
        state: 'resumed',
        result: const ChatResult(
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      final outcome = await service.retryTurn('c1');
      expect(outcome.userMessageId, admittedId,
          reason: 'derived from the conversation trailing user row');
    });

    test('submitBackground persists userMessageId and a background '
        'retryTurn surfaces it on ManagedBackgroundResubmitted', () async {
      client.respondBackground =
          (_) => throw const PluginClientException('network_error');
      await expectLater(
        service.submitBackground('c1', history: const [], userText: 'hi'),
        throwsA(isA<PluginClientException>()),
      );
      final pending = (await repo.pending(scope, 'c1'))!;
      final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
      final admittedId = envelope['userMessageId'] as String;
      expect(admittedId, isNotEmpty);

      client.respondBackground = (_) async =>
          const BackgroundTurnResult(status: 'accepted', taskId: 'task-1');
      final outcome = await service.retryTurn('c1');
      expect(outcome, isA<ManagedBackgroundResubmitted>());
      expect(outcome.userMessageId, admittedId);
    });
  });
}