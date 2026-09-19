import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../chat/data/chat_client_provider.dart';
import '../../../core/network_banner.dart';
import '../../chat/ui/chat_providers.dart';
import '../../chat/data/database_providers.dart';
import '../../chat/data/message_model.dart';
import '../data/audio_playback_service.dart';
import '../data/engine_manager_provider.dart';
import '../data/mic_capture_service.dart';
import '../data/screen_wake_lock.dart';
import '../data/voice_capture_providers.dart';
import './voice_conversation_state.dart';
import './voice_controller.dart';

/// Microphone capture streaming raw PCM16 chunks.
final micCaptureServiceProvider = Provider<MicCaptureService>((ref) {
  final service = RecordMicCaptureService();
  ref.onDispose(service.dispose);
  return service;
});

/// Audio playback of received AI TTS frames.
///
/// Typed as [AudioPlayback] so tests can substitute an in-memory fake without
/// bootstrapping a real audio player.
final audioPlaybackServiceProvider = Provider<AudioPlayback>((ref) {
  final service = AudioPlaybackService(
    audioSession: ref.watch(audioSessionManagerProvider),
  );
  ref.onDispose(service.dispose);
  return service;
});

/// Owns the [VoiceController] for the current (or next) conversation.
///
/// Rebuilds when backend auth credentials change: watching
/// [chatApiClientProvider] keeps a fresh controller wired to the shared chat
/// client (the inference target is fixed at build time via the `LLM_*`
/// dart-defines — see AGENTS.md).
final voiceControllerProvider =
    NotifierProvider<VoiceControllerNotifier, VoiceController>(
      VoiceControllerNotifier.new,
    );

/// Keeps the screen awake for the lifetime of a connected voice conversation.
final screenWakeLockProvider = Provider<ScreenWakeLock>((ref) {
  final lock = PlatformScreenWakeLock();
  ref.onDispose(() => unawaited(lock.disable()));
  return lock;
});

class VoiceControllerNotifier extends Notifier<VoiceController> {
  void Function()? _enginesListener;

  final _uuid = const Uuid();

  /// Conversation id captured at turn start ([onUserMessage]). The user
  /// message and — seconds later — the assistant reply both persist into this
  /// id, so switching the active conversation mid-stream can never split a
  /// turn across two conversations (the reply always follows its user message;
  /// a missing row in a switched-to conversation can never swallow it either).
  /// Fall back to [ensure] when null (a text turn started before any capture).
  String? _turnConversationId;

  /// Serialises persistence writes so a first-turn row creation and the user /
  /// reply appends can never interleave (two concurrent first turns could
  /// clobber via a full-message-list overwrite). Each link swallows errors so
  /// one failure never wedges the chain.
  Future<void> _persistTail = Future.value();

  /// Appends [action] onto [_persistTail], fire-and-forget. The caller must
  /// not await it: persistence runs serially in the background.
  void _enqueuePersist(Future<void> Function() action) {
    _persistTail = _persistTail.then((_) => action()).catchError((_) {});
  }

  /// Awaits the queued persistence writes to drain. Called before handing off
  /// to the chat screen so the conversation loaded there includes every
  /// message persisted by voice turns (the chat notifier reads the store once
  /// on build; a racing un-flushed write would be missing from that load).
  Future<void> flushPersistence() => _persistTail;

  /// Persists the user message into [conversationId], creating the
  /// conversation row (with a title from the first user text) when absent.
  /// The id is captured at call time: the caller enqueues persistence with the
  /// conversation that was active when the turn STARTED, so a later
  /// conversation switch can never reroute this turn's writes.
  Future<void> _persistUserMessage(
    String conversationId,
    String userText,
  ) async {
    if (!ref.mounted) return;
    final store = ref.read(chatStoreProvider);
    final existing = await store.loadConversation(conversationId);
    if (existing == null) {
      final now = DateTime.now();
      final title = userText.length <= 60
          ? userText
          : '${userText.substring(0, 60)}…';
      // ensureConversation (not saveConversation, a full-message-list
      // overwrite) so a concurrent first-turn write from the chat surface on
      // the same conversation id can never clobber this one.
      await store.ensureConversation(
        conversationId,
        title: title,
        firstMessage: Message(
          id: _uuid.v4(),
          role: MessageRole.user,
          content: userText,
          createdAt: now,
        ),
      );
    } else {
      await store.appendMessage(conversationId, Message(
        id: _uuid.v4(),
        role: MessageRole.user,
        content: userText,
        createdAt: DateTime.now(),
      ));
    }
  }

  /// Persists the assistant reply into [conversationId]. Runs after the user
  /// message on [_persistTail], so the conversation row always exists.
  Future<void> _persistAssistantReply(
    String conversationId,
    String reply,
  ) async {
    if (!ref.mounted) return;
    final store = ref.read(chatStoreProvider);
    await store.appendMessage(conversationId, Message(
      id: _uuid.v4(),
      role: MessageRole.assistant,
      content: reply,
      createdAt: DateTime.now(),
    ));
  }

