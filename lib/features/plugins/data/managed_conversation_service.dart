import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/data/message_model.dart';
import 'langchain_client.dart';
import 'langchain_request.dart';
import 'managed_conversation_dto.dart';
import 'managed_conversation_repository.dart';
import 'plugin_http.dart';

/// Gateway + provider credentials for one dispatch. Resolved fresh on every
/// send/retry so a revoked key never rides inside a persisted envelope.
class ManagedCredentials {
  const ManagedCredentials({
    required this.gatewayKey,
    this.provider = const {},
  });

  final String gatewayKey;
  final Map<String, Map<String, String>> provider;
}

typedef CredentialResolver = Future<ManagedCredentials?> Function();

/// Outcome of one staged managed turn.
sealed class ManagedTurnOutcome {
  const ManagedTurnOutcome(this.threadId, this.state);

  /// Raw public thread id the server named (equals the client-minted id).
  final String threadId;

  /// 'seeded' | 'resumed' | 'recreated'.
  final String state;
}

class ManagedStreamedTurn extends ManagedTurnOutcome {
  const ManagedStreamedTurn(super.threadId, super.state, this.result);

  final ChatResult result;
}

/// `200 already_completed` — the retried send hit a turn that already ran.
/// No fresh inference happened; the service reconciles history from the server
/// checkpoint as part of handling this outcome. [taskStatus] preserves whether
/// the underlying task actually succeeded, failed, or was cancelled.
class ManagedAlreadyCompleted extends ManagedTurnOutcome {
  const ManagedAlreadyCompleted(
    super.threadId,
    super.state,
    this.taskId, [
    this.taskStatus = ManagedTerminalStatus.unknown,
  ]);

  final String taskId;
  final ManagedTerminalStatus taskStatus;
}

/// Failure that keeps the server thread id reachable for the caller.
class ManagedTurnError extends PluginClientException {
  const ManagedTurnError(super.code, {super.statusCode, this.threadId});

  final String? threadId;
}

/// Injectable staged managed-chat service. Owns the per-send idempotency
/// lifecycle: messageId minted once, pending row persisted BEFORE dispatch,
/// explicit-only retries with the exact same envelope, server-side duplicate
/// handling (409 in-flight / 200 already-completed), and history
/// reconciliation without a second inference. Never executes tools itself.
///
/// All local writes are account-scoped via [ManagedConversationRepository] and
/// become no-ops (throw 'cancelled') after [clearAccountData] or any later
/// scope-cancellation, so late stream completions cannot repopulate cleared
/// data.
class ManagedConversationService {
  ManagedConversationService({
    required this.client,
    required this.repo,
    required this.scope,
    required this.credentials,
    this.modelPluginId = 'openrouter',
    this.enabledPlugins = const [],
  });

  final LangChainClient client;
  final ManagedConversationRepository repo;
  final AuthAccountScope scope;
  final CredentialResolver credentials;
  final String modelPluginId;
  final List<String> enabledPlugins;

