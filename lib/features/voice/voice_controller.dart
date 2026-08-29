import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/chat_client.dart';
import '../chat/message_model.dart';
import 'audio_playback_service.dart';
import 'mic_capture_service.dart';
import 'stt_engine.dart';
import 'tts_engine.dart';

/// Snapshot of a voice conversation's state, used to drive the UI.
///
/// The conversation is turn-based and TEXT-only: on-device STT turns the
/// recognised utterance into text, the [ChatClient] produces a text reply,
/// and on-device TTS turns that reply into audible speech. No raw audio ever
/// crosses the network, so there is no room / JWT / data-channel concept.
class VoiceConversationState {
  const VoiceConversationState({
    this.isConnected = false,
    this.isRecording = false,
    this.isAiSpeaking = false,
    this.isPaused = false,
    this.error,
    this.lastTranscript,
    this.onDeviceTranscript,
  });

  factory VoiceConversationState.initial() => const VoiceConversationState();

  /// Whether the text conversation session is active (i.e. [startConversation]
  /// has been invoked and [endConversation] has not). Capture is only allowed
  /// while the session is active.
  final bool isConnected;

  /// Whether microphone audio is being captured for on-device STT.
  final bool isRecording;

  /// Whether TTS audio from the AI is currently playing back.
  final bool isAiSpeaking;

  /// Whether the session is suspended by an OS audio interruption (e.g. a
  /// phone call or alarm). Recording and playback halt while true.
  final bool isPaused;

  /// Description of the last failure (null when healthy). Stored as the
  /// original thrown object so UI layers can classify it by type where a
  /// sealed [EngineError] is available, falling back to [toString] otherwise.
  final Object? error;

  /// The assistant's last reply text, streamed incrementally by the LLM and
  /// finalised once the turn completes (null when no reply has been produced
  /// yet). This replaces the old server transcript echo.
  final String? lastTranscript;

  /// Transcript produced by the on-device STT engine for the last recognised
  /// user utterance (null when no local engine is active or nothing has been
  /// transcribed yet).
  final String? onDeviceTranscript;

  VoiceConversationState copyWith({
    bool? isConnected,
    bool? isRecording,
    bool? isAiSpeaking,
    bool? isPaused,
    Object? error = _unset,
    Object? lastTranscript = _unset,
    Object? onDeviceTranscript = _unset,
  }) => VoiceConversationState(
    isConnected: isConnected ?? this.isConnected,
    isRecording: isRecording ?? this.isRecording,
    isAiSpeaking: isAiSpeaking ?? this.isAiSpeaking,
    isPaused: isPaused ?? this.isPaused,
    error: identical(error, _unset) ? this.error : error,
    lastTranscript: identical(lastTranscript, _unset)
        ? this.lastTranscript
        : lastTranscript as String?,
    onDeviceTranscript: identical(onDeviceTranscript, _unset)
        ? this.onDeviceTranscript
        : onDeviceTranscript as String?,
  );

  static const Object _unset = Object();

  @override
  bool operator ==(Object other) =>
      other is VoiceConversationState &&
      other.isConnected == isConnected &&
      other.isRecording == isRecording &&
      other.isAiSpeaking == isAiSpeaking &&
      other.isPaused == isPaused &&
      other.error == error &&
      other.lastTranscript == lastTranscript &&
      other.onDeviceTranscript == onDeviceTranscript;

  @override
  int get hashCode => Object.hash(
    isConnected,
    isRecording,
    isAiSpeaking,
    isPaused,
    error,
    lastTranscript,
    onDeviceTranscript,
  );

  @override
  String toString() =>
      'VoiceConversationState(connected: $isConnected, '
      'recording: $isRecording, aiSpeaking: $isAiSpeaking, paused: $isPaused, '
      'error: $error, '
      'transcript: $lastTranscript, deviceTranscript: $onDeviceTranscript)';
}

/// Orchestrates a turn-based text voice conversation.
///
/// Wires the mic capture (on-device STT), the textual [ChatClient] (LLM) and
/// the audio playback / TTS layer together into a single session object,
/// exposes its state via [state] / [stateStream], and reports utterances and
/// replies back through [onDeviceTranscript] / [onTranscript] / [onError]
/// (settable at any time).
///
/// Turn flow: the pipeline flushes buffered mic audio to the on-device STT
/// engine via [flushTranscriptionBuffer]; the recognised utterance is then
/// sent through [sendText] to the [ChatClient], whose streamed reply is
/// bridged to [synthesizeOnDevice] (on-device TTS) for audible playback.
final class VoiceController {
  VoiceController({
    required this.chatClient,
    required this.micCapture,
    required this.playback,
    this.sttEngine,
    this.ttsEngine,
    this.onTranscript,
    this.onDeviceTranscript,
    this.onError,
    this.onNetworkError,
  }) {
    // Mic frames → local buffer for on-device STT.
    _micSubscription = micCapture.audioStream.listen(_onMicAudio);
    // Playback activity → isAiSpeaking.
    _isPlayingSubscription = playback.isPlaying.listen(_onIsPlayingChanged);
  }

