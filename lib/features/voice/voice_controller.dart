import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/chat_client.dart';
import '../chat/message_model.dart';
import 'audio_playback_service.dart';
import 'mic_capture_service.dart';
import 'sentence_splitter.dart';
import 'speech_text_filter.dart';
import 'stt_engine.dart';
import 'tts_engine.dart';

/// One queued utterance awaiting synthesis + playback. Exactly one of [text]
/// / [pcm] is set: text is synthesised inside the drain loop, pre-built PCM
/// (e.g. a cached interim line) plays as-is.
class _SpeakItem {
  _SpeakItem.forText(String this.text)
      : pcm = null,
        result = Completer<List<int>>();

  _SpeakItem.forPcm(List<int> this.pcm)
      : text = null,
        result = null;

  /// Text to synthesise (null for PCM items).
  final String? text;

  /// Pre-synthesised PCM samples (null for text items).
  final List<int>? pcm;

  /// Completes with the played PCM once this item has finished playing — or
  /// with an empty list when the item was dropped (interrupt, teardown,
  /// synthesis failure). Only text items created for [synthesizeOnDevice]
  /// carry a completer; queue-internal items play and forget.
  final Completer<List<int>>? result;
}

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
    this.isGenerating = false,
    this.error,
    this.notice,
    this.lastTranscript,
    this.lastReply,
    this.onDeviceTranscript,
  });

  factory VoiceConversationState.initial() => const VoiceConversationState();

  /// Whether the text conversation session is active (i.e. [startConversation]
  /// has been invoked and [endConversation] has not). Capture is only allowed
  /// while the session is active.
  final bool isConnected;

  /// Whether microphone audio is being captured for on-device STT.
  final bool isRecording;

  /// Whether the AI's current turn is audible or about to be. Turn-level:
  /// set when the speak queue's first playback starts and held across the
  /// inter-sentence gaps (including the next sentence's synthesis), cleared
  /// only when the queue has drained and the last playback finished. Every
  /// mic/VAD gate reads this, so it must not flicker false between
  /// sentences the way raw playback state does.
  final bool isAiSpeaking;

  /// Whether the session is suspended by an OS audio interruption (e.g. a
  /// phone call or alarm). Recording and playback halt while true.
  final bool isPaused;

  /// Whether the assistant's LLM reply for the current turn is being
  /// streamed. Set just before [ChatClient.streamCompletions] dispatches and
  /// cleared when the stream exits — on completion, on the cancelled-token
  /// abandon, or on either error path — so it can never leak true.
  final bool isGenerating;

  /// Description of the last failure (null when healthy). Stored as the
  /// original thrown object so UI layers can classify it by type where a
  /// sealed [EngineError] is available, falling back to [toString] otherwise.
  final Object? error;

  /// Transient on-screen notice for non-fatal state changes the user should
  /// see (e.g. a further utterance dropped while one is already queued).
  /// Cleared when the next turn starts ([sendText]); informational only —
  /// failures go through [error].
  final String? notice;

  /// The assistant's last reply text, streamed incrementally by the LLM and
  /// finalised once the turn completes (null when no reply has been produced
  /// yet). This replaces the old server transcript echo.
  final String? lastTranscript;

  /// The assistant's final reply for the last completed turn (null until a
  /// turn completes). Unlike [lastTranscript] this is NOT updated during
  /// streaming — it flips once per turn, so UI transcripts can append the
  /// assistant's message exactly once.
  final String? lastReply;

  /// Holds the latest recognised user utterance from the on-device STT
  /// engine. Cleared when that utterance's turn begins ([sendText]), so state
  /// emissions carry it for exactly one append opportunity per utterance.
  final String? onDeviceTranscript;

  VoiceConversationState copyWith({
    bool? isConnected,
    bool? isRecording,
    bool? isAiSpeaking,
    bool? isPaused,
    bool? isGenerating,
    Object? error = _unset,
    Object? notice = _unset,
    Object? lastTranscript = _unset,
    Object? lastReply = _unset,
    Object? onDeviceTranscript = _unset,
  }) => VoiceConversationState(
    isConnected: isConnected ?? this.isConnected,
    isRecording: isRecording ?? this.isRecording,
    isAiSpeaking: isAiSpeaking ?? this.isAiSpeaking,
    isPaused: isPaused ?? this.isPaused,
    isGenerating: isGenerating ?? this.isGenerating,
    error: identical(error, _unset) ? this.error : error,
    notice: identical(notice, _unset) ? this.notice : notice as String?,
    lastTranscript: identical(lastTranscript, _unset)
        ? this.lastTranscript
        : lastTranscript as String?,
    lastReply: identical(lastReply, _unset)
        ? this.lastReply
        : lastReply as String?,
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
      other.isGenerating == isGenerating &&
      other.error == error &&
      other.notice == notice &&
      other.lastTranscript == lastTranscript &&
      other.lastReply == lastReply &&
      other.onDeviceTranscript == onDeviceTranscript;

  @override
  int get hashCode => Object.hash(
    isConnected,
    isRecording,
    isAiSpeaking,
    isPaused,
    isGenerating,
    error,
    notice,
    lastTranscript,
    lastReply,
    onDeviceTranscript,
  );

  @override
  String toString() =>
      'VoiceConversationState(connected: $isConnected, '
      'recording: $isRecording, aiSpeaking: $isAiSpeaking, paused: $isPaused, '
      'generating: $isGenerating, '
      'error: $error, notice: $notice, '
      'transcript: $lastTranscript, reply: $lastReply, '
      'deviceTranscript: $onDeviceTranscript)';
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
/// sent through [sendText] to the [ChatClient]. The streamed reply is split
/// into sentences while it streams ([SentenceAccumulator]); each completed
/// sentence is enqueued onto a speak queue and synthesised + played
/// sequentially, so the first sentence is audible while the LLM is still
/// generating.
final class VoiceController {
  VoiceController({
    required this.chatClient,
    required this.micCapture,
    required this.playback,
    this.sttEngine,
    this.ttsEngine,
    this.onTranscript,
    this.onDeviceTranscript,
    this.onUserMessage,
    this.onError,
    this.onNetworkError,
    this.contextBuilder,
    this.systemPrompt,
    Duration? echoGateDuration,
    Duration? interimDelay,
  }) : _echoGateDuration =
           echoGateDuration ?? const Duration(milliseconds: 300),
       _interimDelay = interimDelay ?? const Duration(seconds: 2) {
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
    // Playback activity → echo gate. (Turn-level isAiSpeaking is owned by
    // the speak-queue drain, not by raw playback state.)
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
  ///
  /// Injectable after construction: the engines register asynchronously and
  /// can land into a live controller without rebuilding it (a rebuild would
  /// tear down an in-flight hold-to-talk and drop its buffered audio).
  SttEngine? sttEngine;

  /// Optional on-device TTS engine (Supertonic). When provided,
  /// [synthesizeOnDevice] can generate speech from text without the server.
  TtsEngine? ttsEngine;

  /// Reports the assistant's reply back to the app whenever a turn completes.
  void Function(String transcript)? onTranscript;

  /// Reports a transcript produced by the on-device STT engine (the user's
  /// recognised utterance).
  void Function(String transcript)? onDeviceTranscript;

  /// Fired exactly once per turn with the trimmed user text, right at the
  /// start of [sendText] (before streaming). This is the persistence seam for
  /// the user's message and fires for both voice and text turns (voice turns
  /// already reach it via [flushTranscriptionBuffer]).
  void Function(String userText)? onUserMessage;

  /// Reports failures encountered by the session.
  void Function(Object error)? onError;

  /// Called when a network-level error is detected. Null when the caller
  /// does not need network status notifications.
  final void Function()? onNetworkError;

  /// Builds the full request message list (history + new user message) for a
  /// turn. When set, [sendText] uses its result instead of a bare user
  /// message.
  final Future<List<ApiMessage>> Function(String userText)? contextBuilder;

  /// System prompt passed to the chat client for every turn when set (matches
  /// the chat feature's `kSystemPrompt` usage).
  final String? systemPrompt;

  late final StreamSubscription<List<int>> _micSubscription;
  late final StreamSubscription<bool> _isPlayingSubscription;
  StreamSubscription<Object>? _playbackErrorSubscription;

  /// Accumulates PCM audio chunks for on-device STT when [sttEngine] is set.
  final List<int> _micAudioBuffer = [];

  /// Serialisation tail: turns (STT → LLM → TTS) run one at a time so a VAD
  /// flush racing the release-flush can never interleave two chat streams or
  /// cut one utterance's audio with the next.
  Future<void> _turnTail = Future.value();

  /// Bumped on teardown ([endConversation] / [dispose]) and on interrupt
  /// ([interrupt]); queued turns check their captured epoch at each stage and
  /// bail when it moved on.
  int _turnEpoch = 0;

  /// Active per-turn [CancelToken] forwarded to [ChatClient.streamCompletions].
  ///
  /// [interrupt] cancels it to abort an in-flight turn and immediately
  /// replaces it, so the NEXT turn's stream is never pre-cancelled. [dispose]
  /// cancels it too, so a stale stream can never complete into a disposed
  /// notifier's persistence callbacks.
  CancelToken _activeTurnToken = CancelToken();

  /// Chunks are ignored this long after playback ends — the speaker's tail
  /// and room echo would otherwise land in the STT buffer as a phantom
  /// utterance (the assistant transcribing itself).
  final Duration _echoGateDuration;

  /// Until this instant, mic chunks are not buffered (echo gate).
  DateTime _echoGateUntil = DateTime.fromMillisecondsSinceEpoch(0);

  /// How long the LLM may stay silent before the interim acknowledgement
  /// line ([kInterimSpeechLine]) fills the dead air. Injectable for tests;
  /// 2s in production so the acknowledgement lands within the ~2s
  /// interactive budget.
  final Duration _interimDelay;

  /// The one-shot timer arming the interim acknowledgement for the current
  /// turn. Cancelled when the first playback starts, when the turn ends, on
  /// interrupt/teardown — and re-armed when an utterance queues behind a
  /// busy turn, so the user gets a fresh acknowledgement for it.
  Timer? _interimTimer;

  /// Cached PCM for [kInterimSpeechLine]: synthesized once on first use so
  /// later acknowledgements play instantly at the 2s mark instead of
  /// serializing behind synthesis.
  List<int>? _interimPcm;

  /// Utterances currently queued behind the in-flight turn (busy state).
  /// Decremented when a queued turn starts running. Capped at one: a further
  /// flush is dropped with a [notice].
  int _pendingTurns = 0;

  /// FIFO of utterances awaiting synthesis + sequential playback: the
  /// completed sentences of the streaming reply (interim speech later).
  /// The drain ([_drainSpeakQueue]) synthesises strictly sequentially —
  /// never two syntheses in flight — and starts the next playback as soon
  /// as the previous one ends, so first audio lands while the LLM is still
  /// streaming.
  final List<_SpeakItem> _speakQueue = [];

  /// The running queue drain; null while the queue is idle. [_enqueue]
  /// starts one; never more than one at a time.
  Future<void>? _drainFuture;

  /// When the current turn started, for the time-to-first-audio measurement.
  DateTime? _turnStartedAt;

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
    // mute a fresh session (synthesize gates on isPaused). Per-turn fields
    // from the previous session must not leak into the new one either — a
    // stale onDeviceTranscript / lastReply would re-emit as phantom bubbles.
    clearTurnFields();
    _update(_state.copyWith(isConnected: true, isPaused: false, error: null));
  }

  /// Ends the current conversation session and deactivates the mic.
  Future<void> endConversation() async {
    // Invalidate any queued or in-flight turn: nothing may transcribe, hit
    // the network, or start playback after the session is gone.
    _turnEpoch++;
    // No acknowledgement may fire into a session that is going away.
    _cancelInterimTimer();
    // Abort the active LLM stream and mint a fresh token (mirroring
    // interrupt): a stream still in flight when the session ends must not
    // keep mutating lastTranscript or fire onTranscript on completion.
    _activeTurnToken.cancel();
    _activeTurnToken = CancelToken();
    if (_state.isRecording) {
      await stopRecording();
    }
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop.
    }
    _micAudioBuffer.clear();
    // Drop per-turn fields so a later restarted session cannot re-emit the
    // previous session's utterance/reply as phantom bubbles.
    clearTurnFields();
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

    // Busy state (W1.2): at most ONE utterance may wait behind the in-flight
    // turn. A further flush is dropped with an on-screen notice — the mic
    // buffer was already consumed above, so nothing accumulates and nothing
    // becomes a concurrent turn.
    if (_pendingTurns >= 1) {
      _update(
        _state.copyWith(notice: 'Still working — one thing at a time.'),
      );
      if (kDebugMode) {
        debugPrint('VoiceController: flush dropped (a turn is already queued)');
      }
      return;
    }
    _pendingTurns++;

    final epoch = _turnEpoch;
    unawaited(
      _runSerialized(() async {
        // This utterance is no longer *pending* — it is now the in-flight
        // turn, and the one-pending slot is free for the next flush.
        _pendingTurns--;
        await _runUtteranceTurn(engine, buffer, epoch);
      }),
    );
    // Interim-speech re-arm (W1.3): an utterance successfully queued behind
    // a busy turn earns its own acknowledgement — re-arm the 2s timer so the
    // user hears a fresh line for it while it waits.
    if (_state.isGenerating) {
      _armInterimTimer();
    }
  }

  /// The serialised body of one flushed utterance: transcribe [buffer] with
  /// [engine], send the recognised text as a turn, and wait for its audio.
  /// Bails without side effects when the epoch moved on ([epoch] no longer
  /// matches) — the turn was interrupted or the session torn down while this
  /// utterance sat queued.
  Future<void> _runUtteranceTurn(
    SttEngine engine,
    List<int> buffer,
    int epoch,
  ) async {
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
      final hallucinated = SpeechTextFilter.isLikelySilenceHallucination(raw);
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
        // briefly re-opens the echo gate around its tail. The speak queue
        // drain already serialises this; the wait below is belt-and-braces.
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
  /// speaks it with sentence-buffered streaming TTS: streamed deltas feed a
  /// [SentenceAccumulator]; each completed sentence is enqueued onto the
  /// speak queue the moment its boundary closes, and the trailing partial is
  /// enqueued on completion. The queue is synthesised + played sequentially
  /// by [_drainSpeakQueue], so first audio starts while the LLM is still
  /// streaming. [sendText] returns only after the queue has drained and the
  /// last playback finished — the [_turnTail] serialisation therefore keeps
  /// the next turn from truncating this one's audio.
  ///
  /// No-op for empty/whitespace input. Failures are surfaced through
  /// [state.error] / [onError].
  ///
  /// When [speakReply] is false the reply is NOT synthesised or played (the
  /// text-mode path; also avoids enqueueing when no [ttsEngine] is
  /// configured) — [onTranscript] and the state updates still fire.
  Future<void> sendText(String text, {bool speakReply = true}) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    // A turn queued ahead of a teardown must not hit the network.
    if (!_state.isConnected) return;
    if (kDebugMode) {
      debugPrint('VoiceController: sendText "${trimmed.substring(0, trimmed.length.clamp(0, 60))}"');
    }
    // The user's utterance surfaces in the UI transcript for this turn. Voice
    // turns already set it in flushTranscriptionBuffer (the UI dedupes the
    // consecutive identical value); text-mode turns rely on this so the user's
    // text appears in the transcript. Persistence of the user message goes
    // through onUserMessage ONLY (otherwise voice turns would persist twice).
    _update(_state.copyWith(onDeviceTranscript: trimmed));
    onDeviceTranscript?.call(trimmed);
    onUserMessage?.call(trimmed);
    // Snapshot the active token: interrupt() cancels and replaces it, so a
    // turn that started before an interrupt must still abort, while turns
    // started after it pick up the fresh token.
    final cancelToken = _activeTurnToken;
    // Sentence-buffered streaming only applies when this turn may speak and
    // an on-device TTS engine is configured.
    final speak = speakReply && ttsEngine != null;
    _turnStartedAt = DateTime.now();
    try {
      // Clearing lastReply and onDeviceTranscript too: consecutive identical
      // replies must still flip the field so per-turn listeners fire, and the
      // recognised utterance must not be re-emitted by later state changes
      // (streaming deltas, playback flips) into a duplicated transcript
      // entry. A stale notice from a dropped utterance is consumed here:
      // this turn is the acknowledgement that the pipeline is moving again.
      _update(
        _state.copyWith(
          lastTranscript: null,
          lastReply: null,
          error: null,
          notice: null,
          onDeviceTranscript: null,
        ),
      );
      final builder = contextBuilder;
      final messages = builder != null
          ? await builder(trimmed)
          : [ApiMessage(role: 'user', content: trimmed)];
      final buffer = StringBuffer();
      final accumulator = SentenceAccumulator();
      // The generating flag brackets exactly the LLM stream. The finally
      // clears it on EVERY exit — normal completion, the cancelled-token
      // abandon return, and both error paths via the catch below — so a
      // stream that dies mid-flight can never leave it stuck true.
      _update(_state.copyWith(isGenerating: true));
      // Dead-air guard (W1.3): if the reply produces no audio within
      // [_interimDelay], the cached interim line speaks. Only when this turn
      // can speak — a text-mode turn never acknowledges out loud.
      if (speak) {
        _armInterimTimer();
      }
      final ChatResult result;
      try {
        result = await chatClient.streamCompletions(
          messages: messages,
          systemPrompt: systemPrompt,
          cancelToken: cancelToken,
          onContent: (delta) {
            buffer.write(delta);
            _update(_state.copyWith(lastTranscript: buffer.toString()));
            if (speak) {
              accumulator.add(delta);
              for (final sentence in accumulator.takeCompleteSentences()) {
                _enqueueText(sentence);
              }
            }
          },
        );
      } finally {
        _update(_state.copyWith(isGenerating: false));
      }
      // The client surfaced a result despite an interrupt that cancelled the
      // token mid-stream: abandon the turn so a cancelled stream never fires
      // onTranscript, persists a partial reply, or synthesises. (The drain
      // drops anything still queued via its own epoch check.)
      if (cancelToken.isCancelled) {
        // Drop the partial reply accumulated by onContent deltas so a
        // barge-in mid-stream cannot leave a truncated lastTranscript behind.
        _update(_state.copyWith(lastTranscript: null));
        return;
      }
      // Prefer the streamed content, falling back to the final result for
      // clients that return a complete reply without streaming deltas.
      final streamed = buffer.toString().trim();
      final reply = streamed.isNotEmpty ? streamed : result.content.trim();
      if (reply.isNotEmpty) {
        _update(_state.copyWith(lastTranscript: reply, lastReply: reply));
        onTranscript?.call(reply);
        if (speak) {
          if (streamed.isEmpty) {
            // No deltas streamed: the whole reply goes out as one utterance.
            _enqueueText(result.content.trim());
          } else {
            // Flush the trailing partial sentence at end of stream.
            final remainder = accumulator.takeRemainder();
            if (remainder != null) {
              _enqueueText(remainder);
            }
          }
          // A turn ends when its audio finishes: wait for the whole queue —
          // earlier sentences may already be playing mid-stream.
          await _waitQueueDrained();
        }
      }
    } catch (e) {
      // A deliberate interrupt cancels the active token; the resulting
      // ChatNetworkError('cancelled') is not a failure and must not surface
      // an error banner. ANY other error — even one arriving in the same
      // instant as the interrupt — is genuine and must surface.
      if (e is ChatNetworkError && e.message == 'cancelled') {
        // Drop any partial reply accumulated before the cancellation landed.
        _update(_state.copyWith(lastTranscript: null));
        return;
      }
      _reportError(e);
    } finally {
      // The turn is over (or abandoned): no acknowledgement may fire into a
      // finished turn. Runs after the drain await above, so this can never
      // cancel a live acknowledgement mid-turn.
      _cancelInterimTimer();
    }
  }

  // ---- interim speech ----------------------------------------------------

  /// The canned acknowledgement filling dead air while the LLM generates
  /// (W1.3). Canned on-device copy — never the heavy model mid-prefill.
  static const String kInterimSpeechLine = 'Working on it.';

  /// Arms (or re-arms) the one-shot interim timer. Called when the LLM
  /// stream starts and when an utterance queues behind a busy turn; fires
  /// [_speakInterimLine] after [_interimDelay] unless cancelled first.
  void _armInterimTimer() {
    _cancelInterimTimer();
    _interimTimer = Timer(_interimDelay, () {
      unawaited(_speakInterimLine());
    });
  }

  void _cancelInterimTimer() {
    _interimTimer?.cancel();
    _interimTimer = null;
  }

  /// Fires the interim acknowledgement. A no-op when the first audio is
  /// already in flight (queue non-empty or playback started), when the
  /// session is gone, or when the cached line cannot be synthesized — the
  /// acknowledgement exists to fill silence, never to pile on speech.
  Future<void> _speakInterimLine() async {
    _interimTimer = null;
    if (!_maySpeakInterim()) return;
    final pcm = await _ensureInterimPcm();
    if (pcm == null || pcm.isEmpty) return;
    // Synthesis ran outside the timer callback; re-verify before speaking.
    if (!_maySpeakInterim()) return;
    if (kDebugMode) {
      debugPrint('VoiceController: interim line');
    }
    _enqueuePcm(pcm);
  }

  /// Whether the interim line may speak right now: live session, not paused,
  /// no playback started, and no drain running — the drain may hold a
  /// sentence already removed from the queue (synthesis in flight), which is
  /// exactly "first audio on the way".
  bool _maySpeakInterim() =>
      _state.isConnected &&
      !_state.isPaused &&
      !_state.isAiSpeaking &&
      _drainFuture == null &&
      _speakQueue.isEmpty;

  /// Returns the cached interim PCM, synthesizing it once on first use (the
  /// very first acknowledgement pays one synthesis; every later one plays
  /// the cached PCM instantly). Failures never surface as session errors —
  /// a missing acknowledgement is better than an error banner; the reply's
  /// own sentences report real TTS failures.
  Future<List<int>?> _ensureInterimPcm() async {
    final cached = _interimPcm;
    if (cached != null) return cached;
    final engine = ttsEngine;
    if (engine == null) return null;
    try {
      final pcm = await engine.synthesize(
        kInterimSpeechLine,
        sampleRate: kPlaybackSampleRate,
      );
      _interimPcm = pcm;
      return pcm;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('VoiceController: interim synthesis failed: $e');
      }
      return null;
    }
  }

  // ---- speak queue ------------------------------------------------------

  /// Appends an utterance to the speak queue and starts the sequential drain
  /// if none is running.
  void _enqueue(_SpeakItem item) {
    _speakQueue.add(item);
    _drainFuture ??= _drainSpeakQueue();
  }

  /// Appends pre-synthesised PCM (the cached interim line) straight to the
  /// queue, bypassing synthesis.
  void _enqueuePcm(List<int> pcm) {
    _enqueue(_SpeakItem.forPcm(pcm));
  }

  /// Filters [raw] through [SpeechTextFilter.stripNonSpeechTags] and
  /// enqueues what remains as a text utterance. Sentences that filter to
  /// empty (code blocks, stage directions) are skipped, matching the old
  /// whole-reply behaviour.
  void _enqueueText(String raw) {
    final speakable = SpeechTextFilter.stripNonSpeechTags(raw).trim();
    if (speakable.isEmpty) {
      if (kDebugMode) {
        debugPrint('VoiceController: sentence skipped (nothing speakable)');
      }
      return;
    }
    _enqueue(_SpeakItem.forText(speakable));
  }

  /// Waits until the speak queue has fully drained and the last playback
  /// finished, so a turn cannot return — and release the next serialised
  /// turn — while its audio is still going.
  Future<void> _waitQueueDrained() async {
    while (_drainFuture != null) {
      await _drainFuture;
    }
  }

  /// Drops every queued utterance, completing pending result completers so
  /// no [synthesizeOnDevice] caller is left waiting.
  void _dropPendingSpeakItems() {
    for (final item in _speakQueue) {
      item.result?.complete(const []);
    }
    _speakQueue.clear();
  }

  /// Plays the speak queue sequentially: synthesise (text items), play,
  /// await the playback end, next item. Runs until the queue is empty; an
  /// [_turnEpoch] change (interrupt / teardown) makes the loop drop
  /// everything still queued — and never override [interrupt]'s own
  /// isAiSpeaking update.
  ///
  /// [VoiceConversationState.isAiSpeaking] is turn-level here: it flips true
  /// when the first playback starts and stays true across inter-sentence
  /// gaps (raw playback flips false between sentences, which would re-open
  /// the mic gate mid-turn), cleared only after the queue has drained and
  /// the last playback has finished.
  Future<void> _drainSpeakQueue() async {
    // Capture the epoch SYNCHRONOUSLY, before the suspension below: an
    // interrupt that lands between [_enqueue] and this loop's first
    // resumption must still drop what was just enqueued, not inherit the
    // post-interrupt epoch and play it.
    final epoch = _turnEpoch;
    // Suspend once before any work so [_enqueue]'s `_drainFuture` assignment
    // always observes a still-pending drain: a drain that completed
    // synchronously (e.g. a queue of skippable items) would otherwise leave
    // a stale completed future behind and block [_waitQueueDrained] forever.
    await Future<void>.value();
    var played = false;
    try {
      while (_speakQueue.isNotEmpty) {
        // An OS interruption halts the queue WITHOUT consuming it: the rest
        // of the reply resumes after [resumeAfterInterruption] instead of
        // being lost.
        if (_state.isPaused) {
          try {
            await _stateController.stream
                .firstWhere((s) => !s.isPaused || !s.isConnected)
                .timeout(const Duration(minutes: 2));
          } on TimeoutException {
            break;
          } on StateError {
            // State stream closed (dispose).
            break;
          }
          if (_state.isPaused) {
            // Woke for a teardown, not a resume: the queued reply belongs to
            // a dead turn and must not leak into a fresh session.
            _dropPendingSpeakItems();
            break;
          }
          continue;
        }
        // Interrupted / torn down mid-queue: drop everything still queued.
        if (epoch != _turnEpoch) {
          _dropPendingSpeakItems();
          break;
        }
        final item = _speakQueue.removeAt(0);
        final text = item.text;
        var pcm = item.pcm;
        if (text != null) {
          final synthStartedAt = DateTime.now();
          List<int> synthesized;
          try {
            final engine = ttsEngine;
            if (engine == null) {
              throw StateError('No on-device TTS engine configured');
            }
            synthesized = await engine.synthesize(
              text,
              sampleRate: kPlaybackSampleRate,
            );
          } catch (e) {
            if (kDebugMode) {
              debugPrint('VoiceController: sentence TTS failed: $e');
            }
            _reportError(e);
            item.result?.complete(const []);
            continue;
          }
          if (kDebugMode) {
            debugPrint(
              'VoiceController: sentence synthesis '
              '${DateTime.now().difference(synthStartedAt).inMilliseconds}ms '
              '(${synthesized.length} samples)',
            );
          }
          // Synthesis takes seconds; the turn may have been interrupted
          // while it ran. Drop the fresh audio — and the rest of the queue.
          if (epoch != _turnEpoch) {
            item.result?.complete(const []);
            _dropPendingSpeakItems();
            break;
          }
          pcm = synthesized;
        }
        if (pcm == null || pcm.isEmpty) {
          item.result?.complete(const []);
          continue;
        }
        // First playback of the turn opens the mic gates; they stay closed
        // through the inter-sentence gaps — the flag is only cleared once
        // the queue has drained and the last playback has finished.
        if (!_state.isAiSpeaking) {
          _update(_state.copyWith(isAiSpeaking: true));
        }
        if (!played) {
          played = true;
          // First audio of the turn is out: the dead-air acknowledgement has
          // nothing left to fill and must not fire on top of the reply.
          _cancelInterimTimer();
          final startedAt = _turnStartedAt;
          if (kDebugMode) {
            final ms = startedAt == null
                ? null
                : DateTime.now().difference(startedAt).inMilliseconds;
            debugPrint(
              'VoiceController: time-to-first-audio '
              '${ms == null ? 'n/a' : '$ms ms'}',
            );
          }
        }
        // Subscribe BEFORE playAudio: a fast-finished utterance emits its
        // isPlaying false before a later subscription would attach.
        final ended = playback.isPlaying
            .firstWhere((playing) => !playing)
            .timeout(const Duration(minutes: 2));
        try {
          await playback.playAudio(pcm);
        } catch (e) {
          if (kDebugMode) {
            debugPrint('VoiceController: playback failed: $e');
          }
          _reportError(e);
          item.result?.complete(const []);
          continue;
        }
        try {
          await ended;
        } on TimeoutException {
          // Abnormally long playback; never wedge the queue on it.
        } on StateError {
          // The playback stream closed (player torn down). Complete the
          // current item so a [synthesizeOnDevice] caller is never left
          // waiting, then stop draining.
          item.result?.complete(const []);
          break;
        }
        item.result?.complete(pcm);
      }
      // Queue drained, last playback finished: close the turn-level speaking
      // flag. Never after an interrupt — interrupt() already set it false
      // and must stay authoritative.
      if (played && epoch == _turnEpoch) {
        _update(_state.copyWith(isAiSpeaking: false));
      }
    } finally {
      _drainFuture = null;
    }
  }

  /// Halts the current turn immediately (barge-in): invalidates queued and
  /// in-flight turns, cancels the active LLM stream, stops playback and
  /// re-opens the mic gates ([VoiceConversationState.isAiSpeaking] was holding
  /// them closed) so the user's next utterance is captured.
  ///
  /// Idempotent: safe to call when nothing is playing or streaming.
  Future<void> interrupt() async {
    // Invalidate any queued/in-flight turn: nothing may continue after the
    // interrupt.
    _turnEpoch++;
    // The interrupted turn's acknowledgement has nothing left to fill.
    _cancelInterimTimer();
    // Abort the active LLM stream and mint a fresh token so the NEXT turn is
    // never pre-cancelled.
    _activeTurnToken.cancel();
    _activeTurnToken = CancelToken();
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop.
    }
    // Stale audio from the interrupted utterance must never leak into the
    // next one's transcription.
    _micAudioBuffer.clear();
    // Reopen the mic gates: both the controller's own _onMicAudio and the
    // capture pipeline gate on isAiSpeaking.
    _update(_state.copyWith(isAiSpeaking: false));
  }

  /// Synthesises [text] locally using the on-device TTS engine via the speak
  /// queue and plays the result sequentially behind anything already queued.
  /// Returns the raw PCM samples that were played (an empty list when
  /// nothing was spoken).
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
      _turnStartedAt = DateTime.now();
      final item = _SpeakItem.forText(speakable);
      _enqueue(item);
      // Resolves when the item finished playing — with an empty list when
      // the queue dropped it (interrupt / teardown / synthesis failure).
      return await item.result!.future;
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
    // Flag FIRST, then stop: the speak-queue drain reacts to the
    // playback-end event, and it must already see isPaused at its loop top —
    // otherwise it would start the next sentence in the race window before
    // the paused flag lands.
    _update(_state.copyWith(isPaused: true, isAiSpeaking: false));
    try {
      await playback.stop();
    } catch (_) {
      // Best-effort stop; the interruption takes precedence over playback.
    }
    // Buffered speech spanning the interruption is stale; starting fresh.
    _micAudioBuffer.clear();
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

  /// Clears the per-turn fields ([lastReply], [onDeviceTranscript]) without
  /// touching the connection/recording state. Called when a conversation is
  /// switched or a session restarts so stale turn data from the previous
  /// conversation/session can never re-emit as phantom transcript bubbles.
  void clearTurnFields() {
    if (_state.lastReply == null && _state.onDeviceTranscript == null) return;
    _update(_state.copyWith(lastReply: null, onDeviceTranscript: null));
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
    // Turn-level isAiSpeaking is owned by the speak-queue drain: raw
    // isPlaying flickers false in the gap between sentences, and every
    // mic/VAD/focus gate reads isAiSpeaking — it must stay closed for the
    // whole turn. This listener only holds the echo gate through each real
    // playback end (speaker tail + room echo).
    if (!playing && _state.isAiSpeaking) {
      // Playback just ended: hold the echo gate through the speaker tail.
      _echoGateUntil = DateTime.now().add(_echoGateDuration);
    }
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
    _cancelInterimTimer();
    // Abort any in-flight LLM stream so it can never complete into a disposed
    // notifier's persistence callbacks.
    _activeTurnToken.cancel();
    await _micSubscription.cancel();
    await _isPlayingSubscription.cancel();
    await _playbackErrorSubscription?.cancel();
    await _stateController.close();
    await playback.stop();
  }
}
