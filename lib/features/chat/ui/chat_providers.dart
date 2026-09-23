import 'dart:async';
import 'dart:io' show File;
import 'dart:typed_data' show Uint8List;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../data/chat_client.dart';
import '../data/status_tracker.dart';
import '../../attachments/data/files_providers.dart';
import '../../../core/network_banner.dart';
import '../../vision/data/vision_client.dart';
import '../../vision/data/vision_provider.dart';
import '../../attachments/data/file_model.dart';
import '../../attachments/data/file_store.dart';
import '../../attachments/data/upload_queue.dart';
import '../data/chat_store.dart';
import '../data/context_trimmer.dart';
import '../data/database_providers.dart';
import '../data/message_model.dart';
import '../../plugins/data/ledger_client.dart';
import '../../plugins/data/managed_chat_providers.dart';
import '../../plugins/data/managed_conversation_service.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_http.dart';


export 'active_conversation_provider.dart';

/// Snapshot of a single conversation's chat state, consumed by the UI.
class ConversationState {
  final List<Message> messages;
  final bool isStreaming;
  final String? error;

  /// Id of the last user message still awaiting a reply (drives the
  /// typing indicator / disabled input).
  final String? pendingUserMessageId;

  /// Id of the assistant placeholder that errored (drives the retry UI).
  final String? failedMessageId;

  /// True once the conversation has been loaded from the store.
  final bool isDbReady;

  /// Live upload progress for attachment jobs, keyed by job id. A `done`
  /// status carries the server file id; a `failed` status carries an error.
  /// Updated as the upload queue reports progress.
  final Map<String, UploadJobStatus> attachmentUploads;

  /// True when the last failure was a gateway 401 (missing/invalid API key).
  /// Distinct from [error]: the UI renders the re-auth card instead of a
  /// generic message.
  final bool authRequired;

  /// True while this conversation owns a background job (plan P3): a pending
  /// ledger-polled submission is running and its reply has not been appended
  /// yet. Drives the pending-job chip + Retry/Cancel affordances. Cleared when
  /// the poll observes a terminal status (or the job is cancelled).
  final bool hasPendingJob;

  /// Human-readable error for the last terminal background job when it failed
  /// (`succeeded` clears it). Drives the chip's "Retry job" affordance.
  final String? jobError;

  const ConversationState({
    required this.messages,
    this.isStreaming = false,
    this.error,
    this.pendingUserMessageId,
    this.failedMessageId,
    this.isDbReady = false,
    this.attachmentUploads = const {},
    this.authRequired = false,
    this.hasPendingJob = false,
    this.jobError,
  });

  ConversationState copyWith({
    List<Message>? messages,
    bool? isStreaming,
    Object? error = _sentinel,
    Object? pendingUserMessageId = _sentinel,
    Object? failedMessageId = _sentinel,
    Object? attachmentUploads = _sentinel,
    bool? isDbReady,
    Object? authRequired = _sentinel,
    bool? hasPendingJob,
    Object? jobError = _sentinel,
  }) {
    return ConversationState(
      messages: messages ?? this.messages,
      isStreaming: isStreaming ?? this.isStreaming,
      error: identical(error, _sentinel) ? this.error : error as String?,
      pendingUserMessageId: identical(pendingUserMessageId, _sentinel)
          ? this.pendingUserMessageId
          : pendingUserMessageId as String?,
      failedMessageId: identical(failedMessageId, _sentinel)
          ? this.failedMessageId
          : failedMessageId as String?,
      attachmentUploads: identical(attachmentUploads, _sentinel)
          ? this.attachmentUploads
          : attachmentUploads as Map<String, UploadJobStatus>,
      isDbReady: isDbReady ?? this.isDbReady,
      authRequired: identical(authRequired, _sentinel)
          ? this.authRequired
          : authRequired as bool,
      hasPendingJob: hasPendingJob ?? this.hasPendingJob,
      jobError: identical(jobError, _sentinel) ? this.jobError : jobError as String?,
    );
  }
}

const Object _sentinel = Object();

/// Drives the chat UI for a single conversation, streaming LLM completions and
/// executing tools. Riverpod 3 family notifier; the conversation id is passed
/// via the constructor from the provider's create function.
class ConversationNotifier extends AsyncNotifier<ConversationState> {
  ConversationNotifier(this.conversationId);

  final String conversationId;

  final _uuid = const Uuid();

  /// Cancel token for the in-flight request.
  CancelToken? _active;

  /// Cancellation state of the in-flight turn is derived from the active
  /// [CancelToken] (see [stop] / [_onError]) rather than a bare bool, so a
  /// stale cancellation from a previous (stopped) turn can never be
  /// mis-attributed to a newer turn that is running fine.

  /// Coalesces streamed content deltas into ~80ms batched state updates.
  Timer? _throttle;
  String? _pendingAssistantId;
  StringBuffer? _pendingContent;

  ChatStore? _store;
  ContextTrimmer? _trimmer;
  FileStore? _fileStore;

  /// Owned by this notifier and disposed with it (§3.3). Created in [build]
  /// from [filesServiceProvider]; a [NoOpFilesClient] (no files secret
  /// configured) fails uploads gracefully with a clear error.
  UploadQueue? _queue;

  /// Maps an upload job id to the user message it belongs to, so a completed
  /// upload's `[file:<id>]` reference is appended to the right message.
  final Map<String, String> _jobUserMessageId = {};

  /// Upload job ids whose `[file:<id>]` reference has already been appended.
  final Set<String> _appendedRefs = {};

  /// Service-minted id of the user message admitted for the current/most
  /// recent turn (`ManagedTurnOutcome.userMessageId`, or
  /// `ManagedTurnError.userMessageId` on a post-admission failure). Null when
  /// admission never ran. The STORE is only ever written with this id — the
  /// optimistic in-memory UUID minted in [sendMessage] never matches the
  /// service's row and would `insertOnConflictUpdate` a duplicate.
  String? _serviceUserMessageId;

  /// Serializes [FileInfo] + message persistence across concurrently-completing
  /// uploads. Without it, two jobs finishing back-to-back each write the full
  /// user message and the later write can clobber the earlier ref.
  Future<void> _persistChain = Future.value();

