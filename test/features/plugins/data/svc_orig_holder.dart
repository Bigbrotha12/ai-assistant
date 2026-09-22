import 'dart:async';
import 'dart:convert';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/data/sse.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/langchain_request.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_dto.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeLangChainClient implements LangChainClient {
  FakeLangChainClient(this.respond);

  final Future<ManagedTurnResult> Function(LangChainRequest) respond;
  final requests = <LangChainRequest>[];
  final sessionLoads = <String>[];
  final deletedSessions = <({String sessionId, String gatewayKey})>[];
  Object? loadSessionError;

  /// When set, returns this scripted session for [loadSession] instead of
  /// the default fixed history.
  ManagedSessionHistory Function(String sessionId)? historyBuilder;

  @override
  Future<ManagedTurnResult> managedTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function(String text)? onContent,
  }) async {
    requests.add(request);
    return respond(request);
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
  Future<BackgroundTurnResult> backgroundTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
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

void main() {
  late AppDatabase db;
  late ManagedConversationRepository repo;
  late FakeLangChainClient client;
  late ManagedConversationService service;
  late AuthAccountScope scope;
  var gatewayKey = 'gateway-secret';
  var turns = 0;
  var respondWith = (LangChainRequest request) async {
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

  setUp(() {
    turns = 0;
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
    expect(bodies[0]['session_id'], session);
    expect((bodies[0]['messages'] as List).map((m) => m['content']), ['second']);
    expect(bodies[1]['session_id'], session);
    expect(
      (bodies[1]['messages'] as List).map((m) => m['content']),
      ['hi', 'local reply', 'second'],
    );
    expect(messageIds.toSet(), hasLength(2));
    expect(await repo.pending(scope, 'c1'), isNull);
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
    expect(client.requests, hasLength(2));
    expect(await repo.mappedSession('c1'), isNotNull);
    expect(await repo.pending(scope, 'c1'), isNotNull);
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

    final reseeded = await service.sendTurn(
      'c1',
      history: retained.messages,
      userText: 'third',
    );
    expect(reseeded.sessionId, isNot(deadSession));
    expect(reseeded.state, 'seeded');
    expect(await repo.mappedSession('c1'), reseeded.sessionId);
  });
}