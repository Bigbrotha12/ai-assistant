import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/chat_client.dart';
import '../../core/chat_client_provider.dart';
import 'chat_store.dart';
import 'context_trimmer.dart';
import 'database_providers.dart';
import 'message_model.dart';
import 'tool_executor.dart';

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

  const ConversationState({
    required this.messages,
    this.isStreaming = false,
    this.error,
    this.pendingUserMessageId,
    this.failedMessageId,
    this.isDbReady = false,
  });

  ConversationState copyWith({
    List<Message>? messages,
    bool? isStreaming,
    Object? error = _sentinel,
    Object? pendingUserMessageId = _sentinel,
    Object? failedMessageId = _sentinel,
    bool? isDbReady,
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
      isDbReady: isDbReady ?? this.isDbReady,
    );
  }
}

const Object _sentinel = Object();

const kSystemPrompt =
    'You are a helpful voice assistant running on the user\'s self-hosted home AI stack. Be concise in casual chat but thorough when asked. You can call tools when they help. If a tool fails, say so plainly and offer alternatives.';

/// Drives the chat UI for a single conversation, streaming LLM completions and
/// executing tools. Riverpod 3 family notifier; the conversation id is passed
/// via the constructor from the provider's create function.
class ConversationNotifier extends AsyncNotifier<ConversationState> {
  ConversationNotifier(this.conversationId);

  final String conversationId;

  final _uuid = const Uuid();

  /// Cancel token for the in-flight request.
  CancelToken? _active;

  /// Text of the most recent user message, kept for retry().
  String? _lastUserText;

  /// Cancellation state of the in-flight turn is derived from the active
  /// [CancelToken] (see [stop] / [_onError]) rather than a bare bool, so a
  /// stale cancellation from a previous (stopped) turn can never be
  /// mis-attributed to a newer turn that is running fine.

  /// Coalesces streamed content deltas into ~80ms batched state updates.
  Timer? _throttle;
  String? _pendingAssistantId;
  StringBuffer? _pendingContent;

  ChatStore? _store;
  ChatClient? _client;
  ContextTrimmer? _trimmer;
  ToolRegistry? _registry;

  @override
  Future<ConversationState> build() async {
    _store = ref.watch(chatStoreProvider);
    _client = ref.watch(chatApiClientProvider);
    _trimmer = ref.watch(contextTrimmerProvider);
    _registry = ref.watch(toolRegistryProvider);

    // Wait for the database to be ready before loading messages.
    await ref.watch(databaseReadyProvider);
    if (!ref.mounted) return const ConversationState(messages: []);

    ref.onDispose(() {
      _active?.cancel();
      _throttle?.cancel();
    });

    final conversation = await _store!.loadConversation(conversationId);
    if (!ref.mounted) return const ConversationState(messages: []);

    return ConversationState(
      messages: conversation?.messages ?? const [],
      isDbReady: true,
    );
  }