  @override
  Future<ConversationState> build() async {
    _store = ref.watch(chatStoreProvider);
    _trimmer = ref.watch(contextTrimmerProvider);
    _fileStore = ref.watch(filesStoreProvider);
    final queue = UploadQueue(filesService: ref.read(filesServiceProvider));
    _queue = queue;

    // Wait for the database to be ready before loading messages.
    await ref.watch(databaseReadyProvider);
    if (!ref.mounted) return const ConversationState(messages: []);

    queue.jobs.addListener(_onQueueChanged);

    ref.onDispose(() {
      queue.jobs.removeListener(_onQueueChanged);
      queue.dispose();
      _active?.cancel();
      _throttle?.cancel();
    });

    final conversation = await _store!.loadConversation(conversationId);
    if (!ref.mounted) return const ConversationState(messages: []);

    // Open-conversation store watch (plan P3): a background poller appends the
    // job's reply (or another surface writes) without this notifier's
    // involvement. Re-read on every store change so the appended reply renders
    // without navigating away. Guards: skip while a live stream owns the
    // in-memory state, and skip when the store row is byte-identical (a
    // notifier-originated write emitting its own update would otherwise loop).
    final storeSub = _store!.watchConversations().listen(_onStoreChanged);
    ref.onDispose(storeSub.cancel);

    // Restore the pending-job chip + re-arm a fresh watch when this notifier
    // rebuilt after navigation while a background job is still pending (the
    // poller + its handle survive in the account-scoped adapter). Best-effort:
    // no scope / no background pending row yields null and the chip stays off.
    var restoredJob = false;
    try {
      final handle = await ref
          .read(managedChatAdapterProvider)
          .rewatchPendingBackground(conversationId);
      if (handle != null && ref.mounted) {
        restoredJob = true;
        _watchBackgroundHandle(handle);
      }
    } catch (_) {
      // Scope not ready or the row is not a background envelope — no chip.
    }

    return ConversationState(
      messages: conversation?.messages ?? const [],
      isDbReady: true,
      hasPendingJob: restoredJob,
    );
  }

  /// Store-watch callback: mirrors the latest persisted conversation into
  /// state whenever the store emits a change (a poller-appended reply, a
  /// notifier-originated write, etc.). Skips while streaming (the live turn's
  /// in-memory placeholder is ahead of the store) and when nothing changed.
  void _onStoreChanged(List<Conversation> conversations) {
    if (!ref.mounted) return;
    final cur = state.value;
    if (cur == null || cur.isStreaming) return;
    final updated = conversations
        .where((c) => c.id == conversationId)
        .firstOrNull;
    if (updated == null) return;
    if (_sameMessages(updated.messages, cur.messages)) return;
    _setState(cur.copyWith(messages: updated.messages, isDbReady: true));
  }

  /// Re-reads the conversation from the store and swaps its messages into
  /// state (used after a background poll observes a terminal status, so the
  /// appended reply / cleared marker renders). No-op when the store is
  /// byte-identical to the current in-memory messages.
  Future<void> _reloadFromStore() async {
    if (!ref.mounted) return;
    final conversation = await _store!.loadConversation(conversationId);
    if (!ref.mounted) return;
    final cur = state.value;
    if (cur == null) return;
    final messages = conversation?.messages ?? const <Message>[];
    if (_sameMessages(messages, cur.messages)) return;
    _setState(cur.copyWith(messages: messages, isDbReady: true));
  }

