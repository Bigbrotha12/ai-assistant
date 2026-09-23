import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network_banner.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/ui/chat_providers.dart';
import '../../chat/data/database_providers.dart';
import '../../chat/data/message_model.dart';
import '../../plugins/data/managed_chat_providers.dart';
import '../../plugins/data/managed_conversation_service.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../plugins/data/plugin_http.dart';
import '../../plugins/data/staged_inference_adapters.dart';
import '../data/audio_playback_service.dart';
import '../data/engine_manager_provider.dart';
import '../data/mic_capture_service.dart';
import '../data/screen_wake_lock.dart';
import '../data/voice_capture_providers.dart';
import './voice_conversation_state.dart';
import './voice_controller.dart';

/// Provider-facing send seam (plan P2): same as [VoiceTurnSender] but
/// conversation-id aware — the notifier resolves the id captured at turn
/// start and passes it in, so a mid-turn conversation switch can never reroute
/// the managed send. Tests override this with a scripted sender; the
/// production implementation routes through
/// `StagedInferenceAdapters.sendVoiceTurn`.
typedef VoiceManagedTurnSender = Future<ChatResult> Function({
  required String conversationId,
  required List<ApiMessage> messages,
  required String userText,
  String? systemPrompt,
  CancelToken? cancelToken,
  void Function()? onReceived,
  void Function(String text)? onContent,
  void Function(int index, String name, String argsFragment)? onToolCallDelta,
});

/// Production managed voice sender (plan P2): `sendVoiceTurn` over the
/// staged adapters — same per-send construction, single-writer persistence,
/// and `configuration_changed` freeze as text. Reads the adapters LAZILY per
/// turn: the controller must build while [pluginAccountScopeProvider] is
/// still loading (cold boot) and every turn picks up the current account's
/// instance. [messages]/[systemPrompt]/[onReceived]/[onToolCallDelta] are
/// accepted for seam parity but unused — the managed path loads history
/// through the service, the backend owns the system prompt, and
/// `managedTurn` streams content deltas only (no ack/tool-fragment hooks;
/// StatusTracker falls back to first-content).
final voiceTurnSenderProvider = Provider<VoiceManagedTurnSender>((ref) {
  return ({
    required conversationId,
    required messages,
    required userText,
    systemPrompt,
    cancelToken,
    onReceived,
    onContent,
    onToolCallDelta,
  }) async {
    final StagedInferenceAdapters adapters;
    try {
      adapters = ref.read(stagedInferenceAdaptersProvider);
    } on PluginReauthenticationRequired {
      // Map to the P1 auth-mapper code so the voice screen's re-auth card
      // fires (isAuthRequiredError matches PluginClientException codes).
      throw const PluginClientException(ManagedErrorCodes.unauthorized);
    }
    final outcome = await adapters.sendVoiceTurn(
      conversationId,
      userText: userText,
      cancelToken: cancelToken,
      onContent: onContent,
    );
    if (outcome is ManagedStreamedTurn) return outcome.result;
    // ManagedAlreadyCompleted: the turn already ran and the service
    // reconciled history as part of the outcome — no fresh content to speak.
    return const ChatResult(content: '', toolCalls: [], finishReason: 'stop');
  };
});

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
/// The controller's LLM leg is wired to [voiceTurnSenderProvider] — the
/// managed `sendVoiceTurn` path (plan P2) — resolved lazily per turn, so a
/// scope/auth change is picked up on the next send without rebuilding (and
/// without the build-time scope-provider throw that watching it would cause
/// on cold boot).
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

  /// Conversation id captured at turn start ([onUserMessage]). The managed
  /// sender and the barge-in abandon closure both key off this id, so
  /// switching the active conversation mid-stream can never reroute a turn's
  /// send or cleanup across two conversations. Fall back to [ensure] when
  /// null (a text turn started before any capture).
  String? _turnConversationId;

  /// Serialises handoff-bound persistence flushes. The managed service owns
  /// all turn writes now (plan P2 single-writer), so no per-turn enqueues
  /// remain — the tail stays because [flushPersistence] is the chat-handoff
  /// and account-lifecycle contract (callers await it before re-reading the
  /// scoped store).
  final Future<void> _persistTail = Future.value();

  /// Awaits the queued persistence writes to drain. Called before handing off
  /// to the chat screen so the conversation loaded there includes every
  /// message persisted by voice turns (the chat notifier reads the store once
  /// on build; a racing un-flushed write would be missing from that load).
  Future<void> flushPersistence() => _persistTail;

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
    // Managed send seam (plan P2): stable identity (the provider watches
    // nothing scope-reactive), with the staged adapters read per turn inside.
    final managedSend = ref.watch(voiceTurnSenderProvider);
    // The controller owns its per-turn cancel token (interrupt() cancels and
    // replaces it) and cancels it in dispose(); nothing to abort here.
    final controller = VoiceController(
      sendTurn: ({
        required messages,
        required userText,
        systemPrompt,
        cancelToken,
        onReceived,
        onContent,
        onToolCallDelta,
      }) {
        if (!ref.mounted) {
          throw const PluginClientException(ManagedErrorCodes.cancelled);
        }
        // Captured at onUserMessage (fired before the seam runs): a mid-turn
        // conversation switch can never reroute this turn's managed send.
        final conversationId =
            _turnConversationId ??
            ref.read(activeConversationIdProvider.notifier).ensure();
        return managedSend(
          conversationId: conversationId,
          messages: messages,
          userText: userText,
          systemPrompt: systemPrompt,
          cancelToken: cancelToken,
          onReceived: onReceived,
          onContent: onContent,
          onToolCallDelta: onToolCallDelta,
        );
      },
      abandonActiveTurn: () async {
        if (!ref.mounted) return;
        final conversationId = _turnConversationId;
        if (conversationId == null) return;
        try {
          // Shared with the text stop() path: clears the pending row under
          // the current epoch and cancels the conversation's dispatch token
          // (no epoch bump). partialText null → clear-only; voice drops its
          // partial on barge-in (legacy UX).
          await ref
              .read(managedChatAdapterProvider)
              .abandonTurn(conversationId, partialText: null);
        } catch (_) {
          // Best-effort — mirrors chat stop(); never surfaces as a banner.
        }
      },
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
        // Capture the turn's conversation id — the only per-turn hook the
        // provider keeps: the managed service owns the row writes (plan P2
        // single-writer), so no persistence is enqueued here.
        _turnConversationId =
            ref.read(activeConversationIdProvider.notifier).ensure();
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
