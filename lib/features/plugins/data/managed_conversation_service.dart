import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart' show Dio;
import 'package:uuid/uuid.dart';

import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/data/context_trimmer.dart';
import '../../chat/data/message_model.dart';
import '../../chat/data/sse.dart';
import '../../notifications/data/notif_client.dart';
import 'langchain_client.dart';
import 'langchain_request.dart';
import 'ledger_client.dart';
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
  const ManagedTurnOutcome(this.sessionId, this.state);

  /// Raw public session id the server named (equals the client-minted id).
  final String sessionId;

  /// 'seeded' | 'resumed'.
  final String state;
}

class ManagedStreamedTurn extends ManagedTurnOutcome {
  const ManagedStreamedTurn(super.sessionId, super.state, this.result);

  final ChatResult result;
}

/// `200 already_completed` — the retried send hit a turn that already ran.
/// No fresh inference happened; the service reconciles history from the server
/// session as part of handling this outcome. The outcome only marks the
/// duplicate; it carries no task metadata (the sync path admits no ledger
/// tasks).
class ManagedAlreadyCompleted extends ManagedTurnOutcome {
  const ManagedAlreadyCompleted(super.sessionId, super.state);
}

/// Failure that keeps the server session id reachable for the caller.
class ManagedTurnError extends PluginClientException {
  const ManagedTurnError(super.code, {super.statusCode, this.sessionId});

  final String? sessionId;
}