  /// Sends one user turn into the managed conversation. [history] is the
  /// local conversation so far (the server seeds from it when the thread is
  /// new and ignores it on resume).
  ///
  /// Admission is atomic: the unresolved-turn check, the conversation
  /// creation/append, the thread mapping, and the pending-row persistence all
  /// run inside one scope-checked repository transaction, so a logout racing
  /// the send can never leave a pending row behind after its clear.
  Future<ManagedTurnOutcome> sendTurn(
    String conversationId, {
    required List<Message> history,
    required String userText,
    String? threadId,
  }) async {
    final epoch = repo.epoch(scope);
    final userMessage = Message(
      id: const Uuid().v4(),
      role: MessageRole.user,
      content: userText,
    );
    final localHistory = [...history, userMessage];
    final messages = toApiMessages(localHistory);
    final prepared = await repo.access(scope, epoch, () {}, (store) async {
      // One unresolved turn per scoped conversation: a second send would
      // replace the previous pending row and destroy its retry identity.
      if (await repo.pending(scope, conversationId) != null) {
        throw const PluginClientException('pending_turn_exists');
      }
      final now = DateTime.now();
      final current = await store.loadConversation(conversationId);
      if (current == null) {
        await store.saveConversation(
          Conversation(
            id: conversationId,
            title: _title(localHistory),
            messages: localHistory,
            createdAt: now,
            updatedAt: now,
          ),
        );
      } else {
        await store.appendMessage(conversationId, userMessage);
      }
      final existing = threadId ?? await repo.mappedThread(conversationId);
      final effectiveThread = existing ?? const Uuid().v4();
      await repo.mapThread(conversationId, effectiveThread);
      final messageId = const Uuid().v4();
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _envelope(
          messageId: messageId,
          threadId: effectiveThread,
          messages: messages,
        ),
      );
      return (threadId: effectiveThread, messageId: messageId);
    });
    return _dispatch(
      conversationId,
      epoch,
      threadId: prepared.threadId,
      messageId: prepared.messageId,
      messages: messages,
      history: localHistory,
      modelPluginId: modelPluginId,
      enabledPlugins: enabledPlugins,
    );
  }

  /// Explicit retry of the last staged turn: same messageId, same thread, and
  /// the SAME persisted execution config (model + enabled plugins). Only the
  /// credentials are re-resolved — a turn is never replayed against whatever
  /// the current service instance happens to be configured with. A corrupted or
  /// incomplete envelope surfaces `invalid_config`; an already-reconciled turn
  /// surfaces `reconcile_required` (retry is not a send).
  Future<ManagedTurnOutcome> retryTurn(String conversationId) async {
    final epoch = repo.epoch(scope);
    final pending = await repo.pending(scope, conversationId);
    if (pending == null) {
      throw const PluginClientException('no_pending_turn');
    }
    if (pending.reconcileOnly) {
      throw const PluginClientException('reconcile_required');
    }
    final resumed = _decodeEnvelope(pending.envelope);
    return _dispatch(
      conversationId,
      epoch,
      threadId: resumed.threadId,
      messageId: pending.messageId,
      messages: resumed.messages,
      history: _historyFromApi(resumed.messages),
      modelPluginId: resumed.modelPluginId,
      enabledPlugins: resumed.enabledPlugins,
    );
  }

  Future<ManagedTurnOutcome> _dispatch(
    String conversationId,
    int epoch, {
    required String threadId,
    required String messageId,
    required List<ApiMessage> messages,
    required List<Message> history,
    required String modelPluginId,
    required List<String> enabledPlugins,
  }) async {
    _checkEpoch(epoch);
    final resolved = await credentials();
    if (resolved == null) {
      throw const PluginClientException('missing_gateway_key');
    }
    _checkEpoch(epoch);
    final request = LangChainRequest(
      gatewayKey: resolved.gatewayKey,
      modelPluginId: modelPluginId,
      credentials: resolved.provider,
      messages: messages,
      conversationPublicId: threadId,
      turnId: messageId,
      managed: true,
      enabledPlugins: enabledPlugins,
    );
    final token = repo.register(scope);
    try {
      final streamed = await client.managedTurn(request, cancelToken: token);
      _checkEpoch(epoch);
      if (streamed.result != null) {
        final outcome = ManagedStreamedTurn(
          streamed.threadId,
          streamed.state,
          streamed.result!,
        );
        await _completeTurn(
          conversationId,
          epoch: epoch,
          messageId: messageId,
          history: history,
          outcome: outcome,
        );
        return outcome;
      }
      final outcome = ManagedAlreadyCompleted(
        streamed.threadId,
        streamed.state,
        streamed.taskId ?? '',
        streamed.terminalStatus,
      );
      await _reconcileAlreadyCompleted(
        conversationId,
        epoch: epoch,
        messageId: messageId,
        threadId: streamed.threadId,
        gatewayKey: resolved.gatewayKey,
        outcome: outcome,
      );
      return outcome;
    } on PluginClientException catch (error) {
      if (error.code == 'reseed_required') {
        await _dropStaleThread(
          conversationId,
          threadId: threadId,
          messageId: messageId,
        );
      }
      throw ManagedTurnError(
        error.code,
        statusCode: error.statusCode,
        threadId: threadId,
      );
    } finally {
      repo.unregister(scope, token);
    }
  }

  Future<void> _completeTurn(
    String conversationId, {
    required int epoch,
    required String messageId,
    required List<Message> history,
    required ManagedTurnOutcome outcome,
  }) async {
    await repo.access(scope, epoch, () {}, (store) async {
      final current = await store.loadConversation(conversationId);
      final reply = outcome is ManagedStreamedTurn ? outcome.result : null;
      final assistant = Message(
        id: const Uuid().v4(),
        role: MessageRole.assistant,
        content: reply?.content ?? '',
        toolCalls: reply?.toolCalls,
      );
      final now = DateTime.now();
      if (current == null) {
        await store.saveConversation(
          Conversation(
            id: conversationId,
            title: _title(history),
            messages: [...history, assistant],
            createdAt: now,
            updatedAt: now,
          ),
        );
      } else {
        await store.updateMessage(conversationId, assistant);
      }
      await repo.clearPending(scope, conversationId, messageId: messageId);
    });
  }

  /// `200 already_completed`: no fresh inference happened and the assistant
  /// reply must NOT be fabricated locally. Instead:
  ///   1. persist a reconcile-only marker (so a mid-reconcile failure is
  ///      explicit and retryable),
  ///   2. fetch the server checkpoint,
  ///   3. commit it over local history, and
  ///   4. clear the marker (compare-and-delete on the turn's messageId).
  /// The returned outcome carries the task's terminal status so a failed or
  /// cancelled task is surfaced explicitly rather than masquerading as a reply.
  Future<void> _reconcileAlreadyCompleted(
    String conversationId, {
    required int epoch,
    required String messageId,
    required String threadId,
    required String gatewayKey,
    required ManagedAlreadyCompleted outcome,
  }) async {
    await repo.access(scope, epoch, () {}, (store) async {
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _reconcileEnvelope(threadId: threadId, outcome: outcome),
        reconcileOnly: true,
      );
    });
    final history = await client.loadThread(threadId, gatewayKey: gatewayKey);
    _checkEpoch(epoch);
    await repo.access(scope, epoch, () {}, (store) async {
      final previous = await store.loadConversation(conversationId);
      final now = DateTime.now();
      if (previous == null) {
        await store.saveConversation(
          Conversation(
            id: conversationId,
            title: _title(history.messages),
            messages: List.of(history.messages),
            createdAt: now,
            updatedAt: now,
          ),
        );
        await repo.mapThread(conversationId, threadId);
      } else {
        await repo.replaceHistory(
          scope,
          store,
          previous,
          threadId,
          history.messages,
          expectedMessageId: messageId,
        );
      }
      await repo.clearPending(scope, conversationId, messageId: messageId);
    });
  }

  /// Replaces local history with the server checkpoint for the conversation's
  /// mapped thread. No inference happens here. A reconciliation marker is
  /// persisted before the fetch so a failure leaves an explicit, retryable
  /// state, and the marker is cleared only after the history is committed. A
  /// `409 reseed_required` (mapped thread deleted server-side) clears the stale
  /// mapping and marker so the next send mints a fresh thread while local
  /// history is retained.
  Future<List<Message>> reconcileFromServer(String conversationId) async {
    final epoch = repo.epoch(scope);
    final threadId = await repo.mappedThread(conversationId);
    if (threadId == null) {
      throw const PluginClientException('no_pending_turn');
    }
    final messageId = (await repo.pending(scope, conversationId))?.messageId ??
        const Uuid().v4();
    await repo.access(scope, epoch, () {}, (store) async {
      if (await repo.pending(scope, conversationId) == null) {
        await repo.savePending(
          conversationId,
          scope,
          messageId,
          _reconcileEnvelope(threadId: threadId, outcome: null),
          reconcileOnly: true,
        );
      }
    });
    final ManagedThreadHistory history;
    try {
      history = await client.loadThread(
        threadId,
        gatewayKey: (await credentials())!.gatewayKey,
      );
      _checkEpoch(epoch);
    } on PluginClientException catch (error) {
      if (error.code == 'reseed_required') {
        await _dropStaleThread(
          conversationId,
          threadId: threadId,
          messageId: messageId,
        );
      }
      rethrow;
    }
    await repo.access(scope, epoch, () {}, (store) async {
      final previous = await store.loadConversation(conversationId);
      if (previous == null) {
        throw const PluginClientException('no_pending_turn');
      }
      await repo.replaceHistory(
        scope,
        store,
        previous,
        threadId,
        history.messages,
        expectedMessageId: messageId,
      );
    });
    return history.messages;
  }

  Future<List<ManagedThreadSummary>> listThreads() async {
    final key = (await credentials())!.gatewayKey;
    return client.listThreads(gatewayKey: key);
  }

  Future<void> deleteThread(String threadId) async {
    final key = (await credentials())!.gatewayKey;
    await client.deleteThread(threadId, gatewayKey: key);
  }

  /// Logout hook: cancels in-flight sends and epochs out pending work, then
  /// drops this scope's conversations, messages, and pending rows. Never
  /// touches the remote thread; unscoped legacy history is retained.
  Future<void> clearAccountData() async {
    repo.cancelScope(scope);
    await repo.clearScope(scope);
  }

  /// Drops the stale mapping + this turn's pending marker after a server-side
  /// thread deletion. The mapping is only cleared if it still points at the
  /// dead thread, so a concurrent fresh send cannot be clobbered.
  Future<void> _dropStaleThread(
    String conversationId, {
    required String threadId,
    required String messageId,
  }) async {
    await repo.clearPending(scope, conversationId, messageId: messageId);
    if (await repo.mappedThread(conversationId) == threadId) {
      await repo.clearThreadMapping(conversationId);
    }
  }

  void _checkEpoch(int epoch) {
    if (repo.epoch(scope) != epoch) {
      throw const PluginClientException('cancelled');
    }
  }

  String _title(List<Message> history) =>
      history.where((m) => m.role == MessageRole.user).lastOrNull?.content ??
      'Conversation';

  Map<String, dynamic> _envelope({
    required String messageId,
    required String threadId,
    required List<ApiMessage> messages,
  }) => {
    'messageId': messageId,
    'threadId': threadId,
    'model': modelPluginId,
    'enabledPlugins': enabledPlugins,
    'messages': _encodeMessages(messages),
  };

  Map<String, dynamic> _reconcileEnvelope({
    required String threadId,
    required ManagedAlreadyCompleted? outcome,
  }) => {
    'threadId': threadId,
    'reconcileOnly': true,
    if (outcome != null) ...{
      'taskId': outcome.taskId,
      'terminalStatus': outcome.taskStatus.name,
    },
  };

  List<Map<String, dynamic>> _encodeMessages(List<ApiMessage> messages) =>
      messages
          .map(
            (m) => {
              'role': m.role,
              'content': m.content,
              if (m.toolCalls != null) 'tool_calls': m.toolCalls,
              if (m.toolCallId != null) 'tool_call_id': m.toolCallId,
            },
          )
          .toList();

  List<Message> _historyFromApi(List<ApiMessage> messages) => messages
      .where((m) => m.role != 'tool')
      .map(
        (m) => Message(
          id: '',
          role: MessageRole.values.byName(m.role),
          content: m.content ?? '',
        ),
      )
      .toList();

  /// Rebuilds a retryable turn from the persisted envelope. Only execution
  /// config that was captured at send time is honoured; anything missing or
  /// malformed fails loudly as `invalid_config` rather than silently replaying
  /// the current service's model/plugins.
  _ResumedTurn _decodeEnvelope(String envelope) {
    Object? decoded;
    try {
      decoded = jsonDecode(envelope);
    } catch (_) {
      throw const PluginClientException('invalid_config');
    }
    if (decoded is! Map<String, dynamic>) {
      throw const PluginClientException('invalid_config');
    }
    final threadId = decoded['threadId'];
    final model = decoded['model'];
    final plugins = decoded['enabledPlugins'];
    final rawMessages = decoded['messages'];
    if (threadId is! String ||
        threadId.trim().isEmpty ||
        model is! String ||
        model.trim().isEmpty ||
        plugins is! List ||
        plugins.any((p) => p is! String || p.trim().isEmpty) ||
        rawMessages is! List) {
      throw const PluginClientException('invalid_config');
    }
    final messages = <ApiMessage>[];
    for (final value in rawMessages) {
      if (value is! Map<String, dynamic>) {
        throw const PluginClientException('invalid_config');
      }
      final role = value['role'];
      final content = value['content'];
      final calls = value['tool_calls'];
      final linkage = value['tool_call_id'];
      if (role is! String ||
          (content != null && content is! String) ||
          (calls != null &&
              (calls is! List ||
                  calls.any((c) => c is! Map<String, dynamic>))) ||
          (linkage != null && linkage is! String)) {
        throw const PluginClientException('invalid_config');
      }
      messages.add(
        ApiMessage(
          role: role,
          content: content as String?,
          toolCalls: calls == null
              ? null
              : List<Map<String, dynamic>>.from(calls),
          toolCallId: linkage as String?,
        ),
      );
    }
    return _ResumedTurn(
      threadId: threadId,
      modelPluginId: model,
      enabledPlugins: plugins.cast<String>(),
      messages: messages,
    );
  }
}

class _ResumedTurn {
  const _ResumedTurn({
    required this.threadId,
    required this.modelPluginId,
    required this.enabledPlugins,
    required this.messages,
  });

  final String threadId;
  final String modelPluginId;
  final List<String> enabledPlugins;
  final List<ApiMessage> messages;
}