  /// The textual LLM client used to produce assistant replies.
  final ChatClient chatClient;

  /// Microphone capture used for the client side of the conversation.
  final MicCaptureService micCapture;

  /// Playback of the on-device TTS audio.
  final AudioPlayback playback;

  /// Optional on-device STT engine (Whisper). When provided, mic audio is
  /// buffered during recording and transcribed locally on [flushTranscriptionBuffer].
  final SttEngine? sttEngine;

  /// Optional on-device TTS engine (Kokoro). When provided, [synthesizeOnDevice]
  /// can generate speech from text without the server.
  final TtsEngine? ttsEngine;

  /// Reports the assistant's reply back to the app whenever a turn completes.
  void Function(String transcript)? onTranscript;

  /// Reports a transcript produced by the on-device STT engine (the user's
  /// recognised utterance).
  void Function(String transcript)? onDeviceTranscript;

  /// Reports failures encountered by the session.
  void Function(Object error)? onError;

  /// Called when a network-level error is detected. Null when the caller
  /// does not need network status notifications.
  final void Function()? onNetworkError;

  late final StreamSubscription<List<int>> _micSubscription;
  late final StreamSubscription<bool> _isPlayingSubscription;

  /// Accumulates PCM audio chunks for on-device STT when [sttEngine] is set.
  final List<int> _micAudioBuffer = [];

  VoiceConversationState _state = VoiceConversationState.initial();
  final StreamController<VoiceConversationState> _stateController =
      StreamController<VoiceConversationState>.broadcast();

  /// Immediate snapshot of the conversation's state.
  VoiceConversationState get state => _state;

  /// Emits every state change (broadcast; safe for multiple listeners).
  Stream<VoiceConversationState> get stateStream => _stateController.stream;

  /// Starts (or resumes) the text conversation session. Marks the session as
  /// active so [startRecording] is allowed. There is no room, JWT or signaling
  /// handshake — conversation happens over the [ChatClient]'s text path.
  Future<void> startConversation() async {
    _update(_state.copyWith(isConnected: true, error: null));
  }