/// Injectable staged managed-chat service. Owns the per-send idempotency
/// lifecycle: messageId minted once, pending row persisted BEFORE dispatch,
/// explicit-only retries with the exact same envelope, server-side duplicate
/// handling (409 in-flight / 200 already-completed), and history
/// reconciliation without a second inference. Never executes tools itself.
///
/// The app owns context management (plan §6): deltas are sent while the
/// conversation window fits and the client re-establishes with a trimmed base
/// under the SAME `session_id` when it fills (the server replaces `messages`).
/// There is no server-side backstop (D7).
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
    this.trimmer = const ContextTrimmer(),
    this._poller,
    this._dio,
  });

  final LangChainClient client;
  final ManagedConversationRepository repo;
  final AuthAccountScope scope;
  final CredentialResolver credentials;
  final String modelPluginId;
  final List<String> enabledPlugins;
  final ContextTrimmer trimmer;

  /// Injectable poller for background-job watches. When null, one is built
  /// lazily from [LedgerClient] over [_dio] (defaults to a fresh [Dio]) with a
  /// credentials resolver that maps the service's [ManagedCredentials] into
  /// poller-scoped [AuthCredentials].
  LedgerPoller? _poller;
  final Dio? _dio;

  LedgerPoller get _ledgerPoller {
    final existing = _poller;
    if (existing != null) return existing;
    final created = LedgerPoller(
      client: LedgerClient(dio: _dio ?? Dio(), scope: scope),
      credentials: _pollCredentials,
    );
    _poller = created;
    return created;
  }

  Future<AuthCredentials?> _pollCredentials() async {
    final managed = await credentials();
    if (managed == null) return null;
    return AuthCredentials(
      apiKey: managed.gatewayKey,
      ownerId: scope.ownerId,
      backendOrigin: scope.backendOrigin,
    );
  }

  /// Sends one user turn into the managed conversation. [history] is the
  /// local conversation so far. If no session is mapped yet (and no explicit
  /// [sessionId] is given) the server is seeded with the FULL local history
  /// (establish, `seeded`). On a mapped session the new user message is sent
  /// as a single-message delta (`resumed`) while the window fits; once the
  /// accumulated history overflows the trimmer budget the client re-establishes
  /// with a trimmed base under the SAME `session_id` (compaction, `seeded`).
  /// The persisted envelope always stores exactly what was sent, so
  /// [retryTurn] replays the same shape/messageId.
  ///
  /// Admission is atomic: the unresolved-turn check, the conversation
  /// creation/append, the session mapping, and the pending-row persistence all
  /// run inside one scope-checked repository transaction, so a logout racing
  /// the send can never leave a pending row behind after its clear.
  Future<ManagedTurnOutcome> sendTurn(
    String conversationId, {
    required List<Message> history,
    required String userText,
    String? sessionId,
  }) async {
    final epoch = repo.epoch(scope);
    final userMessage = Message(
      id: const Uuid().v4(),
      role: MessageRole.user,
      content: userText,
    );
    final localHistory = [...history, userMessage];
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
      final existing = sessionId ?? await repo.mappedSession(conversationId);
      final effectiveSession = existing ?? const Uuid().v4();
      await repo.mapSession(conversationId, effectiveSession);
      final shape = _sendShape(
        mapped: existing != null,
        localHistory: localHistory,
        userMessage: userMessage,
      );
      final messageId = const Uuid().v4();
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _envelope(
          messageId: messageId,
          sessionId: effectiveSession,
          messages: shape.messages,
          delta: shape.delta,
        ),
      );
      return (
        sessionId: effectiveSession,
        messageId: messageId,
        messages: shape.messages,
        delta: shape.delta,
      );
    });
    return _dispatch(
      conversationId,
      epoch,
      sessionId: prepared.sessionId,
      messageId: prepared.messageId,
      messages: prepared.messages,
      history: localHistory,
      modelPluginId: modelPluginId,
      enabledPlugins: enabledPlugins,
      delta: prepared.delta,
    );
  }

  /// Explicit retry of the last staged turn: same messageId, same session, and
  /// the SAME persisted execution config (model + enabled plugins). Only the
  /// credentials are re-resolved — a turn is never replayed against whatever
  /// the current service instance happens to be configured with. A corrupted or
  /// incomplete envelope surfaces `invalid_config`; an already-reconciled turn
  /// surfaces `reconcile_required` (retry is not a send). A BACKGROUND pending
  /// re-submits the identical background job (same messageId, same snapshot)
  /// and returns a [ManagedBackgroundResubmitted] carrying the new watch.
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
    if (resumed.background) {
      final handle = await _dispatchBackground(
        conversationId,
        epoch,
        messageId: pending.messageId,
        messages: resumed.messages,
        history: _historyFromApi(resumed.messages),
        modelPluginId: resumed.modelPluginId,
        enabledPlugins: resumed.enabledPlugins,
      );
      return ManagedBackgroundResubmitted(handle);
    }
    return _dispatch(
      conversationId,
      epoch,
      sessionId: resumed.sessionId,
      messageId: pending.messageId,
      messages: resumed.messages,
      history: _historyFromApi(resumed.messages),
      modelPluginId: resumed.modelPluginId,
      enabledPlugins: resumed.enabledPlugins,
      delta: resumed.delta,
    );
  }

  /// Submits a background job (plan §5 async submission) for the conversation.
  /// One pending turn per conversation (a second submit throws
  /// `pending_turn_exists`); the local conversation is created/updated with the
  /// user message, the injected [trimmer] runs over the full history, a
  /// `messageId` is minted, and a pending envelope marked `background: true` is
  /// persisted BEFORE dispatch so [retryTurn] replays the identical job. The
  /// request carries the trimmed FULL history as `messages`, NO session id
  /// (self-contained snapshot) and `messageId` as the idempotency key.
  ///
  /// Returns a [LedgerPollHandle] whose terminal observation is wired to append
  /// the job's reply (read back via the full ledger task) and clear the pending
  /// marker on `succeeded`, or surface the terminal status and clear the marker
  /// on `failed`/`cancelled`. Multiple different conversations run independent
  /// watches concurrently; the one-pending-turn rule still rejects a second
  /// concurrent submit on the SAME conversation.
  Future<LedgerPollHandle> submitBackground(
    String conversationId, {
    required List<Message> history,
    required String userText,
  }) async {
    final epoch = repo.epoch(scope);
    final userMessage = Message(
      id: const Uuid().v4(),
      role: MessageRole.user,
      content: userText,
    );
    final localHistory = [...history, userMessage];
    final prepared = await repo.access(scope, epoch, () {}, (store) async {
      // One unresolved turn per scoped conversation: a second submit would
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
      // Background jobs run on a self-contained snapshot: the trimmed FULL
      // history, never a session dependency (plan §5).
      final messages = toApiMessages(trimmer.trim(localHistory));
      final messageId = const Uuid().v4();
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _backgroundEnvelope(messageId: messageId, messages: messages),
      );
      return (messageId: messageId, messages: messages);
    });
    return _dispatchBackground(
      conversationId,
      epoch,
      messageId: prepared.messageId,
      messages: prepared.messages,
      history: localHistory,
      modelPluginId: modelPluginId,
      enabledPlugins: enabledPlugins,
    );
  }

  /// Chooses the wire shape for one send and returns the exact API messages to
  /// dispatch. The envelope stores this same list, so [retryTurn] replays the
  /// identical shape (a delta stays a delta; an establish/compaction re-seeds).
  ///
  ///  - No mapped session → establish: trimmed full history (`seeded`).
  ///  - Mapped + window fits (`trimmed.length == localHistory.length`) →
  ///    single-message delta (`resumed`).
  ///  - Mapped + window filled (`trimmed.length < localHistory.length`) →
  ///    compaction re-establish: trimmed full history under the SAME
  ///    `session_id` (`seeded`; the server replaces `messages`).
  ///
  /// `delta` reports whether the send is a single-message delta on a mapped
  /// session — the ONLY shape where a `seeded` response is a silent reseed
  /// (the server lost its session cache and ran context-free). A first-turn or
  /// compaction establish (even a single-message one) is `delta == false`, so
  /// its legitimate `seeded` response never triggers reseed recovery.
  ///
  /// The app owns context management (plan §6), so the trimmed base is
  /// recomputed from the local conversation on every send; there is no
  /// server-side backstop (D7).
  ({List<ApiMessage> messages, bool delta}) _sendShape({
    required bool mapped,
    required List<Message> localHistory,
    required Message userMessage,
  }) {
    final trimmed = trimmer.trim(localHistory);
    if (!mapped || trimmed.length < localHistory.length) {
      // Establish (first turn) or compaction re-establish (window filled):
      // send the trimmed full history so the server seeds/replaces messages.
      return (messages: toApiMessages(trimmed), delta: false);
    }
    // Mapped session and the window still fits: single-message delta.
    return (messages: toApiMessages([userMessage]), delta: true);
  }

  Future<ManagedTurnOutcome> _dispatch(
    String conversationId,
    int epoch, {
    required String sessionId,
    required String messageId,
    required List<ApiMessage> messages,
    required List<Message> history,
    required String modelPluginId,
    required List<String> enabledPlugins,
    bool reestablishAttempted = false,
    bool delta = false,
    bool tooLargeRetried = false,
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
      conversationPublicId: sessionId,
      turnId: messageId,
      managed: true,
      enabledPlugins: enabledPlugins,
    );
    final token = repo.register(scope);
    try {
      final streamed = await client.managedTurn(request, cancelToken: token);
      _checkEpoch(epoch);
      if (streamed.result != null) {
        // N2: a single-message DELTA that the server answered `seeded` means the
        // gateway's in-memory session store was emptied (restart/eviction wiped
        // the tombstones too), so the model reply was generated with ZERO
        // conversation context and the server session now diverges from the
        // client's local history. Discard the context-free reply and re-seed
        // under the SAME session_id from the local store, exactly like a
        // `409 session_missing` (bounded single retry). A legitimate first-turn
        // or compaction establish (`delta == false`) legitimately returns
        // `seeded` and must complete normally.
        if (delta && streamed.state == 'seeded' && !reestablishAttempted) {
          return await _reestablishAfterSessionMissing(
            conversationId,
            epoch,
            sessionId: sessionId,
            modelPluginId: modelPluginId,
            enabledPlugins: enabledPlugins,
          );
        }
        final outcome = ManagedStreamedTurn(
          streamed.sessionId,
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
        streamed.sessionId,
        streamed.state,
      );
      await _reconcileAlreadyCompleted(
        conversationId,
        epoch: epoch,
        messageId: messageId,
        sessionId: streamed.sessionId,
        gatewayKey: resolved.gatewayKey,
      );
      return outcome;
    } on PluginClientException catch (error) {
      if (error.code == 'session_missing' && !reestablishAttempted) {
        // Plan §5/R4: the server evicted/restarted its session cache. Do NOT
        // drop-and-mint a new id — re-establish under the SAME session_id from
        // the client-owned store (which already includes the user's message)
        // with a FRESH messageId, and re-dispatch exactly once.
        return _reestablishAfterSessionMissing(
          conversationId,
          epoch,
          sessionId: sessionId,
          modelPluginId: modelPluginId,
          enabledPlugins: enabledPlugins,
        );
      }
      if (error.code == 'request_too_large' && !tooLargeRetried) {
        // Plan §5/R6: an establish (full history + base64 images) can exceed the
        // body cap. Retry ONCE with a harder prune — drop image blocks from all
        // but the newest image-bearing message. Deltas stay small by design; a
        // text-only history (or a single-message send) has nothing to prune, so
        // the error surfaces.
        final pruned = _pruneImagesForRetry(messages);
        if (pruned != null) {
          return _dispatch(
            conversationId,
            epoch,
            sessionId: sessionId,
            messageId: messageId,
            messages: pruned,
            history: history,
            modelPluginId: modelPluginId,
            enabledPlugins: enabledPlugins,
            reestablishAttempted: reestablishAttempted,
            delta: delta,
            tooLargeRetried: true,
          );
        }
      }
      if (error.code == 'reseed_required') {
        await _dropStaleThread(
          conversationId,
          threadId: sessionId,
          messageId: messageId,
        );
      }
      throw ManagedTurnError(
        error.code,
        statusCode: error.statusCode,
        sessionId: sessionId,
      );
    } finally {
      repo.unregister(scope, token);
    }
  }

  /// Harder body-prune for a `413 request_too_large` establish (plan §5/R6):
  /// drops `image_url` content blocks from every image-bearing message except
  /// the newest one, so the retried request still carries the user's latest
  /// image while shedding the older base64 payloads. Returns null when nothing
  /// can be pruned (a text-only history, or a single image-bearing message) —
  /// the caller surfaces the 413 instead of sending a pointless retry.
  List<ApiMessage>? _pruneImagesForRetry(List<ApiMessage> messages) {
    final imageIndexes = <int>[];
    for (var i = 0; i < messages.length; i++) {
      final content = messages[i].content;
      if (content is! List) continue;
      if (content.any((block) => block is Map && block['type'] == 'image_url')) {
        imageIndexes.add(i);
      }
    }
    if (imageIndexes.isEmpty) return null;
    final newest = imageIndexes.last;
    if (imageIndexes.every((index) => index == newest)) return null;
    return List.unmodifiable(
      messages.indexed.map((entry) {
        final (index, message) = entry;
        final content = message.content;
        if (index != newest &&
            content is List &&
            content.any((b) => b is Map && b['type'] == 'image_url')) {
          final filtered = List<Object?>.unmodifiable(
            content.where((block) => !(block is Map && block['type'] == 'image_url')),
          );
          return ApiMessage(
            role: message.role,
            content: filtered,
            toolCalls: message.toolCalls,
            toolCallId: message.toolCallId,
          );
        }
        return message;
      }),
    );
  }

  /// Dispatches one background job: POST the `background: true` request (JSON
  /// response, never SSE), then start a ledger watch keyed by the job's
  /// `messageId`. A submission failure surfaces to the caller and keeps the
  /// pending marker (the [retryTurn] identity). On success returns the watch
  /// handle whose terminal observation reconciles the reply.
  Future<LedgerPollHandle> _dispatchBackground(
    String conversationId,
    int epoch, {
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
      turnId: messageId,
      background: true,
      enabledPlugins: enabledPlugins,
    );
    final token = repo.register(scope);
    try {
      await client.backgroundTurn(request, cancelToken: token);
      _checkEpoch(epoch);
    } finally {
      repo.unregister(scope, token);
    }
    return _watchBackground(
      conversationId,
      epoch,
      lookup: LedgerLookup.byMessageId(messageId),
      history: history,
    );
  }

  /// Starts a ledger watch for one background job and wires its terminal
  /// observation: `succeeded` reads the reply back (via the full task) and
  /// appends it to the conversation + clears the pending marker; `failed` /
  /// `cancelled` clear the marker (the server owns the failure); everything
  /// else keeps the marker for an explicit retry. Epoch-safe: a scope clear
  /// mid-poll makes the reconciliation a no-op. Each submitBackground call
  /// creates an independent watch (the poller keys by lookup).
  LedgerPollHandle _watchBackground(
    String conversationId,
    int epoch, {
    required LedgerLookup lookup,
    required List<Message> history,
  }) {
    final handle = _ledgerPoller.watch(lookup);
    unawaited(handle.done.then((result) async {
      // A poll-completion failure (e.g. the reply read-back fetch) must never
      // surface as an unhandled async error: the pending marker stays so the
      // caller can retry explicitly.
      try {
        await _handleBackgroundTerminal(
          conversationId,
          epoch,
          result,
          history: history,
        );
      } on PluginClientException {
        // Scope cancellation or a transient reconciliation failure — both
        // leave the pending marker untouched (retryable).
      } catch (_) {
        // Unknown failure — the pending marker is retained.
      }
    }));
    return handle;
  }

  Future<void> _handleBackgroundTerminal(
    String conversationId,
    int epoch,
    LedgerPollResult result, {
    required List<Message> history,
  }) async {
    try {
      _checkEpoch(epoch);
    } on PluginClientException {
      return; // scope cancelled / logout — nothing to write.
    }
    // Only an observed terminal status reconciles; exhaustion/error/cancelled
    // polls keep the pending marker for an explicit retry.
    if (result.end != LedgerPollEnd.observed) return;
    final task = result.task;
    if (task == null) return;
    final pending = await repo.pending(scope, conversationId);
    // The turn must still own the pending row (never clobber a newer turn or
    // duplicate an already-reconciled push-driven re-poll).
    if (pending == null || pending.messageId != task.messageId) return;
    switch (task.status) {
      case LedgerTaskStatus.succeeded:
        await _appendBackgroundReply(conversationId, epoch, task,
            history: history);
        // Never fall through: a job that succeeded WITHOUT a stored reply keeps
        // the pending marker (the retry identity) per _appendBackgroundReply.
        break;
      case LedgerTaskStatus.failed:
      case LedgerTaskStatus.cancelled:
        // The server owns the failure; the client clears the retry identity.
        await repo.clearPending(scope, conversationId,
            messageId: task.messageId);
        break;
      case LedgerTaskStatus.queued:
      case LedgerTaskStatus.running:
      case LedgerTaskStatus.stuck:
      case LedgerTaskStatus.awaitingReview:
      case LedgerTaskStatus.unknown:
        break;
    }
  }

  /// Appends a succeeded job's reply to the conversation (mirrors
  /// [_completeTurn]'s store write) and clears the pending marker. The reply is
  /// read back via the FULL ledger task (`GET /ledger/tasks/:id` — the
  /// status-by-messageId endpoint does not carry steps). A job that succeeded
  /// WITHOUT a stored reply leaves the pending marker in place and never
  /// fabricates an assistant message.
  Future<void> _appendBackgroundReply(
    String conversationId,
    int epoch,
    LedgerTask task, {
    required List<Message> history,
  }) async {
    final managed = await credentials();
    if (managed == null) return;
    _checkEpoch(epoch);
    final full = await _ledgerPoller.client.getTask(
      task.id,
      gatewayKey: managed.gatewayKey,
    );
    _checkEpoch(epoch);
    final reply = full.reply;
    if (reply == null) return; // succeeded but no stored reply — keep pending.
    await repo.access(scope, epoch, () {}, (store) async {
      final current = await store.loadConversation(conversationId);
      final assistant = Message(
        id: const Uuid().v4(),
        role: MessageRole.assistant,
        content: stripStructuredTokens(reply),
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
        await store.appendMessage(conversationId, assistant);
      }
      await repo.clearPending(scope, conversationId,
          messageId: task.messageId);
    });
  }

  /// Push-driven re-poll seam (plan §8, D1 optional). Subscribes [push] to
  /// [topic] and, when a completion notification references the job's task,
  /// re-watches it immediately so the reply is fetched without waiting for the
  /// next backoff tick. The re-watch uses the TASK id parsed from the push
  /// title/body (the server's ntfy hook pushes `Title: "Job <taskId>"` with a
  /// summary body that does NOT carry the client's `messageId` — documented
  /// assumption; the mapping requires the hook to keep the task id in the
  /// title). Returns the subscription for cleanup. No UI is built here.
  StreamSubscription<NotifMessage> watchWithPush(
    NotifClient push,
    String topic,
    Stream<NotifMessage> messages, {
    required String conversationId,
    required String messageId,
    required List<Message> history,
  }) {
    push.subscribe(topic);
    return messages.listen((message) {
      final taskId = _notifTaskId(message);
      if (taskId == null) return;
      try {
        final epoch = repo.epoch(scope);
        _watchBackground(
          conversationId,
          epoch,
          lookup: LedgerLookup.byTaskId(taskId),
          history: history,
        );
      } on PluginClientException {
        // A malformed push task id must never surface as an unhandled stream
        // error; the backoff poll still reconciles the job.
      }
    });
  }

  /// Parses the task id from a job-completion notification, or null when the
  /// event is not one. See [watchWithPush] for the assumption.
  String? _notifTaskId(NotifMessage message) {
    final match = RegExp(r'^Job\s+([^\s]+)').firstMatch(message.title.trim());
    return match?.group(1);
  }

  /// Same-`session_id` re-establish after a `409 session_missing`. Loads the
  /// full conversation from the local store (the client-owned source of truth),
  /// mints a fresh messageId, persists a new pending envelope, and dispatches
  /// once. The nested dispatch is flagged so a second `session_missing` from
  /// the re-establish itself surfaces as an error instead of looping.
  Future<ManagedTurnOutcome> _reestablishAfterSessionMissing(
    String conversationId,
    int epoch, {
    required String sessionId,
    required String modelPluginId,
    required List<String> enabledPlugins,
  }) async {
    _checkEpoch(epoch);
    final stored = await repo.access(
      scope,
      epoch,
      () {},
      (store) => store.loadConversation(conversationId),
    );
    _checkEpoch(epoch);
    if (stored == null) throw const PluginClientException('no_pending_turn');
    // The local conversation may itself be over budget — run the same trimmer
    // over the full history before re-seeding (plan §6).
    final trimmed = trimmer.trim(stored.messages);
    final messages = toApiMessages(trimmed);
    final messageId = const Uuid().v4();
    // The pending row is written under the same epoch-guarded access as every
    // other local write: a logout racing the re-establish can neither interleave
    // a bare savePending after clearScope (zombie row) nor be undone silently.
    await repo.access(scope, epoch, () {}, (store) async {
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _envelope(
          messageId: messageId,
          sessionId: sessionId,
          messages: messages,
        ),
      );
    });
    _checkEpoch(epoch);
    return _dispatch(
      conversationId,
      epoch,
      sessionId: sessionId,
      messageId: messageId,
      messages: messages,
      history: trimmed,
      modelPluginId: modelPluginId,
      enabledPlugins: enabledPlugins,
      reestablishAttempted: true,
    );
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
  ///   2. fetch the server session,
  ///   3. commit it over local history, and
  ///   4. clear the marker (compare-and-delete on the turn's messageId).
  /// The outcome only marks the duplicate; no task status is carried.
  Future<void> _reconcileAlreadyCompleted(
    String conversationId, {
    required int epoch,
    required String messageId,
    required String sessionId,
    required String gatewayKey,
  }) async {
    await repo.access(scope, epoch, () {}, (store) async {
      await repo.savePending(
        conversationId,
        scope,
        messageId,
        _reconcileEnvelope(sessionId: sessionId),
        reconcileOnly: true,
      );
    });
    final history = await client.loadSession(sessionId, gatewayKey: gatewayKey);
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
        await repo.mapSession(conversationId, sessionId);
      } else {
        await repo.replaceHistory(
          scope,
          store,
          previous,
          sessionId,
          history.messages,
          expectedMessageId: messageId,
        );
      }
      await repo.clearPending(scope, conversationId, messageId: messageId);
    });
  }

  /// Replaces local history with the server session for the conversation's
  /// mapped session id. No inference happens here. A reconciliation marker is
  /// persisted before the fetch so a failure leaves an explicit, retryable
  /// state, and the marker is cleared only after the history is committed. A
  /// `409 reseed_required` (mapped thread deleted server-side) clears the stale
  /// mapping and marker so the next send mints a fresh thread while local
  /// history is retained. A `409 session_missing` means there is nothing on the
  /// server to reconcile — the client store is authoritative — so the local
  /// messages are returned and the reconcile marker cleared WITHOUT dropping
  /// the session mapping.
  Future<List<Message>> reconcileFromServer(String conversationId) async {
    final epoch = repo.epoch(scope);
    final sessionId = await repo.mappedSession(conversationId);
    if (sessionId == null) {
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
          _reconcileEnvelope(sessionId: sessionId),
          reconcileOnly: true,
        );
      }
    });
    final ManagedSessionHistory history;
    try {
      history = await client.loadSession(
        sessionId,
        gatewayKey: (await credentials())!.gatewayKey,
      );
      _checkEpoch(epoch);
    } on PluginClientException catch (error) {
      if (error.code == 'reseed_required') {
        await _dropStaleThread(
          conversationId,
          threadId: sessionId,
          messageId: messageId,
        );
        rethrow;
      }
      if (error.code == 'session_missing') {
        await repo.clearPending(scope, conversationId, messageId: messageId);
        _checkEpoch(epoch);
        final local = await repo.access(
          scope,
          epoch,
          () {},
          (store) async =>
              (await store.loadConversation(conversationId))?.messages ??
              const <Message>[],
        );
        return local;
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
        sessionId,
        history.messages,
        expectedMessageId: messageId,
      );
    });
    return history.messages;
  }

  Future<void> deleteSession(String sessionId) async {
    final key = (await credentials())!.gatewayKey;
    await client.deleteSession(sessionId, gatewayKey: key);
  }

  /// Logout hook: cancels in-flight sends and epochs out pending work, then
  /// drops this scope's conversations, messages, and pending rows. Also stops
  /// any live background-job watches. Never touches the remote session;
  /// unscoped legacy history is retained.
  Future<void> clearAccountData() async {
    _poller?.invalidateScope();
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
    if (await repo.mappedSession(conversationId) == threadId) {
      await repo.clearSessionMapping(conversationId);
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
    required String sessionId,
    required List<ApiMessage> messages,
    bool delta = false,
  }) => {
    'messageId': messageId,
    'session_id': sessionId,
    'model': modelPluginId,
    'enabledPlugins': enabledPlugins,
    'messages': _encodeMessages(messages),
    'delta': delta,
  };

  /// Persisted retry envelope for a BACKGROUND job: no session (the job runs
  /// on its submitted snapshot), `background: true` so `_decodeEnvelope` and
  /// `retryTurn` replay it as a background submission under the same messageId.
  Map<String, dynamic> _backgroundEnvelope({
    required String messageId,
    required List<ApiMessage> messages,
  }) => {
    'messageId': messageId,
    'model': modelPluginId,
    'enabledPlugins': enabledPlugins,
    'messages': _encodeMessages(messages),
    'background': true,
  };

  Map<String, dynamic> _reconcileEnvelope({required String sessionId}) => {
    'session_id': sessionId,
    'reconcileOnly': true,
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
          content: flattenMessageContent(m.content),
        ),
      )
      .toList();

  /// Rebuilds a retryable turn from the persisted envelope. Only execution
  /// config that was captured at send time is honoured; anything missing or
  /// malformed fails loudly as `invalid_config` rather than silently replaying
  /// the current service's model/plugins. A `background: true` envelope has no
  /// session (its `session_id` is optional and unused) and replays via the
  /// background dispatch path.
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
    final background = decoded['background'] == true;
    final sessionId = decoded['session_id'];
    final model = decoded['model'];
    final plugins = decoded['enabledPlugins'];
    final rawMessages = decoded['messages'];
    final delta = decoded['delta'] == true;
    if (!background && (sessionId is! String || sessionId.trim().isEmpty)) {
      throw const PluginClientException('invalid_config');
    }
    if (model is! String ||
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
          (content != null && content is! String && content is! List) ||
          (calls != null &&
              (calls is! List ||
                  calls.any((c) => c is! Map<String, dynamic>))) ||
          (linkage != null && linkage is! String)) {
        throw const PluginClientException('invalid_config');
      }
      messages.add(
        ApiMessage(
          role: role,
          content: content,
          toolCalls: calls == null
              ? null
              : List<Map<String, dynamic>>.from(calls),
          toolCallId: linkage as String?,
        ),
      );
    }
    return _ResumedTurn(
      sessionId: sessionId is String ? sessionId : '',
      background: background,
      delta: delta,
      modelPluginId: model,
      enabledPlugins: plugins.cast<String>(),
      messages: messages,
    );
  }
}

class _ResumedTurn {
  const _ResumedTurn({
    required this.sessionId,
    this.background = false,
    this.delta = false,
    required this.modelPluginId,
    required this.enabledPlugins,
    required this.messages,
  });

  final String sessionId;
  final bool background;
  final bool delta;
  final String modelPluginId;
  final List<String> enabledPlugins;
  final List<ApiMessage> messages;
}

/// A re-submitted BACKGROUND turn ([retryTurn] on a background pending): the
/// identical job was sent again under the same `messageId` and [handle]
/// observes its terminal status and reply. The base sessionId/state are empty
/// because a background job has no session.
class ManagedBackgroundResubmitted extends ManagedTurnOutcome {
  const ManagedBackgroundResubmitted(this.handle) : super('', 'background');

  final LedgerPollHandle handle;
}