  /// Builds the full request message list for a turn: trimmed conversation
  /// history (from the turn's conversation) plus the new user message.
  Future<List<ApiMessage>> _buildRequestMessages(String userText) async {
    if (!ref.mounted) return [ApiMessage(role: 'user', content: userText)];
    final store = ref.read(chatStoreProvider);
    final id =
        _turnConversationId ??
        ref.read(activeConversationIdProvider.notifier).ensure();
    final conversation = await store.loadConversation(id);
    final messages = conversation?.messages ?? const <Message>[];
    final trimmed = ref.read(contextTrimmerProvider).trim(messages);
    final result = [...toApiMessages(trimmed)];
    // The user message persist can land before this builder reads the DB, so
    // the loaded history may already end with the very message being sent —
    // appending it again would send the user text to the LLM twice. Skip the
    // append only when the tail already carries this exact turn's text.
    final last = trimmed.isNotEmpty ? trimmed.last : null;
    final alreadyPresent =
        last != null && last.role == MessageRole.user && last.content == userText;
    if (!alreadyPresent) {
      result.add(ApiMessage(role: 'user', content: userText));
    }
    return result;
  }

  @override
  VoiceController build() {
    final engineManager = ref.watch(engineManagerProvider);
    final sttEngine = engineManager.sttEngine;
    final ttsEngine = engineManager.ttsEngine;
    // Watch the trimmer so it is part of this notifier's dependency graph; the
    // context builder itself reads it at call time (never captured).
    ref.watch(contextTrimmerProvider);
    // The controller owns its per-turn cancel token (interrupt() cancels and
    // replaces it) and cancels it in dispose(); nothing to abort here.
    final controller = VoiceController(
      chatClient: ref.watch(chatApiClientProvider),
      micCapture: ref.read(micCaptureServiceProvider),
      playback: ref.read(audioPlaybackServiceProvider),
      screenWakeLock: ref.watch(screenWakeLockProvider),
      sttEngine: sttEngine,
      ttsEngine: ttsEngine,
      onNetworkError: () {
        if (!ref.mounted) return;
        ref.read(networkStatusProvider.notifier).set(NetworkStatus.disconnected);
      },
      onUserMessage: (userText) {
        if (!ref.mounted) return;
        _turnConversationId =
            ref.read(activeConversationIdProvider.notifier).ensure();
        // Capture the id now: the queued write may not run until after a later
        // conversation switch, and it must target the conversation this turn
        // started in.
        final turnId = _turnConversationId!;
        _enqueuePersist(() => _persistUserMessage(turnId, userText));
      },
      onTranscript: (reply) {
        if (!ref.mounted) return;
        // The user message enqueue ran before this reply's enqueue, so
        // [_turnConversationId] is set and still points at this turn's
        // conversation. Capture it now so a later conversation switch cannot
        // reroute this reply's write.
        final turnId = _turnConversationId!;
        _enqueuePersist(() => _persistAssistantReply(turnId, reply));
      },
      contextBuilder: (userText) => _buildRequestMessages(userText),
    );

    // Engines register asynchronously (model-dir resolution happens on a
    // background task). If they haven't landed by the time the controller is
    // built, inject them into the live controller once they do. Rebuilding
    // here (invalidateSelf) instead would cascade into the capture pipeline
    // and tear down an in-flight hold-to-talk mid-session, dropping the
    // buffered utterance and wedging the UI in "listening" state.
    if (sttEngine == null || ttsEngine == null) {
      _enginesListener = () {
        final manager = ref.read(engineManagerProvider);
        controller.sttEngine ??= manager.sttEngine;
        controller.ttsEngine ??= manager.ttsEngine;
        // Both engines landed: nothing left to inject, so stop listening —
        // a standing no-op listener per session would otherwise pile up.
        if (controller.sttEngine != null && controller.ttsEngine != null) {
          engineManager.removeListener(_enginesListener!);
          _enginesListener = null;
        }
      };
      engineManager.addListener(_enginesListener!);
    }

    ref.onDispose(() {
      if (_enginesListener != null) {
        engineManager.removeListener(_enginesListener!);
        _enginesListener = null;
      }
      unawaited(controller.dispose());
    });
    return controller;
  }
}

/// Reactive view of the current conversation's state.
final voiceConversationStateProvider =
    NotifierProvider<VoiceStateNotifier, VoiceConversationState>(
      VoiceStateNotifier.new,
    );

class VoiceStateNotifier extends Notifier<VoiceConversationState> {
  StreamSubscription<VoiceConversationState>? _subscription;

  @override
  VoiceConversationState build() {
    final controller = ref.watch(voiceControllerProvider);
    final previous = _subscription;
    _subscription = controller.stateStream.listen(
      (state) => this.state = state,
    );
    if (previous != null) {
      unawaited(previous.cancel());
    }
    ref.onDispose(() {
      final sub = _subscription;
      _subscription = null;
      if (sub != null) {
        unawaited(sub.cancel());
      }
    });
    return controller.state;
  }
}