  Future<void> sendMessage(String text) async {
    final current = state.value;
    if (current == null || current.isStreaming) return;

    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    _lastUserText = trimmed;

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
    ));

    // Brand-new conversations need their row created first (the message row's
    // FK references it), with a title derived from the first user message.
    final existing = await _store!.loadConversation(conversationId);
    if (!ref.mounted) return;

    if (existing == null) {
      final title = trimmed.length <= 60
          ? trimmed
          : '${trimmed.substring(0, 60)}…';
      await _store!.saveConversation(Conversation(
        id: conversationId,
        title: title,
        messages: [userMsg],
        createdAt: userMsg.createdAt ?? DateTime.now(),
        updatedAt: DateTime.now(),
      ));
    } else {
      await _store!.appendMessage(conversationId, userMsg);
    }
    if (!ref.mounted) return;

    await _runTurn();
  }

  Future<void> retry() async {
    final current = state.value;
    if (current == null || current.isStreaming) return;
    final failedId = current.failedMessageId;
    final lastText = _lastUserText;
    if (failedId == null || lastText == null) return;

    // Drop the failed assistant placeholder from the store too, so the retried
    // turn doesn't leave a stale partial assistant message persisted next to
    // the successful one.
    await _store!.deleteMessage(conversationId, failedId);
    if (!ref.mounted) return;

    // Drop the failed assistant placeholder from in-memory state and re-run
    // the last send.
    _setState(current.copyWith(
      messages: [
        for (final m in current.messages)
          if (m.id != failedId) m,
      ],
      isStreaming: true,
      error: null,
      failedMessageId: null,
    ));

    await _runTurn();
  }

  Future<void> stop() async {
    _active?.cancel();
    _active = null;
    _throttle?.cancel();
    _throttle = null;
    // Flush any coalesced content, then read the updated state so the partial
    // content is retained when streaming flags are cleared below.
    _flushThrottle();
    final current = state.value;
    if (current == null) return;
    _setState(current.copyWith(
      isStreaming: false,
      pendingUserMessageId: null,
    ));
    // Persist whatever partial content exists.
    final pendingId = _pendingAssistantId;
    if (pendingId != null && ref.mounted) {
      final messages = state.value?.messages ?? const <Message>[];
      final partial = messages.where((m) => m.id == pendingId).toList();
      if (partial.isNotEmpty) {
        await _store!.updateMessage(conversationId, partial.first);
      }
    }
    _pendingAssistantId = null;
    _pendingContent = null;
  }

  Future<void> clear() async {
    final current = state.value;
    if (current == null) return;
    _setState(current.copyWith(messages: const []));
  }

  /// Runs one or more streaming turns, dispatching tools between calls.
  Future<void> _runTurn() async {
    final token = CancelToken();
    _active = token;
    try {
      await _streamOnce(token);
    } finally {
      _active = null;
      _throttle?.cancel();
      _throttle = null;
      _flushThrottle();
    }
  }

  Future<void> _streamOnce(CancelToken token) async {
    for (var toolIteration = 0; toolIteration < 5; toolIteration++) {
      if (!ref.mounted) return;
      final current = state.value;
      if (current == null) return;

      // Rebuild API messages from the current state each iteration so the
      // assistant tool_calls + tool results are included after dispatch. The
      // in-flight assistant placeholder is NOT part of the request history.
      final trimmed = _trimmer!.trim(current.messages);
      final messagesForCall = toApiMessages(trimmed);

      // Fresh assistant placeholder per turn, so tool-loop iterations each get
      // their own message to stream into.
      final assistant = Message(
        id: _uuid.v4(),
        role: MessageRole.assistant,
        content: '',
        createdAt: DateTime.now(),
      );
      _pendingAssistantId = assistant.id;
      _pendingContent = StringBuffer();

      _setState(current.copyWith(
        messages: [...current.messages, assistant],
      ));

      ChatResult result;
      try {
        result = await _client!.streamCompletions(
          messages: messagesForCall,
          systemPrompt: kSystemPrompt,
          tools: _registry!.toolDefinitions,
          onContent: (text) => _onContent(assistant.id, text),
          cancelToken: token,
        );
      } catch (e) {
        await _onError(e, assistant.id, token);
        return;
      }
      if (!ref.mounted) return;

      final hasToolCalls = result.toolCalls.isNotEmpty;

      // Push any coalesced streaming content into state before finalizing.
      _flushThrottle();

      var finalized = assistant.copyWith(content: result.content);
      if (hasToolCalls) {
        finalized = finalized.copyWith(toolCalls: result.toolCalls);
      }
      await _store!.updateMessage(conversationId, finalized);
      if (!ref.mounted) return;

      final messages = [
        for (final m in state.value!.messages)
          if (m.id == assistant.id) finalized else m,
      ];
      _setState(state.value!.copyWith(messages: messages));

      if (!hasToolCalls) {
        // Done: 'stop' (or any non-tool finish).
        _setState(state.value!.copyWith(
          isStreaming: false,
          pendingUserMessageId: null,
          error: null,
          failedMessageId: null,
        ));
        _pendingAssistantId = null;
        _pendingContent = null;
        return;
      }

      // Execute tools sequentially and feed results back.
      for (final call in result.toolCalls) {
        final toolResult =
            await _registry!.dispatch(call.name, call.args ?? const {});
        if (!ref.mounted) return;
        final toolMsg = Message(
          id: _uuid.v4(),
          role: MessageRole.tool,
          content: toolResult.message,
          toolCallId: call.id,
          createdAt: DateTime.now(),
        );
        final cur = state.value!;
        await _store!.appendMessage(conversationId, toolMsg);
        if (!ref.mounted) return;
        _setState(cur.copyWith(messages: [...cur.messages, toolMsg]));
      }

      // Re-enter the loop with the now-longer history to request the model's
      // next turn. Cap the tool loop to avoid runaway tool chaining.
      if (toolIteration == 4) {
        final cap = Message(
          id: _uuid.v4(),
          role: MessageRole.assistant,
          content: 'Reached the tool-call limit',
          createdAt: DateTime.now(),
        );
        await _store!.appendMessage(conversationId, cap);
        if (!ref.mounted) return;
        _setState(state.value!.copyWith(
          messages: [...state.value!.messages, cap],
          isStreaming: false,
          pendingUserMessageId: null,
          error: null,
          failedMessageId: null,
        ));
        _pendingAssistantId = null;
        _pendingContent = null;
        return;
      }
    }
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

  Future<void> _onError(Object error, String assistantId, CancelToken token) async {
    if (!ref.mounted) return;
    final cur = state.value;
    if (cur == null) return;

    // A user-initiated stop cancels the token; a cancellation error from the
    // CURRENT token is suppressed (the partial content stays in place). Errors
    // from a stale, already-stopped turn are also suppressed via the token's
    // own cancelled state, so they can't be mis-attributed to a newer turn.
    if (token.isCancelled) {
      _pendingAssistantId = null;
      _pendingContent = null;
      return;
    }

    final message = switch (error) {
      ChatApiError(:final message) => message,
      DioException() => 'Network error',
      _ => 'Unexpected error',
    };

    // Keep partial content; persist it.
    final partialContent = _assistantContent(assistantId);
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
    var messages = updated;
    if (!hasAssistant) {
      messages = [
        ...messages,
        Message(
          id: assistantId,
          role: MessageRole.assistant,
          content: partialContent,
          createdAt: DateTime.now(),
        ),
      ];
    }

    await _store!.updateMessage(conversationId,
        messages.firstWhere((m) => m.id == assistantId));
    if (!ref.mounted) return;

    _setState(cur.copyWith(
      messages: messages,
      isStreaming: false,
      error: message,
      pendingUserMessageId: null,
      failedMessageId: assistantId,
    ));
    _pendingAssistantId = null;
    _pendingContent = null;
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

/// Provides the default [ToolRegistry].
final toolRegistryProvider = Provider<ToolRegistry>(
  (ref) => buildDefaultToolRegistry(),
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
