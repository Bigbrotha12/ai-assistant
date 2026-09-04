import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/chat_client.dart';
import '../chat/message_model.dart';
import 'audio_playback_service.dart';
import 'mic_capture_service.dart';
import 'speech_text_filter.dart';
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
    Duration? echoGateDuration,
  }) : _echoGateDuration =
           echoGateDuration ?? const Duration(milliseconds: 300) {
    // Mic frames → local buffer for on-device STT. The capture pipeline is
    // the single error reporter for mic streams (it routes into
    // [reportError]); this listener only logs so a broadcast error can never
    // be unhandled — and is never double-reported.
    _micSubscription = micCapture.audioStream.listen(
      _onMicAudio,
      onError: (Object e) {
        if (kDebugMode) {
          debugPrint('VoiceController: mic stream error (reported by pipeline): $e');
        }
      },
    );
    // Playback activity → isAiSpeaking.
    _isPlayingSubscription = playback.isPlaying.listen(_onIsPlayingChanged);
    // Playback failures → conversation state (never silent).
    _playbackErrorSubscription = playback.errors.listen(_reportError);
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
  StreamSubscription<Object>? _playbackErrorSubscription;

  /// Accumulates PCM audio chunks for on-device STT when [sttEngine] is set.
  final List<int> _micAudioBuffer = [];

  /// Serialisation tail: turns (STT → LLM → TTS) run one at a time so a VAD
  /// flush racing the release-flush can never interleave two chat streams or
  /// cut one utterance's audio with the next.
  Future<void> _turnTail = Future.value();

  /// Bumped on teardown ([endConversation] / [dispose]); queued turns check
  /// their captured epoch at each stage and bail when it moved on.
  int _turnEpoch = 0;

  /// Chunks are ignored this long after playback ends — the speaker's tail
  /// and room echo would otherwise land in the STT buffer as a phantom
  /// utterance (the assistant transcribing itself).
  final Duration _echoGateDuration;

  /// Until this instant, mic chunks are not buffered (echo gate).
  DateTime _echoGateUntil = DateTime.fromMillisecondsSinceEpoch(0);

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
    // A stale paused flag from an interruption that hit while idle must not
    // mute a fresh session (synthesize gates on isPaused).
    _update(_state.copyWith(isConnected: true, isPaused: false, error: null));
  }

  /// Ends the current conversation session and deactivates the mic.
  Future<void> endConversation() async {
    // Invalidate any queued or in-flight turn: nothing may transcribe, hit
    // the network, or start playback after the session is gone.
    _turnEpoch++;
    if (_state.isRecording) {
      await stopRecording();
    }
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop.
    }
    _micAudioBuffer.clear();
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
      // Stale audio (e.g. a released hold before speech) must never leak
      // into the next utterance's transcription.
      _micAudioBuffer.clear();
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
  /// Intended to be called when VAD detects end-of-utterance or when a
  /// hold-to-talk press is released. If the engine yields a non-empty
  /// transcript, the utterance is sent through [sendText] to produce and
  /// speak the assistant reply. If no [sttEngine] is configured the buffer is
  /// simply cleared.
  ///
  /// The buffer copy/clear happens synchronously before the first await, so
  /// a new utterance cannot interleave with the transcript being produced;
  /// the turn itself (STT → LLM → TTS) is serialised onto [_turnTail] so two
  /// flushes can never run concurrently.
  Future<void> flushTranscriptionBuffer() async {
    final engine = sttEngine;
    final buffer = List<int>.from(_micAudioBuffer);
    _micAudioBuffer.clear();

    if (kDebugMode) {
      debugPrint(
        'VoiceController: flush (${buffer.length} samples, engine=${engine?.name ?? 'none'})',
      );
    }
    if (engine == null || buffer.isEmpty) return;

    final epoch = _turnEpoch;
    unawaited(
      _runSerialized(() async {
        // The session may have ended while this turn sat queued.
        if (epoch != _turnEpoch) return;
        try {
          final raw = await engine.transcribe(
            buffer,
            sampleRate: kPlaybackSampleRate,
          );
          // Whisper hallucinates stage-direction tags on silence/noise
          // ("[BLANK_AUDIO]", "(humming)", "Thanks for watching!"); strip
          // them and drop hallucination-only utterances so they never
          // become a turn.
          final transcript = SpeechTextFilter.stripNonSpeechTags(raw).trim();
          final hallucinated =
              SpeechTextFilter.isLikelySilenceHallucination(raw);
          if (kDebugMode) {
            debugPrint(
              'VoiceController: transcript="${transcript.isEmpty ? raw.trim() : transcript}"'
              '${hallucinated ? ' (dropped: silence hallucination)' : ''}',
            );
          }
          if (epoch != _turnEpoch) return;
          // Whitespace-only transcripts mean "no speech recognised"; treat
          // them as empty so they neither update state nor fire callbacks.
          if (transcript.isNotEmpty && !hallucinated) {
            _update(_state.copyWith(onDeviceTranscript: transcript));
            onDeviceTranscript?.call(transcript);
            await sendText(transcript);
            // A turn ends when its audio finishes, not when play is merely
            // kicked off — otherwise the next turn truncates this one and
            // briefly re-opens the echo gate around its tail.
            if (_state.isAiSpeaking) {
              await playback.isPlaying
                  .firstWhere((playing) => !playing)
                  .timeout(const Duration(minutes: 2));
            }
          }
        } on TimeoutException {
          // Abnormally long playback; never wedge the turn queue on it.
        } catch (e) {
          if (kDebugMode) {
            debugPrint('VoiceController: STT failed: $e');
          }
          _reportError(e);
        }
      }),
    );
  }

  /// Serialises [action] onto [_turnTail] so concurrent turns queue.
  Future<T> _runSerialized<T>(Future<T> Function() action) {
    final result = _turnTail.then((_) => action());
    // Swallow errors on the tail so one failed turn never wedges the chain.
    _turnTail = result.then((_) {}, onError: (_) {});
    return result;
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
    // A turn queued ahead of a teardown must not hit the network.
    if (!_state.isConnected) return;
    if (kDebugMode) {
      debugPrint('VoiceController: sendText "${trimmed.substring(0, trimmed.length.clamp(0, 60))}"');
    }
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
    // Never push audio at the user mid-interruption (e.g. during a call) or
    // after the session ended.
    if (_state.isPaused || !_state.isConnected) return const [];
    try {
      // LLM replies can carry stage directions ("(humming)",
      // "[BLANK_AUDIO]"); the TTS engine must speak only real text.
      final speakable = SpeechTextFilter.stripNonSpeechTags(text).trim();
      if (speakable.isEmpty) {
        if (kDebugMode) {
          debugPrint('VoiceController: TTS skipped (nothing speakable)');
        }
        return const [];
      }
      final pcm = await engine.synthesize(
        speakable,
        sampleRate: kPlaybackSampleRate,
      );
      if (kDebugMode) {
        debugPrint('VoiceController: TTS produced ${pcm.length} samples');
      }
      // Synthesis takes seconds; the session or an interruption may have
      // started while it ran. Check again before any audio leaves the app.
      if (pcm.isNotEmpty && !_state.isPaused && _state.isConnected) {
        await playback.playAudio(pcm);
      }
      return pcm;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('VoiceController: TTS failed: $e');
      }
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
    // Buffered speech spanning the interruption is stale; starting fresh.
    _micAudioBuffer.clear();
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
    // Echo gate: while the assistant is speaking — and for a short tail
    // after it stops (speaker decay + room echo) — mic chunks must not enter
    // the STT buffer, or the assistant transcribes its own voice into a
    // phantom turn. (The capture pipeline gates VAD separately; this gate
    // protects the STT buffer the pipeline cannot see.)
    if (_state.isAiSpeaking || DateTime.now().isBefore(_echoGateUntil)) {
      return;
    }
    // Buffer for on-device STT when the engine is configured.
    if (sttEngine != null) {
      _micAudioBuffer.addAll(chunk);
    }
  }

  void _onIsPlayingChanged(bool playing) {
    if (!playing && _state.isAiSpeaking) {
      // Playback just ended: hold the echo gate through the speaker tail.
      _echoGateUntil = DateTime.now().add(_echoGateDuration);
    }
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
    // Invalidate queued turns — nothing may run against a disposed controller.
    _turnEpoch++;
    await _micSubscription.cancel();
    await _isPlayingSubscription.cancel();
    await _playbackErrorSubscription?.cancel();
    await _stateController.close();
    await playback.stop();
  }
}