  static bool _sameMessages(List<Message> a, List<Message> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].id != b[i].id ||
          a[i].role != b[i].role ||
          a[i].content != b[i].content) {
        return false;
      }
    }
    return true;
  }

  Future<void> sendMessage(
    String text, {
    List<AttachmentDraft> attachments = const [],
  }) async {
    final current = state.value;
    if (current == null || current.isStreaming) return;

    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    final userMsg = Message(
      id: _uuid.v4(),
      role: MessageRole.user,
      content: trimmed,
      createdAt: DateTime.now(),
    );

    _setState(current.copyWith(
      messages: [...current.messages, userMsg],
      pendingUserMessageId: userMsg.id,
      isStreaming: true,
      error: null,
      failedMessageId: null,
      authRequired: false,
    ));

    // No pre-persist: the managed service admits the user message (and the
    // pending envelope) atomically inside sendTurn — exactly one writer.

    // Pre-send describe: attach image descriptions so the current turn
    // benefits from vision. Fail-open on failure — never blocks the send.
    // The expanded text stays in-memory only; admission persists it as the
    // userText passed to sendTurn (no post-send store round-trip).
    if (attachments.isNotEmpty) {
      final visionEnabled = ref.read(visionEnabledProvider) ?? true;
      if (visionEnabled) {
        final descriptions = await _describeDrafts(attachments);
        if (!ref.mounted) return;
        if (descriptions.isNotEmpty) {
          final expanded = _injectImageDescriptions(userMsg.content, descriptions);
          final updatedUserMsg = userMsg.copyWith(content: expanded);
          final cur = state.value!;
          final updatedMessages = [
            for (final m in cur.messages)
              if (m.id == updatedUserMsg.id) updatedUserMsg else m,
          ];
          _setState(cur.copyWith(messages: updatedMessages));
        }
      }
    }

    try {
      await _runTurn();
    } catch (_) {
      // A failed turn must NOT enqueue attachments: the UI retains the
      // selection (chat_screen._send does not clear it on failure), so a
      // retry re-sends exactly once instead of uploading the same files
      // twice. Note: a *chat* error (network/tool) is handled inside
      // _streamOnce/_onError and does not throw here, so uploads still start
      // for a turn whose reply failed but whose message was persisted.
      //
      // An unexpected throw leaves the streaming flag set (only the success
      // path / _onError clears it), which would wedge the conversation: the
      // input stays disabled and the user could never retry. Clear it here so
      // the UI is usable again, while still rethrowing so _send keeps the
      // text + attachment selection intact.
      final cur = state.value;
      if (cur != null && ref.mounted) {
        _setState(cur.copyWith(
          isStreaming: false,
          pendingUserMessageId: null,
        ));
      }
      rethrow;
    }
    if (!ref.mounted) return;
    // §3.6: attachments upload asynchronously AFTER the turn succeeds, so the
    // user's text is never blocked on slow uploads. The uploads must be keyed
    // to the SERVICE-minted user id (P1b): the store row was minted inside
    // sendTurn's admission, and upload refs must land on that row or they
    // write a duplicate.
    //
    // When admission never ran (a pre-admission rejection such as
    // `pending_turn_exists` or a resolution failure), `_serviceUserMessageId`
    // is null and the optimistic in-memory UUID must NOT be used as a fallback:
    // `updateMessage` would `insertOnConflictUpdate` a phantom user row into
    // the existing conversation. Drop the uploads instead — the UI retains the
    // attachment selection, so a retry re-sends exactly once.
    final persistedUserId = _serviceUserMessageId;
    if (persistedUserId == null) return;
    _enqueueAttachments(attachments, persistedUserId);
  }

  void _enqueueAttachments(List<AttachmentDraft> attachments, String userMsgId) {
    final queue = _queue;
    if (queue == null || attachments.isEmpty) return;
    for (final draft in attachments) {
      unawaited(_enqueueOne(queue, draft, userMsgId));
    }
  }

  Future<void> _enqueueOne(
    UploadQueue queue,
    AttachmentDraft draft,
    String userMsgId,
  ) async {
    try {
      final jobId = await queue.enqueue(
        path: draft.path,
        filename: draft.filename,
        sizeBytes: draft.sizeBytes,
        mimeType: draft.mimeType,
      );
      _jobUserMessageId[jobId] = userMsgId;
      // The upload may have already completed by the time the mapping above is
      // recorded (an already-resolved service completes in a microtask);
      // reconcile any such job now so its [file:<id>] ref is not dropped.
      final jobs = queue.jobs.value;
      if (jobs.any((j) => j.id == jobId && j.status == UploadStatus.done)) {
        _handleCompletedJobs(jobs);
      }
    } catch (_) {
      // Best-effort: a failed enqueue leaves no job to surface in state.
    }
  }

  /// Mirrors the queue's live jobs into [ConversationState.attachmentUploads]
  /// and, for newly-completed uploads, appends the `[file:<id>]` reference to
  /// the owning user message (in-memory + persisted).
  void _onQueueChanged() {
    if (!ref.mounted) return;
    final current = state.value;
    if (current == null) return;

    final jobs = _queue?.jobs.value ?? const <UploadJob>[];
    final uploads = <String, UploadJobStatus>{};
    for (final job in jobs) {
      uploads[job.id] = UploadJobStatus(
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        serverFileId: job.serverFileId,
        uri: job.uri,
      );
    }
    _setState(current.copyWith(attachmentUploads: uploads));
    _handleCompletedJobs(jobs);
  }

  void _handleCompletedJobs(List<UploadJob> jobs) {
    for (final job in jobs) {
      final serverFileId = job.serverFileId;
      if (job.status != UploadStatus.done || serverFileId == null) continue;
      // The jobId -> user message mapping is recorded a microtask after the
      // job is enqueued; a very fast upload may finish first. Skip without
      // marking the ref appended so [_enqueueOne]'s reconciliation can retry.
      final userMsgId = _jobUserMessageId[job.id];
      if (userMsgId == null) continue;
      if (!_appendedRefs.add(job.id)) continue;

      final cur = state.value;
      if (cur == null) continue;
      Message? updated;
      for (final m in cur.messages) {
        if (m.id == userMsgId) {
          updated = m.copyWith(content: _appendFileRef(m.content, serverFileId));
          break;
        }
      }
      if (updated == null) continue;

      _setState(cur.copyWith(messages: [
        for (final m in cur.messages)
          if (m.id == userMsgId) updated else m,
      ]));
      // Serialize persistence in completion order so two uploads finishing
      // concurrently can't overwrite each other's [file:<id>] ref in the DB.
      _persistChain = _persistChain.then(
        (_) => _persistCompletedUpload(job, serverFileId, userMsgId),
      );
    }
  }

  /// Appends `[file:<id>]` to a user message's content (idempotent per id).
  String _appendFileRef(String content, String fileId) {
    final ref = '[file:$fileId]';
    if (content.contains(ref)) return content;
    return content.isEmpty ? ref : '$content $ref';
  }

  Future<void> _persistCompletedUpload(
    UploadJob job,
    String serverFileId,
    String userMsgId,
  ) async {
    if (!ref.mounted) return;
    try {
      // Re-read the freshest in-memory content (every ref appended so far) so
      // the write is consistent even if another upload completed meanwhile.
      final message = _latestUserMessage(userMsgId);
      if (message != null) {
        await _store!.updateMessage(conversationId, message);
      }
    } catch (_) {
      // Best-effort: the reference is already reflected in in-memory state.
    }
    if (!ref.mounted) return;
    try {
      await _fileStore!.saveFile(
        FileInfo(
          id: serverFileId,
          filename: job.filename,
          sizeBytes: job.sizeBytes,
          mimeType: job.mimeType,
          uploadedAt: DateTime.now(),
        ),
        conversationId: conversationId,
      );
    } catch (_) {
      // Best-effort: a persistence failure must not crash the turn.
    }
  }

  /// Returns the current in-memory user message for [userMsgId], or null.
  Message? _latestUserMessage(String userMsgId) {
    final cur = state.value;
    if (cur == null) return null;
    for (final m in cur.messages) {
      if (m.id == userMsgId) return m;
    }
    return null;
  }

  /// Records the service-minted user-message id for the current turn and
  /// re-keys the trailing in-memory user row to it (it was minted optimistically
  /// in [sendMessage] and only matches the store after a post-outcome reload).
  /// Re-keying here keeps in-memory ref bookkeeping (`_handleCompletedJobs`)
  /// and the store write (`_persistCompletedUpload`) on the same id — the one
  /// the service actually admitted. A null/empty id means nothing was
  /// admitted; the optimistic id stays.
  void _adoptServiceUserId(String? serviceId) {
    if (serviceId == null || serviceId.isEmpty) return;
    _serviceUserMessageId = serviceId;
    final cur = state.value;
    if (cur == null) return;
    final index = cur.messages.lastIndexWhere((m) => m.role == MessageRole.user);
    if (index < 0) return;
    final existing = cur.messages[index];
    if (existing.id == serviceId) return;
    _setState(cur.copyWith(
      messages: [
        for (var i = 0; i < cur.messages.length; i++)
          if (i == index) existing.copyWith(id: serviceId) else cur.messages[i],
      ],
      pendingUserMessageId: cur.pendingUserMessageId == existing.id
          ? serviceId
          : _sentinel,
    ));
  }

  /// Resolves a description for each local draft in parallel, with a 5s
  /// timeout per image. Fail-open: failures/timeouts skip that image.
  Future<Map<String, String>> _describeDrafts(
    List<AttachmentDraft> attachments,
  ) async {
    final visionAsync = ref.read(visionClientProvider);
    final client = visionAsync.maybeWhen(
      data: (c) => c,
      orElse: () => const NoOpVisionClient(),
    );
    final descriptions = <String, String>{};
    final futures = attachments.map((draft) async {
      final bytes = await _readDraftBytes(draft.path);
      if (bytes == null) return;
      try {
        final description = await client
            .describeImage(
              bytes: bytes,
              mimeType: draft.mimeType,
            )
            .timeout(const Duration(seconds: 5));
        if (description.trim().isNotEmpty) {
          descriptions[draft.filename] = description;
        }
      } catch (e) {
        if (e is Error || e is Exception) {
          // Fail-open: skip this image.
        } else {
          rethrow;  // Preserve fatal errors
        }
      }
    });
    await Future.wait(futures);
    return descriptions;
  }

  Future<Uint8List?> _readDraftBytes(String path) async {
    try {
      final file = File(path);
      if (await file.exists()) {
        return await file
            .readAsBytes()
            .timeout(const Duration(seconds: 5));
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  String _injectImageDescriptions(
    String content,
    Map<String, String> descriptions,
  ) {
    var result = content;
    for (final entry in descriptions.entries) {
      final block = '[Image: ${entry.value}]';
      result = result.isEmpty ? block : '$result\n$block';
    }
    return result;
  }

  /// Reads descriptions from the DB for any [file:<id>] refs in the
  /// current messages, then calls [expandFileRefs].
  Future<List<Message>> _expandMessages(List<Message> messages) async {
    final fileIds = <String>[];
    final refRegex = RegExp(r'\[file:([^\]]+)\]');
    for (final m in messages) {
      if (m.role != MessageRole.user) continue;
      for (final match in refRegex.allMatches(m.content)) {
        fileIds.add(match.group(1)!);
      }
    }
    if (fileIds.isEmpty) return messages;
    final descriptions = <String, String>{};
    for (final id in fileIds) {
      final desc = await _fileStore?.descriptionFor(id);
      if (desc != null && desc.trim().isNotEmpty) {
        descriptions[id] = desc;
      }
    }
    return expandFileRefs(messages, descriptions);
  }

  Future<void> retry() async {
    final current = state.value;
    if (current == null || current.isStreaming) return;
    final failedId = current.failedMessageId;
    if (failedId == null) return;

    // Drop the failed assistant placeholder from the store too, so the retried
    // turn doesn't leave a stale partial assistant message persisted next to
    // the successful one.
    await _store!.deleteMessage(conversationId, failedId);
    if (!ref.mounted) return;

    // Drop the failed assistant placeholder from in-memory state and replay
    // the staged turn via retryTurn (same messageId/sessionId/envelope — plan
    // §5.4 retry = replay, never a resend).
    _setState(current.copyWith(
      messages: [
        for (final m in current.messages)
          if (m.id != failedId) m,
      ],
      isStreaming: true,
      error: null,
      failedMessageId: null,
      authRequired: false,
    ));

    await _runTurn(replay: true);
  }

  Future<void> stop() async {
    _active?.cancel();
    _active = null;
    _cancelThrottle();
    // Flush any coalesced content, then read the updated state so the partial
    // content is retained when streaming flags are cleared below.
    _flushThrottle();
    final current = state.value;
    if (current == null) return;
    _setState(current.copyWith(
      isStreaming: false,
      pendingUserMessageId: null,
    ));
    final pendingId = _pendingAssistantId;
    final partialText = pendingId != null
        ? _assistantContent(pendingId)
        : '';
    _pendingAssistantId = null;
    _pendingContent = null;
    _cancelThrottle();
    // Abandon the staged turn so a stale pending row never blocks the next
    // send (plan §3: cancel = abandon + partial retention). Best-effort: a
    // failure here must not surface as an error on a user-initiated stop.
    if (pendingId != null && ref.mounted) {
      try {
        final adapter = ref.read(managedChatAdapterProvider);
        await adapter.abandonTurn(
          conversationId,
          partialText: partialText,
        );
      } catch (_) {
        // Best-effort — the partial is already in memory; the next send will
        // surface pending_turn_exists only if the clear genuinely failed.
      }
    }
  }

  Future<void> clear() async {
    final current = state.value;
    if (current == null) return;
    _setState(current.copyWith(messages: const []));
  }

  /// Submits [text] as a background job (plan §3/P3): the service POSTs a
  /// self-contained snapshot and returns a [LedgerPollHandle] whose terminal
  /// observation appends the reply. The conversation is marked with a
  /// pending-job chip ([ConversationState.hasPendingJob]) that is cleared when
  /// the poll observes a terminal status. The in-memory user row is written by
  /// the service during admission (exactly one writer).
  Future<void> submitBackgroundJob(String text) async {
    final current = state.value;
    if (current == null || current.isStreaming || current.hasPendingJob) {
      return;
    }
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    final userMsg = Message(
      id: _uuid.v4(),
      role: MessageRole.user,
      content: trimmed,
      createdAt: DateTime.now(),
    );

    _setState(current.copyWith(
      messages: [...current.messages, userMsg],
      pendingUserMessageId: userMsg.id,
      isStreaming: true,
      error: null,
      failedMessageId: null,
      authRequired: false,
      hasPendingJob: true,
      jobError: null,
    ));

    final all = state.value?.messages ?? const <Message>[];
    final userIndex = all.lastIndexWhere((m) => m.role == MessageRole.user);
    if (userIndex < 0) {
      _setState(state.value!.copyWith(
        isStreaming: false,
        pendingUserMessageId: null,
        hasPendingJob: false,
      ));
      return;
    }
    final priorMessages = [for (var i = 0; i < userIndex; i++) all[i]];
    final expanded = await _expandMessages(priorMessages);
    final trimmedHistory = _trimmer!.trim(expanded);
    if (!ref.mounted) return;

    try {
      // Read inside the try: a `PluginReauthenticationRequired` from an
      // unavailable scope routes through _onBackgroundError as the re-auth
      // state instead of escaping as an unhandled error.
      final adapter = ref.read(managedChatAdapterProvider);
      final handle = await adapter.submitBackground(
        conversationId,
        history: trimmedHistory,
        userText: trimmed,
      );
      if (!ref.mounted) return;
      // The submission is accepted; nothing streams. Clear the streaming flags
      // (the chip + handle.done drive the rest).
      _setState(state.value!.copyWith(
        isStreaming: false,
        pendingUserMessageId: null,
      ));
      _watchBackgroundHandle(handle);
    } catch (e) {
      if (e is Error) {
        // An unexpected throw leaves the streaming flag AND the optimistic chip
        // set (nothing was submitted) — clear both so the UI is usable, then
        // rethrow so the caller keeps its text for a fresh attempt.
        final cur = state.value;
        if (cur != null && ref.mounted) {
          _setState(cur.copyWith(
            isStreaming: false,
            pendingUserMessageId: null,
            hasPendingJob: false,
            messages: [
              for (final m in cur.messages)
                if (m.id != userMsg.id) m,
            ],
          ));
        }
        rethrow;
      }
      await _onBackgroundError(e, optimisticUserId: userMsg.id);
    }
  }

  /// Re-submits the conversation's pending background job (plan §3 chip
  /// affordance): [ManagedChatAdapter.retryTurn] replays the identical envelope
  /// (same `messageId`) and the re-submission returns a fresh watch. When the
  /// pending row is already gone (`no_pending_turn`) the chip is cleared and
  /// the conversation offers a fresh send.
  Future<void> retryBackgroundJob() async {
    final current = state.value;
    if (current == null || !current.hasPendingJob) return;
    try {
      // Read inside the try: a `PluginReauthenticationRequired` from an
      // unavailable scope routes through _onBackgroundError as the re-auth
      // state instead of escaping as an unhandled error.
      final adapter = ref.read(managedChatAdapterProvider);
      final outcome = await adapter.retryTurn(conversationId);
      if (!ref.mounted) return;
      if (outcome is ManagedBackgroundResubmitted) {
        _watchBackgroundHandle(outcome.handle);
      }
    } on PluginClientException catch (e) {
      if (!ref.mounted) return;
      if (e.code == ManagedErrorCodes.noPendingTurn) {
        // The retry identity is gone — drop the chip and offer a fresh send.
        _setState(state.value!.copyWith(
          hasPendingJob: false,
          jobError: null,
        ));
        return;
      }
      await _onBackgroundError(e);
    } catch (e) {
      if (e is Error) rethrow;
      await _onBackgroundError(e);
    }
  }

  /// Cancels the conversation's pending background job (plan §3 chip
  /// affordance): [ManagedChatAdapter.abandonTurn] clears the pending row and
  /// cancels the dispatch so the next submit is never blocked. Best-effort —
  /// a failed clear surfaces `pending_turn_exists` on the next submit.
  Future<void> cancelBackgroundJob() async {
    final current = state.value;
    if (current == null || !current.hasPendingJob) return;
    try {
      await ref
          .read(managedChatAdapterProvider)
          .abandonTurn(conversationId);
    } catch (_) {
      // Best-effort — the next submit surfaces pending_turn_exists if the
      // clear genuinely failed (or the scope is unavailable).
    }
    if (!ref.mounted) return;
    _setState(state.value!.copyWith(
      hasPendingJob: false,
      jobError: null,
    ));
  }

  /// Watches a background-job [handle]: on an observed terminal status the
  /// service has already reconciled (appended the reply / cleared the marker),
  /// so the store is re-read and the chip is cleared; a `failed`/`cancelled`
  /// terminal surfaces the retry affordance via [ConversationState.jobError].
  void _watchBackgroundHandle(LedgerPollHandle handle) {
    unawaited(handle.done.then((result) async {
      if (!ref.mounted) return;
      final terminal =
          result.end == LedgerPollEnd.observed &&
          (result.task?.status.isTerminal ?? false);
      if (!terminal) {
        // Exhausted/errored poll: the job is still pending (the marker is kept
        // for an explicit retry) — keep the chip.
        return;
      }
      await _reloadFromStore();
      if (!ref.mounted) return;
      final failed = result.task?.status == LedgerTaskStatus.failed ||
          result.task?.status == LedgerTaskStatus.cancelled;
      _setState(state.value!.copyWith(
        hasPendingJob: false,
        jobError: failed ? 'Background job failed' : null,
        // A "wait for the job" banner is stale the moment the job is terminal.
        error: null,
      ));
    }).catchError((Object _) {
      // Never surface an unhandled async error from a background watch.
    }));
  }

  /// Maps a background-submission failure into state (no assistant placeholder
  /// exists on this path — the chip + error banner carry the failure). A
  /// gateway 401 surfaces the re-auth card like every other managed error.
  ///
  /// A `pending_turn_exists` rejection (or any pre-admission rejection) never
  /// admitted a user row: [optimisticUserId] — the in-memory row minted before
  /// the submit — is a phantom and is dropped so it cannot pollute a later
  /// send's history. The pending-job chip is KEPT when a genuine background
  /// envelope is pending (a running job, or a post-admission failure that kept
  /// its retry identity); otherwise it clears.
  Future<void> _onBackgroundError(
    Object error, {
    String? optimisticUserId,
  }) async {
    if (!ref.mounted) return;
    final authRequired = isAuthRequiredError(error);
    final message = switch (error) {
      // Managed codes map through the single statusPhraseForError surface
      // (the same copy voice speaks) instead of leaking the raw code.
      PluginClientException() => statusPhraseForError(error),
      _ => 'Unexpected error',
    };

    var keepChip = false;
    var dropOptimistic = false;
    try {
      keepChip = await ref
          .read(managedChatAdapterProvider)
          .hasPendingBackground(conversationId);
      if (error is PluginClientException &&
          error.code == ManagedErrorCodes.pendingTurnExists) {
        // Rejected because another pending row exists: the optimistic row was
        // never admitted — always a phantom.
        dropOptimistic = true;
      } else {
        // A kept envelope means admission ran (the real user row is persisted
        // and the optimistic row is its visible stand-in); a cleared envelope
        // means rejection before admission — the optimistic row is phantom.
        dropOptimistic = !keepChip;
      }
    } catch (_) {
      keepChip = false;
      dropOptimistic = true;
    }
    if (!ref.mounted) return;
    final cur = state.value;
    if (cur == null) return;
    _setState(cur.copyWith(
      isStreaming: false,
      pendingUserMessageId: null,
      hasPendingJob: keepChip,
      // A neutral phrase (e.g. `cancelled`) is never shown as a banner.
      error: authRequired || message.isEmpty ? null : message,
      jobError: authRequired || message.isEmpty ? null : 'Background job failed',
      authRequired: authRequired,
      messages: dropOptimistic && optimisticUserId != null
          ? [
              for (final m in cur.messages)
                if (m.id != optimisticUserId) m,
            ]
          : null,
    ));
  }

  /// Runs a single streaming turn (tools run server-side in the agent graph).
  /// [replay] routes the dispatch through `retryTurn` (identical envelope)
  /// instead of `sendTurn`.
  Future<void> _runTurn({bool replay = false}) async {
    final token = CancelToken();
    _active = token;
    try {
      await _streamOnce(token, replay: replay);
    } finally {
      _active = null;
      _cancelThrottle();
      _flushThrottle();
    }
  }

  /// Streams one turn through the managed conversation service (tools run
  /// server-side in the agent graph; no client-side tool loop or tool
  /// definitions are sent). The service owns persistence: the user message is
  /// admitted (with the pending envelope) inside [ManagedChatAdapter.sendTurn]
  /// (or replayed by [ManagedChatAdapter.retryTurn] when [replay]) and the
  /// assistant reply is written when the turn completes. This notifier only
  /// mirrors live deltas into in-memory state and refreshes
  /// ConversationState from the store once the outcome returns.
  Future<void> _streamOnce(CancelToken token, {bool replay = false}) async {
    if (!ref.mounted) return;
    // Fresh turn: drop any id adopted for a previous turn so a pre-admission
    // failure can never re-key attachments onto a stale row.
    _serviceUserMessageId = null;
    final current = state.value;
    if (current == null) return;

    // The trailing user message is the optimistic row minted in sendMessage
    // (or retained after a failed turn). The service persists it during
    // admission — never pre-persist here. history excludes it (the service
    // appends the user message itself from userText).
    final all = current.messages;
    final userIndex = all.lastIndexWhere((m) => m.role == MessageRole.user);
    if (userIndex < 0) {
      // clear() dropped the user message (or a rebuild raced): bail rather
      // than wedge isStreaming with nothing to send.
      _setState(current.copyWith(
        isStreaming: false,
        pendingUserMessageId: null,
      ));
      return;
    }
    final userMsg = all[userIndex];
    final priorMessages = [for (var i = 0; i < userIndex; i++) all[i]];

    // Expand [file:<id>] refs on the prior history; the trailing user text
    // was already describe-expanded in sendMessage (in-memory only).
    final expanded = await _expandMessages(priorMessages);
    final trimmedHistory = _trimmer!.trim(expanded);
    if (!ref.mounted) return;

    // In-memory assistant placeholder to coalesce deltas into — never
    // persisted by this notifier (the service writes the real reply).
    final assistant = Message(
      id: _uuid.v4(),
      role: MessageRole.assistant,
      content: '',
      createdAt: DateTime.now(),
    );
    _pendingAssistantId = assistant.id;
    _pendingContent = StringBuffer();
    _setState(state.value!.copyWith(
      messages: [...state.value!.messages, assistant],
    ));

    final id = conversationId;

    final ManagedTurnOutcome outcome;
    try {
      // Read inside the try: a `PluginReauthenticationRequired` from an
      // unavailable account scope (auth loading / settings errored) is routed
      // through _onError as the re-auth state instead of escaping the turn.
      final adapter = ref.read(managedChatAdapterProvider);
      outcome = replay
          ? await adapter.retryTurn(
              id,
              onContent: (text) => _onContent(assistant.id, text),
            )
          : await adapter.sendTurn(
              id,
              history: trimmedHistory,
              userText: userMsg.content,
              // sessionId omitted: the service resolves the mapped session itself
              // (first turn seeds; later turns resume/delta/compact).
              onContent: (text) => _onContent(assistant.id, text),
            );
    } catch (e) {
      // Fatal errors (StateError etc.) propagate so callers like the
      // attachment enqueue guard keep their "turn did not succeed" contract;
      // everything else is a chat-level failure surfaced via _onError.
      if (e is Error) rethrow;
      // Post-admission dispatch failures carry the admitted row's id: adopt it
      // (and re-key the optimistic in-memory row) so attachments uploaded for
      // a failed-but-persisted turn still land on the service's store row.
      if (e is ManagedTurnError) _adoptServiceUserId(e.userMessageId);
      await _onError(e, assistant.id, token);
      return;
    }
    if (!ref.mounted) return;
    _adoptServiceUserId(outcome.userMessageId);
    _flushThrottle();

    try {
      switch (outcome) {
        case ManagedAlreadyCompleted():
          // No fresh inference happened. The service ALREADY reconciled local
          // history with the server session inside _dispatch (§5) — swapping in
          // the store's now-authoritative rows here avoids a SECOND
          // loadSession + replaceHistory round-trip (which, if it failed,
          // would strand a reconcileOnly marker).
          final conversation = await _store!.loadConversation(id);
          if (!ref.mounted) return;
          _setState(state.value!.copyWith(
            messages: conversation?.messages ?? state.value!.messages,
            isStreaming: false,
            pendingUserMessageId: null,
            error: null,
            failedMessageId: null,
            authRequired: false,
          ));
        case ManagedStreamedTurn():
          // The service persisted the assistant reply; reload the
          // authoritative conversation (service-minted ids) and swap it in.
          final conversation = await _store!.loadConversation(id);
          if (!ref.mounted) return;
          _setState(state.value!.copyWith(
            messages: conversation?.messages ?? state.value!.messages,
            isStreaming: false,
            pendingUserMessageId: null,
            error: null,
            failedMessageId: null,
            authRequired: false,
          ));
        case ManagedBackgroundResubmitted():
          // sendTurn never produces a background outcome (P1c owns the
          // text/background flag); clear streaming so the UI cannot wedge.
          _setState(state.value!.copyWith(
            isStreaming: false,
            pendingUserMessageId: null,
          ));
      }
    } on PluginClientException catch (e) {
      if (e.code == ManagedErrorCodes.noPendingTurn) {
        // The pending row is already gone (abandoned/cleared) — hide the
        // retry affordance and offer a fresh send (plan §5 P1).
        _finalizeWithoutError(assistant.id);
        return;
      }
      if (e.code == ManagedErrorCodes.reconcileRequired) {
        // retryTurn hit a turn that was already reconciled: swap in the
        // server history, then the user can retry afresh (plan §5 edge case).
        try {
          // Re-read inside the nested try: a scope-unavailable rethrow routes
          // through _onError as the re-auth state.
          final serverHistory =
              await ref.read(managedChatAdapterProvider).reconcileFromServer(id);
          if (!ref.mounted) return;
          _setState(state.value!.copyWith(
            messages: serverHistory,
            isStreaming: false,
            pendingUserMessageId: null,
            error: null,
            failedMessageId: null,
            authRequired: false,
          ));
          _clearPendingStream();
          return;
        } catch (reconcileError) {
          if (reconcileError is Error) rethrow;
          await _onError(reconcileError, assistant.id, token);
          return;
        }
      }
      if (e is Error) rethrow;
      if (e is ManagedTurnError) _adoptServiceUserId(e.userMessageId);
      await _onError(e, assistant.id, token);
      return;
    } catch (e) {
      if (e is Error) rethrow;
      await _onError(e, assistant.id, token);
      return;
    }
    _clearPendingStream();
  }

  /// Finalizes a turn without surfacing an error: drops the placeholder and
  /// clears streaming flags so the UI offers a fresh send (no retry affordance).
  void _finalizeWithoutError(String assistantId) {
    final cur = state.value;
    if (cur == null) return;
    _setState(cur.copyWith(
      messages: [
        for (final m in cur.messages)
          if (m.id != assistantId) m,
      ],
      isStreaming: false,
      pendingUserMessageId: null,
      error: null,
      failedMessageId: null,
      authRequired: false,
    ));
    _clearPendingStream();
  }

  void _onContent(String assistantId, String text) {
    _pendingContent?.write(text);
    final existing = _throttle;
    if (existing != null) return;
    _throttle = Timer(const Duration(milliseconds: 80), () {
      _throttle = null;
      _flushThrottle();
    });
  }

  void _flushThrottle() {
    final id = _pendingAssistantId;
    final buffer = _pendingContent;
    if (id == null || buffer == null || !ref.mounted) return;
    final cur = state.value;
    if (cur == null) return;
    final content = buffer.toString();
    final updated = [
      for (final m in cur.messages)
        if (m.id == id) m.copyWith(content: content) else m,
    ];
    _setState(cur.copyWith(messages: updated));
  }

  String _assistantContent(String assistantId) {
    final cur = state.value;
    if (cur == null) return '';
    for (final m in cur.messages) {
      if (m.id == assistantId) {
        if (m.content.isNotEmpty) return m.content;
        // Streaming content lives in the coalescing buffer until the next
        // throttle flush; fall back to it so finalization keeps the partials.
        return _pendingContent?.toString() ?? '';
      }
    }
    return _pendingContent?.toString() ?? '';
  }

  /// Clears the auth-required flag (e.g. the user dismissed the re-auth card).
  void dismissAuthRequired() {
    final current = state.value;
    if (current == null || !current.authRequired) return;
    _setState(current.copyWith(authRequired: false));
  }

  Future<void> _onError(Object error, String assistantId, CancelToken token) async {
    if (!ref.mounted) return;
    final cur = state.value;
    if (cur == null) return;

    // A user-initiated stop cancels the token; a cancellation error from the
    // CURRENT token is suppressed (the partial content stays in place). Errors
    // from a stale, already-stopped turn are also suppressed via the token's
    // own cancelled state, so they can't be mis-attributed to a newer turn.
    if (token.isCancelled) {
      _clearPendingStream();
      return;
    }

    // A `cancelled` PluginClientException from the managed service with the
    // local token still live (e.g. a mid-stream abandon that raced the
    // stream, or a scope epoch bump) is a silent finalization, not an error:
    // stop() already settled the streaming flags and kept the partial.
    if (error is PluginClientException && error.code == ManagedErrorCodes.cancelled) {
      _upsertPartial(assistantId, _assistantContent(assistantId));
      _setState(state.value!.copyWith(
        isStreaming: false,
        pendingUserMessageId: null,
        error: null,
        failedMessageId: null,
        authRequired: false,
      ));
      _clearPendingStream();
      return;
    }

    // `no_pending_turn` from a replay against an already-cleared staged row:
    // finalize silently — the retry affordance must not linger with no row
    // behind it (plan §5 P1: hide retry, offer a fresh send).
    if (error is PluginClientException && error.code == ManagedErrorCodes.noPendingTurn) {
      _finalizeWithoutError(assistantId);
      return;
    }

    // A gateway 401 means the API key is missing/invalid: surface the distinct
    // auth-required state (the UI renders the re-auth card) instead of a
    // generic error message. Managed auth codes map through the same helper.
    final authRequired = isAuthRequiredError(error);

    // A failed turn can leave a staged pending row (post-admission failures
    // keep it). Surface once with an abandonTurn escape (plan §5 P1): the
    // abandon clears the row so the next send/retry is not wedged, then the
    // banner tells the user the in-progress reply was stopped. A BACKGROUND
    // pending row is exempt: abandoning it would destroy a still-running job —
    // its poller watch hits the `pending == null` guard and silently loses the
    // reply. In that case the marker (chip) is kept, the optimistic user row +
    // placeholder are dropped, and the error tells the user to wait.
    if (error is PluginClientException && error.code == ManagedErrorCodes.pendingTurnExists) {
      try {
        final adapter = ref.read(managedChatAdapterProvider);
        final cleared = await adapter.abandonTurnKeepingBackground(
          conversationId,
        );
        if (!ref.mounted) return;
        if (cleared) {
          _upsertPartial(assistantId, _assistantContent(assistantId));
          _setState(state.value!.copyWith(
            isStreaming: false,
            // Same copy surface as the mapper: the pending turn was
            // abandoned, so this is the only special case the branch keeps —
            // the abandonTurn action itself.
            error: statusPhraseForError(error),
            pendingUserMessageId: null,
            failedMessageId: assistantId,
            authRequired: false,
          ));
        } else {
          // A background job is genuinely pending: keep the chip, drop the
          // never-admitted optimistic user row + empty placeholder, and tell
          // the user to wait for the job instead of claiming it was stopped.
          final cur = state.value;
          if (cur != null) {
            final lastUserIndex =
                cur.messages.lastIndexWhere((m) => m.role == MessageRole.user);
            _setState(cur.copyWith(
              messages: [
                for (var i = 0; i < cur.messages.length; i++)
                  if (i != lastUserIndex && cur.messages[i].id != assistantId)
                    cur.messages[i],
              ],
              isStreaming: false,
              error:
                  'A background job is still running — wait for it to finish.',
              pendingUserMessageId: null,
              failedMessageId: null,
              authRequired: false,
              hasPendingJob: true,
            ));
          }
        }
      } catch (_) {
        // Best-effort escape hatch; still surface the message.
        _upsertPartial(assistantId, _assistantContent(assistantId));
        _setState(state.value!.copyWith(
          isStreaming: false,
          error: statusPhraseForError(error),
          pendingUserMessageId: null,
          failedMessageId: assistantId,
          authRequired: false,
        ));
      }
      _clearPendingStream();
      return;
    }

    final message = switch (error) {
      // The legacy Chat* surface routes through the single
      // statusPhraseForError copy (the same copy voice speaks) instead of
      // leaking raw message text as banner copy.
      ChatApiError() => statusPhraseForError(error),
      DioException() => 'Network error',
      // Managed-service failures map their code through the single
      // statusPhraseForError surface (the same copy voice speaks) instead of
      // leaking the raw code as banner text.
      PluginClientException() => statusPhraseForError(error),
      _ => 'Unexpected error',
    };

    if (error is ChatNetworkError || error is DioException) {
      ref.read(networkStatusProvider.notifier).set(NetworkStatus.disconnected);
    }

    // Keep partial content in memory only: the service owns assistant-row
    // persistence (the placeholder was never written), so there is no row to
    // update here. stop() hands the partial to abandonTurn for persistence.
    _upsertPartial(assistantId, _assistantContent(assistantId));

    _setState(state.value!.copyWith(
      isStreaming: false,
      error: authRequired ? null : message,
      pendingUserMessageId: null,
      failedMessageId: assistantId,
      authRequired: authRequired,
    ));
    _clearPendingStream();
  }

  /// Writes [partialContent] into the in-memory assistant placeholder for
  /// [assistantId] (creating it if the row vanished) so the partial survives
  /// finalization after an error/abandon. Never touches the store — the
  /// service owns assistant-row persistence.
  void _upsertPartial(String assistantId, String partialContent) {
    final cur = state.value;
    if (cur == null) return;
    final updated = <Message>[];
    var hasAssistant = false;
    for (final m in cur.messages) {
      if (m.id == assistantId) {
        hasAssistant = true;
        updated.add(m.copyWith(content: partialContent));
      } else {
        updated.add(m);
      }
    }
    if (!hasAssistant) {
      updated.add(Message(
        id: assistantId,
        role: MessageRole.assistant,
        content: partialContent,
        createdAt: DateTime.now(),
      ));
    }
    _setState(cur.copyWith(messages: updated));
  }

  /// Clears the coalescing stream bookkeeping (buffer + throttle timer).
  void _clearPendingStream() {
    _pendingAssistantId = null;
    _pendingContent = null;
    _cancelThrottle();
  }

  /// Cancels any pending coalescing timer. Flushing a stale turn's buffer into
  /// a later turn's placeholder must never happen, so every path that clears
  /// the pending stream state also cancels the timer.
  void _cancelThrottle() {
    _throttle?.cancel();
    _throttle = null;
  }

  void _setState(ConversationState next) {
    if (!ref.mounted) return;
    state = AsyncData(next);
  }
}

/// Provides the [ContextTrimmer] used to enforce the token budget.
final contextTrimmerProvider = Provider<ContextTrimmer>(
  (ref) => const ContextTrimmer(),
);

/// Fires when the underlying database is ready (via the chat store provider).
final databaseReadyProvider = Provider<Future<void>>(
  (ref) async {
    await ref.watch(chatStoreProvider).watchConversations().first;
  },
);

/// State notifier for a single conversation, keyed by conversation id.
final conversationProvider =
    AsyncNotifierProvider.autoDispose
        .family<ConversationNotifier, ConversationState, String>(
          ConversationNotifier.new,
        );

/// Stream of all conversations, ordered most-recently-updated first.
final conversationsProvider = StreamProvider.autoDispose<List<Conversation>>(
  (ref) => ref.watch(chatStoreProvider).watchConversations(),
);
