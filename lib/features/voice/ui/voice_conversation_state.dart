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
    this.status,
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

  /// Live per-turn status interjection (e.g. 'Thinking…', 'Working — …',
  /// 'Responding…'). Driven by [StatusTracker]; set during the stream and
  /// cleared when the turn ends or is abandoned.
  final String? status;

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
    Object? status = _unset,
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
    status: identical(status, _unset) ? this.status : status as String?,
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
      other.status == status &&
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
    status,
    lastTranscript,
    lastReply,
    onDeviceTranscript,
  );

  @override
  String toString() =>
      'VoiceConversationState(connected: $isConnected, '
      'recording: $isRecording, aiSpeaking: $isAiSpeaking, paused: $isPaused, '
      'generating: $isGenerating, '
      'error: $error, notice: $notice, status: $status, '
      'transcript: $lastTranscript, reply: $lastReply, '
      'deviceTranscript: $onDeviceTranscript)';
}
