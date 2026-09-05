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
/// plays as-is.
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
    Duration? synthesisTimeout,
  }) : _echoGateDuration =
           echoGateDuration ?? const Duration(milliseconds: 300),
       _synthesisTimeout = synthesisTimeout ?? const Duration(seconds: 60) {
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

  /// Utterances currently queued behind the in-flight turn (busy state).
  /// Decremented when a queued turn starts running. Capped at one: a further
  /// flush is dropped with a [notice].
  int _pendingTurns = 0;

  /// FIFO of utterances awaiting synthesis + sequential playback: the
  /// completed sentences of the streaming reply.
  /// The drain ([_drainSpeakQueue]) synthesises strictly sequentially —
  /// never two syntheses in flight — and starts the next playback as soon
  /// as the previous one ends, so first audio lands while the LLM is still
  /// streaming.
  final List<_SpeakItem> _speakQueue = [];

  /// The running queue drain; null while the queue is idle. [_enqueue]
  /// starts one; never more than one at a time.
  Future<void>? _drainFuture;

  /// The epoch the running drain was started for. A drain outlives an
  /// interrupt while a synthesis is in flight, so [_enqueue] uses this to
  /// start a fresh drain for the new epoch instead of appending the next
  /// turn's sentences to the stale one (which would drop them on wake).
  int? _drainEpoch;

  /// Bound on a single sentence's synthesis. Without it, one hung
  /// synthesis (dead isolate, stalled backend) would wedge the drain, the
  /// turn tail, and every future flush. Injectable for tests.
  final Duration _synthesisTimeout;

  /// Set by [dispose]; a disposed controller never speaks again — the
  /// state's isConnected stays true after dispose, so guards need this.
  bool _disposed = false;

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
    // Drop this session's queued sentences synchronously — a drain that is
    // mid-synthesis will wake to the epoch change and leave the queue (now
    // possibly holding a fresh session's items) alone.
    _dropPendingSpeakItems();
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
        _state.copyWith(notice: 'Dropped — one utterance at a time.'),
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
    if (epoch != _turnEpoch) {
      if (kDebugMode) {
        debugPrint('VoiceController: turn skipped (epoch $epoch)');
      }
      return;
    }
    if (kDebugMode) {
      debugPrint('VoiceController: turn start (epoch $epoch)');
    }
    try {
      // Bounded: one hung transcription must cost one utterance, never the
      // turn tail (an unbounded await here would wedge every future flush).
      final raw = await engine
          .transcribe(buffer, sampleRate: kPlaybackSampleRate)
          .timeout(const Duration(minutes: 2));
      if (kDebugMode) {
        debugPrint('VoiceController: turn transcribed');
      }
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
        // State only: the callback fires exactly once per utterance, in
        // [sendText] (this utterance's turn) — firing it here too would
        // double-report to any consumer.
        _update(_state.copyWith(onDeviceTranscript: transcript));
        // The turn's audio is fully serialised inside sendText: it returns
        // only after the speak queue has drained and the last playback
        // finished (_waitQueueDrained). No extra playback wait here — it was
        // a belt-and-braces guard from before the drain wait existed, and
        // under the turn-level isAiSpeaking semantics its condition is
        // unreliable (the flag is held across streaming gaps), which could
        // hang on a stale isPlaying stream and wedge the whole turn tail.
        await sendText(transcript);
      }
    } on TimeoutException {
      // Abnormally long playback; never wedge the turn queue on it.
    } catch (e) {
      if (kDebugMode) {
        debugPrint('VoiceController: STT failed: $e');
      }
      _reportError(e);
    }
    if (kDebugMode) {
      debugPrint('VoiceController: turn done (epoch $epoch)');
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
      debugPrint('VoiceController: sendText "${_debugTruncate(trimmed)}"');
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
    // started after it pick up the fresh token. The epoch snapshot scopes
    // the drain wait the same way.
    final cancelToken = _activeTurnToken;
    final epoch = _turnEpoch;
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
          // earlier sentences may already be playing mid-stream. Scoped to
          // this turn's epoch: a newer drain (post-interrupt) is not ours.
          await _waitQueueDrained(epoch);
          // The drain held the speaking flag through any streaming gap (the
          // queue is momentarily empty between sentences while the LLM
          // catches up); the turn is over — hand the speaker back. Epoch-
          // guarded: interrupt() owns the false update after a barge-in.
          if (epoch == _turnEpoch && _state.isAiSpeaking) {
            _update(_state.copyWith(isAiSpeaking: false));
          }
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
    }
  }

  // ---- speak queue ------------------------------------------------------

  /// Appends an utterance to the speak queue and ensures a drain of the
  /// CURRENT epoch is running: a drain still alive from an earlier epoch
  /// (an interrupt landed mid-synthesis) no longer owns the speaker, so the
  /// next turn gets a fresh drain instead of being appended to the stale
  /// one — the stale drain would drop the new sentences when it woke.
  void _enqueue(_SpeakItem item) {
    _speakQueue.add(item);
    if (_drainFuture == null || _drainEpoch != _turnEpoch) {
      _drainEpoch = _turnEpoch;
      _drainFuture = _drainSpeakQueue();
    }
  }

  /// Appends pre-synthesised PCM straight to the queue, bypassing synthesis.
  /// Currently unused — kept for future priority/overlay sources — but the PCM
  /// path stays for future priority/overlay sources.
  // ignore: unused_element
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

  /// Waits until this turn's speak queue has fully drained and the last
  /// playback finished, so a turn cannot return — and release the next
  /// serialised turn — while its audio is still going. Scoped to [epoch]: a
  /// drain started by a NEWER turn (after an interrupt) is not this turn's
  /// business.
  Future<void> _waitQueueDrained(int epoch) async {
    while (_drainFuture != null && _drainEpoch == epoch) {
      await _drainFuture;
    }
    if (kDebugMode) {
      debugPrint('VoiceController: queue drained (epoch $epoch)');
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
  /// await the playback end, next item. Runs until the queue is empty.
  ///
  /// Epoch ownership: this drain owns speaker for the epoch it captured. An
  /// interrupt / teardown bumps the epoch and synchronously drops this
  /// turn's queued items; when this drain wakes to a changed epoch it exits
  /// WITHOUT touching the queue — anything in it by then belongs to a newer
  /// drain. It also never overrides [interrupt]'s own isAiSpeaking update.
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
    if (kDebugMode) {
      debugPrint('VoiceController: drain start (epoch $epoch)');
    }
    var played = false;
    try {
      while (_speakQueue.isNotEmpty) {
        // Interrupted / torn down mid-queue: this drain no longer owns the
        // speaker. interrupt()/endConversation() already dropped this turn's
        // items synchronously; anything here belongs to a newer turn and is
        // the newer drain's business.
        if (epoch != _turnEpoch) break;
        // An OS interruption halts the queue WITHOUT consuming it: the rest
        // of the reply resumes after [resumeAfterInterruption] instead of
        // being lost.
        if (_state.isPaused) {
          try {
            await _stateController.stream
                .firstWhere((s) => !s.isPaused || !s.isConnected)
                .timeout(const Duration(minutes: 2));
          } on TimeoutException {
            // Abnormally long OS interruption: never wedge the queue on it.
            // The epoch still matches (an interrupt would have exited
            // above), so these items are stale the moment the interruption
            // is over — drop them rather than surprise-play them later.
            _dropPendingSpeakItems();
            break;
          } on StateError {
            // State stream closed (dispose): nothing may play afterwards.
            _dropPendingSpeakItems();
            break;
          }
          if (_state.isPaused) {
            // Woke for a teardown, not a resume: the queued reply belongs to
            // a dead turn and must not leak into a fresh session. (A wake
            // with a matching epoch and isConnected false is only possible
            // via endConversation, which bumped the epoch — this branch is
            // belt-and-braces for any state shape that violates that.)
            if (epoch == _turnEpoch) _dropPendingSpeakItems();
            break;
          }
          continue;
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
            // Bounded: one hung synthesis must cost one sentence, never the
            // whole loop (an unbounded await here would wedge the drain, the
            // turn tail, and every future flush until the app restarts).
            synthesized = await engine
                .synthesize(text, sampleRate: kPlaybackSampleRate)
                .timeout(_synthesisTimeout);
          } on TimeoutException {
            if (kDebugMode) {
              debugPrint('VoiceController: sentence TTS timed out');
            }
            _reportError(
              TimeoutException('TTS synthesis timed out', _synthesisTimeout),
            );
            item.result?.complete(const []);
            continue;
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
              '(${synthesized.length} samples) "${_debugTruncate(text)}"',
            );
          }
          // Synthesis takes seconds; the turn may have been interrupted
          // while it ran. Drop the fresh audio — but NOT the queue: items
          // enqueued after the interrupt belong to a newer turn and a newer
          // drain.
          if (epoch != _turnEpoch) {
            item.result?.complete(const []);
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
          // Bounded: one hung source load must cost one sentence, never the
          // whole loop.
          await playback.playAudio(pcm).timeout(const Duration(minutes: 2));
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
          // Abnormally long playback; never wedge the queue on it. The
          // stranded utterance is abandoned unplayed rather than played out
          // of context later.
          _dropPendingSpeakItems();
          break;
        } on StateError {
          // The playback stream closed (player torn down): nothing may play
          // afterwards. Complete the current item so a [synthesizeOnDevice]
          // caller is never left waiting, then clear the rest.
          item.result?.complete(const []);
          _dropPendingSpeakItems();
          break;
        }
        // An interrupt mid-playback stops the player: the utterance was
        // cancelled, not played — report it as such (the generation counter
        // in the service makes the stop authoritative).
        if (epoch != _turnEpoch) {
          item.result?.complete(const []);
          break;
        }
        item.result?.complete(pcm);
      }
      // Queue drained, last playback finished: close the turn-level speaking
      // flag — but NOT while the turn is still streaming: the LLM is slower
      // than playback in the normal case, and the queue is momentarily empty
      // between sentences. Clearing here would flicker isAiSpeaking false
      // (re-opening the mic gates mid-turn) and flip the UI to "Working…"
      // between sentences. A turn still generating holds the flag; [sendText]
      // clears it when the stream ends with nothing left to speak. Never
      // after an interrupt — interrupt() already set it false and must stay
      // authoritative.
      if (played && epoch == _turnEpoch && !_state.isGenerating) {
        _update(_state.copyWith(isAiSpeaking: false));
      }
    } finally {
      // Release the handle only if this drain still owns it: a newer-epoch
      // drain may have started while this one was finishing.
      if (_drainEpoch == epoch) {
        _drainFuture = null;
        _drainEpoch = null;
      }
      if (kDebugMode) {
        debugPrint('VoiceController: drain end (epoch $epoch)');
      }
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
    // Drop THIS turn's queued sentences synchronously (completing their
    // result completers): a drain mid-synthesis stays alive until the
    // synthesis returns, and sentences enqueued afterwards belong to the
    // NEXT turn — a later drain wake must not swallow them.
    _dropPendingSpeakItems();
    // Abort the active LLM stream and mint a fresh token so the NEXT turn is
    // never pre-cancelled.
    _activeTurnToken.cancel();
    _activeTurnToken = CancelToken();
    // Reopen the mic gates and arm the echo gate NOW, synchronously, BEFORE
    // the (potentially slow) playback stop: a barge-in recording that starts
    // while this runs must not be blocked on the stop completing, or the
    // hold silently captures nothing. The echo gate still covers the speaker
    // tail from the press moment; it is re-armed below from the actual stop.
    _echoGateUntil = DateTime.now().add(_echoGateDuration);
    // Stale audio from the interrupted utterance must never leak into the
    // next one's transcription.
    _micAudioBuffer.clear();
    _update(_state.copyWith(isAiSpeaking: false, notice: null));
    try {
      // Bounded: one hung stop must never wedge the mic gates shut for a
      // barge-in hold.
      await playback.stop().timeout(const Duration(seconds: 1));
    } catch (_) {
      // Best-effort stop; the gates are already open.
    }
    // The speaker's tail can bleed into the mic right after a Stop. If the
    // stop was slow, the gate armed above may have expired while the tail was
    // still decaying — re-arm it from the actual stop so the tail is covered.
    _echoGateUntil = DateTime.now().add(_echoGateDuration);
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
    // Never push audio at the user mid-interruption (e.g. during a call),
    // after the session ended, or from a disposed controller (isConnected
    // stays true after dispose — the flag is the only reliable guard).
    if (_disposed || _state.isPaused || !_state.isConnected) return const [];
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
      // Direct speaks outside a turn get their own measurement window; a
      // mid-turn interjection must not clobber the turn's time-to-first-
      // audio reference.
      if (!_state.isGenerating) {
        _turnStartedAt = DateTime.now();
      }
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
    // The speaker's tail after the stop can bleed into the mic; the
    // playback-end listener may arm the gate after the isAiSpeaking update
    // above (missing its window) — arm it unconditionally.
    _echoGateUntil = DateTime.now().add(_echoGateDuration);
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

  /// Debug-log-safe truncation: never splits a UTF-16 surrogate pair, so
  /// emoji/CJK replies cannot produce malformed log lines.
  static String _debugTruncate(String text, [int max = 60]) {
    if (text.length <= max) return text;
    var end = max;
    final last = text.codeUnitAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    return '${text.substring(0, end)}…';
  }

  /// Tears down this controller. The underlying services remain owned by
  /// their providers and stay usable.
  Future<void> dispose() async {
    // Invalidate queued turns — nothing may run against a disposed controller.
    _disposed = true;
    _turnEpoch++;
    // Complete any queued result completers so no [synthesizeOnDevice]
    // caller hangs on a controller that can never speak again.
    _dropPendingSpeakItems();
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
