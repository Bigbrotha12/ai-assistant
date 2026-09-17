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
  final threadLoads = <String>[];
  final deletedThreads = <String>[];
  Object? loadThreadError;

  /// When set, returns this scripted checkpoint for [loadThread] instead of
  /// the default fixed history.
  ManagedThreadHistory Function(String threadId)? historyBuilder;

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
  Future<ManagedThreadHistory> loadThread(
    String threadId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    if (loadThreadError != null) throw loadThreadError!;
    threadLoads.add(threadId);
    final builder = historyBuilder;
    if (builder != null) return builder(threadId);
    return ManagedThreadHistory.fromJson({
      'threadId': threadId,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'from server'},
      ],
    });
  }

  @override
  Future<List<ManagedThreadSummary>> listThreads({
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    return [
      ManagedThreadSummary.fromJson({'threadId': 'pub-1', 'messageCount': 3}),
    ];
  }

  @override
  Future<void> deleteThread(
    String threadId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) async {
    deletedThreads.add(threadId);
  }
}

void main() {
  late AppDatabase db;
  late ManagedConversationRepository repo;
  late FakeLangChainClient client;  late ManagedConversationService service;
  late AuthAccountScope scope;
  var gatewayKey = 'gateway-secret';
  var turns = 0;
  late Future<ManagedTurnResult> Function(LangChainRequest) respondWith;

  setUp(() {
    turns = 0;
    respondWith = (request) async {
      turns++;
      return ManagedTurnResult(
        threadId: request.conversationPublicId!,
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
      'client-minted thread id', () async {
    final outcome = await service.sendTurn(
      'c1',
      history: const [],
      userText: 'hi',
    );
    expect(outcome.threadId, isNotEmpty);
    expect(outcome.state, 'seeded');
    expect(client.requests.single.turnId, isNotNull);
    expect(client.requests.single.conversationPublicId, outcome.threadId);
    expect(client.requests.single.toJson()['conversation_mode'], 'managed');
    expect(client.requests.single.toJson()['enabled_plugins'], ['web']);
    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNull);
    final mapped = await repo.mappedThread('c1');
    expect(mapped, outcome.threadId);
  });

  test(
    'resume turn reuses the mapped thread and carries the user message',
    () async {
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
      expect(outcome.threadId, first.threadId);
      expect(outcome.state, 'resumed');
      final last = client.requests.last;
      expect(last.messages.last.role, 'user');
      expect(last.messages.last.content, 'second');
    },
  );

  test('duplicate inflight 409 throws ManagedTurnError with thread id, keeps '
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
    final thread = await repo.mappedThread('c1');

    respondWith = (request) async => ManagedTurnResult(
      threadId: thread!,
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
    expect(client.requests.last.conversationPublicId, thread);
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
    final thread = await repo.mappedThread('c1');
    respondWith = (request) async => ManagedTurnResult(
      threadId: thread!,
      state: 'resumed',
      taskId: 'task-1',
    );
    final outcome = await service.retryTurn('c1');
    expect(outcome, isA<ManagedAlreadyCompleted>());
    expect((outcome as ManagedAlreadyCompleted).taskId, 'task-1');
    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNull);
  });

  test('retryTurn re-sends the EXACT same envelope (messageId, thread, '
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
      threadId: request.conversationPublicId!,
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
    expect(secondRequest.conversationPublicId, firstBody['thread_id']);
    final secondBody = secondRequest.toJson();
    expect(secondBody['messages'], firstBody['messages']);
    expect(secondBody['thread_id'], firstBody['thread_id']);
    expect(secondBody['messageId'], firstBody['messageId']);
  });

  test('reconcileFromServer replaces local history from the checkpoint without '
      'inference', () async {
    await service.sendTurn('c1', history: const [], userText: 'hi');
    final thread = await repo.mappedThread('c1');
    final messages = await service.reconcileFromServer('c1');
    expect(client.threadLoads, [thread]);
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
    client.loadThreadError = const PluginClientException(
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
      expect(await repo.mappedThread('c1'), isNotNull);
      expect(await repo.mappedThread('c2'), isNotNull);
    },
  );

  test('clearAccountData cancels in-flight writes and prevents late history '
      'repopulation', () async {
    final sent = service.sendTurn('c1', history: const [], userText: 'hi');
    // Simulate a scope clear while the send is awaiting the response.
    respondWith = (request) async {
      await service.clearAccountData();
      return ManagedTurnResult(
        threadId: request.conversationPublicId!,
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

  test('listThreads and deleteThread pass the gateway key through', () async {
    final threads = await service.listThreads();
    expect(threads.single.threadId, 'pub-1');
    expect(threads.single.messageCount, 3);
    await service.deleteThread('pub-1');
    expect(client.deletedThreads, ['pub-1']);
  });

  test('reconciliation persists distinct stable message ids and keeps tool '
      'linkage (no row collapse, no cross-conversation bleed)', () async {
    client.historyBuilder = (threadId) => ManagedThreadHistory.fromJson({
      'threadId': threadId,
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

    // A second thread's reconciliation never shares rows with this one.
    final other = ManagedThreadHistory.fromJson({
      'threadId': 'thread-other',
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
        threadId: request.conversationPublicId!,
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
    var dispatchedThread = '';
    final gate = Completer<ManagedTurnResult>();
    respondWith = (request) {
      dispatchedThread = request.conversationPublicId!;
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
        threadId: dispatchedThread,
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

  test('already_completed reconciles server history and surfaces a failed task '
      'status without fabricating an assistant reply', () async {
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final thread = await repo.mappedThread('c1');
    client.historyBuilder = (id) => ManagedThreadHistory.fromJson({
      'threadId': id,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'checkpoint reply'},
      ],
    });
    respondWith = (request) async => ManagedTurnResult(
      threadId: thread!,
      state: 'resumed',
      taskId: 'task-1',
      terminalStatus: parseManagedTerminalStatus('failed'),
    );
    final outcome = await service.retryTurn('c1');
    expect(outcome, isA<ManagedAlreadyCompleted>());
    final completed = outcome as ManagedAlreadyCompleted;
    expect(completed.taskId, 'task-1');
    expect(completed.taskStatus, ManagedTerminalStatus.failed);
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

  test('a mid-reconcile failure persists a reconcileOnly marker carrying the '
      'terminal status; retry is refused and explicit reconcile completes it',
      () async {
    respondWith = (_) => throw const PluginClientException('network_error');
    await expectLater(
      service.sendTurn('c1', history: const [], userText: 'hi'),
      throwsA(isA<ManagedTurnError>()),
    );
    final thread = await repo.mappedThread('c1');
    client.loadThreadError = const PluginClientException('network_error');
    respondWith = (request) async => ManagedTurnResult(
      threadId: thread!,
      state: 'resumed',
      taskId: 'task-1',
      terminalStatus: parseManagedTerminalStatus('failed'),
    );
    await expectLater(service.retryTurn('c1'), throwsA(isA<PluginClientException>()));

    final pending = await repo.pending(scope, 'c1');
    expect(pending, isNotNull);
    expect(pending!.reconcileOnly, isTrue);
    final envelope = jsonDecode(pending.envelope) as Map<String, dynamic>;
    expect(envelope['taskId'], 'task-1');
    expect(envelope['terminalStatus'], 'failed');

    // Inference replay of an already-reconciled turn is explicit, not silent.
    await expectLater(
      service.retryTurn('c1'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'reconcile_required'),
      ),
    );

    client.loadThreadError = null;
    client.historyBuilder = (id) => ManagedThreadHistory.fromJson({
      'threadId': id,
      'messages': [
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'checkpoint reply'},
      ],
    });
    final history = await service.reconcileFromServer('c1');
    expect(history, hasLength(2));
    expect(await repo.pending(scope, 'c1'), isNull);
    expect(await repo.mappedThread('c1'), thread);
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
      threadId: request.conversationPublicId!,
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

  test('deleted-thread reseed clears the stale mapping + pending and the next '
      'send mints a fresh thread retaining local history', () async {
    final first = await service.sendTurn('c1', history: const [], userText: 'hi');
    final deadThread = first.threadId;
    var calls = 0;
    respondWith = (request) {
      calls++;
      if (calls == 1) {
        throw const PluginClientException('reseed_required', statusCode: 409);
      }
      return Future.value(
        ManagedTurnResult(
          threadId: request.conversationPublicId!,
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
    expect(await repo.mappedThread('c1'), isNull);
    expect(await repo.pending(scope, 'c1'), isNull);
    final retained = await repo.access(
      scope,
      repo.epoch(scope),
      () {},
      (store) => store.loadConversation('c1'),
    );
    expect(retained!.messages, hasLength(3));
    expect(retained.messages.last.content, 'second');

    // The next send seeds a brand-new thread.
    final reseeded = await service.sendTurn(
      'c1',
      history: retained.messages,
      userText: 'third',
    );
    expect(reseeded.threadId, isNot(deadThread));
    expect(await repo.mappedThread('c1'), reseeded.threadId);
  });
}