  /// Ends the current conversation session and deactivates the mic.
  Future<void> endConversation() async {
    if (_state.isRecording) {
      await stopRecording();
    }
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop.
    }
    _update(_state.copyWith(isConnected: false, isAiSpeaking: false));
  }

  /// Starts capturing microphone audio for on-device STT. No-op when already
  /// recording. Requires an active conversation session.
  Future<void> startRecording() async {
    if (!_state.isConnected) {
      _reportError(StateError('Start the conversation before speaking'));
      return;
    }
    if (_state.isRecording) return;
    try {
      // 16 kHz mono matches the buffer format for the on-device STT engine.
      await micCapture.start(sampleRate: kPlaybackSampleRate);
      _update(_state.copyWith(isRecording: true, error: null));
    } catch (e) {
      _reportError(e);
    }
  }

  /// Stops capturing microphone audio.
  Future<void> stopRecording() async {
    if (!_state.isRecording) return;
    try {
      await micCapture.stop();
    } catch (e) {
      _reportError(e);
    } finally {
      _update(_state.copyWith(isRecording: false));
    }
  }

  /// Flushes the accumulated mic audio buffer to the on-device STT engine.
  ///
  /// Intended to be called when VAD detects end-of-utterance. If the engine
  /// yields a non-empty transcript, the utterance is sent through [sendText]
  /// to produce and speak the assistant reply. If no [sttEngine] is
  /// configured the buffer is simply cleared.
  Future<void> flushTranscriptionBuffer() async {
    final engine = sttEngine;
    final buffer = List<int>.from(_micAudioBuffer);
    _micAudioBuffer.clear();

    if (engine == null || buffer.isEmpty) return;

    try {
      final transcript = await engine.transcribe(
        buffer,
        sampleRate: kPlaybackSampleRate,
      );
      // Whitespace-only transcripts mean "no speech recognised"; treat them
      // as empty so they neither update state nor fire callbacks.
      if (transcript.trim().isNotEmpty) {
        _update(_state.copyWith(onDeviceTranscript: transcript));
        onDeviceTranscript?.call(transcript);
        await sendText(transcript);
      }
    } catch (e) {
      _reportError(e);
    }
  }

  /// Sends [text] (a recognised user utterance) to the [ChatClient], streams
  /// the assistant reply into [VoiceConversationState.lastTranscript], and
  /// bridges the final reply to [synthesizeOnDevice] for audible playback.
  ///
  /// No-op for empty/whitespace input. Failures are surfaced through
  /// [state.error] / [onError].
  Future<void> sendText(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    try {
      _update(_state.copyWith(lastTranscript: null, error: null));
      final buffer = StringBuffer();
      final result = await chatClient.streamCompletions(
        messages: [ApiMessage(role: 'user', content: trimmed)],
        onContent: (delta) {
          buffer.write(delta);
          _update(_state.copyWith(lastTranscript: buffer.toString()));
        },
      );
      // Prefer the streamed content, falling back to the final result for
      // clients that return a complete reply without streaming deltas.
      final streamed = buffer.toString().trim();
      final reply = streamed.isNotEmpty ? streamed : result.content.trim();
      if (reply.isNotEmpty) {
        _update(_state.copyWith(lastTranscript: reply));
        onTranscript?.call(reply);
        await synthesizeOnDevice(reply);
      }
    } catch (e) {
      _reportError(e);
    }
  }

  /// Synthesises [text] locally using the on-device TTS engine and plays the
  /// result via [playback]. Returns the raw PCM samples for further processing
  /// if needed.
  ///
  /// Throws [StateError] if no [ttsEngine] is configured.
  Future<List<int>> synthesizeOnDevice(String text) async {
    final engine = ttsEngine;
    if (engine == null) {
      throw StateError('No on-device TTS engine configured');
    }
    try {
      final pcm = await engine.synthesize(
        text,
        sampleRate: kPlaybackSampleRate,
      );
      if (pcm.isNotEmpty) {
        await playback.playAudio(pcm);
      }
      return pcm;
    } catch (e) {
      _reportError(e);
      return const [];
    }
  }

  /// Suspends playback and marks the session paused. Called by the capture
  /// pipeline when an OS audio interruption begins so the shared session
  /// survives a phone call / alarm without leaking TTS audio.
  Future<void> pauseForInterruption() async {
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop; the interruption takes precedence over playback.
    }
    _update(_state.copyWith(isPaused: true, isAiSpeaking: false));
  }

  /// Clears the paused flag once an OS audio interruption ends.
  Future<void> resumeAfterInterruption() async {
    _update(_state.copyWith(isPaused: false));
  }

  /// Surfaces an error raised outside this controller (e.g. a mic capture
  /// failing mid-session after permission is revoked), so it lands in the same
  /// [state.error] the UI renders.
  void reportError(Object error) => _reportError(error);

  /// Clears the current [VoiceConversationState.error] without touching the
  /// connection/recording state (used to dismiss a re-auth card after a 401).
  void clearError() {
    if (_state.error == null) return;
    _update(_state.copyWith(error: null));
  }

  // ---- wiring -----------------------------------------------------------

  void _onMicAudio(List<int> chunk) {
    // Buffer for on-device STT when the engine is configured.
    if (sttEngine != null) {
      _micAudioBuffer.addAll(chunk);
    }
  }

  void _onIsPlayingChanged(bool playing) {
    _update(_state.copyWith(isAiSpeaking: playing));
  }

  // ---- state ------------------------------------------------------------

  void _update(VoiceConversationState next) {
    _state = next;
    if (!_stateController.isClosed) {
      _stateController.add(next);
    }
  }

  void _reportError(Object error) {
    if (kDebugMode) {
      debugPrint('VoiceController: $error');
    }
    // Keep the thrown object so typed error classification stays possible.
    _update(_state.copyWith(error: error));
    onError?.call(error);
    final isNet = error is Exception && _isNetworkError(error);
    if (isNet) {
      onNetworkError?.call();
    }
  }

  /// Heuristic check: is this exception likely a network failure? Typed
  /// detection for the chat client's [ChatNetworkError] takes precedence over
  /// the string match, which exists to catch exceptions raised by the audio
  /// services.
  static bool _isNetworkError(Object error) {
    if (error is ChatNetworkError) return true;
    final msg = error.toString().toLowerCase();
    return msg.contains('dioexception') ||
        msg.contains('socket') ||
        msg.contains('connection') ||
        msg.contains('network') ||
        msg.contains('timeout') ||
        msg.contains('ioexception');
  }

  /// Tears down this controller. The underlying services remain owned by
  /// their providers and stay usable.
  Future<void> dispose() async {
    await _micSubscription.cancel();
    await _isPlayingSubscription.cancel();
    await _stateController.close();
    await playback.stop();
  }
}
