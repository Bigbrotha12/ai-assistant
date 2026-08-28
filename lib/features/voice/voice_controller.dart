import 'dart:async';

import 'package:flutter/foundation.dart';

import 'audio_playback_service.dart';
import 'livekit_service.dart';
import 'mic_capture_service.dart';
import 'stt_engine.dart';
import 'tts_engine.dart';

/// Mints the JWT used to join a LiveKit voice room for a given room name.
typedef VoiceTokenMinter = Future<String> Function(String roomName);

/// Snapshot of a voice conversation's state, used to drive the UI.
class VoiceConversationState {
  const VoiceConversationState({
    this.isConnected = false,
    this.currentRoomName,
    this.isRecording = false,
    this.isAiSpeaking = false,
    this.isPaused = false,
    this.error,
    this.lastTranscript,
    this.onDeviceTranscript,
  });

  factory VoiceConversationState.initial() => const VoiceConversationState();

  /// Whether the data-channel session with the AI is live.
  final bool isConnected;

  /// Room name of the live session (null when disconnected).
  final String? currentRoomName;

  /// Whether microphone audio is being captured and streamed to the AI.
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

  /// Server transcript of the last recognised client utterance (null = STT
  /// not supported by the backend, or nothing recognised yet).
  final String? lastTranscript;

  /// Transcript produced by the on-device STT engine (null when no local
  /// engine is active or nothing has been transcribed yet).
  final String? onDeviceTranscript;

  VoiceConversationState copyWith({
    bool? isConnected,
    Object? currentRoomName = _unset,
    bool? isRecording,
    bool? isAiSpeaking,
    bool? isPaused,
    Object? error = _unset,
    Object? lastTranscript = _unset,
    Object? onDeviceTranscript = _unset,
  }) => VoiceConversationState(
    isConnected: isConnected ?? this.isConnected,
    currentRoomName: identical(currentRoomName, _unset)
        ? this.currentRoomName
        : currentRoomName as String?,
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
      other.currentRoomName == currentRoomName &&
      other.isRecording == isRecording &&
      other.isAiSpeaking == isAiSpeaking &&
      other.isPaused == isPaused &&
      other.error == error &&
      other.lastTranscript == lastTranscript &&
      other.onDeviceTranscript == onDeviceTranscript;

  @override
  int get hashCode => Object.hash(
    isConnected,
    currentRoomName,
    isRecording,
    isAiSpeaking,
    isPaused,
    error,
    lastTranscript,
    onDeviceTranscript,
  );

  @override
  String toString() =>
      'VoiceConversationState(connected: $isConnected, room: $currentRoomName, '
      'recording: $isRecording, aiSpeaking: $isAiSpeaking, paused: $isPaused, '
      'error: $error, '
      'transcript: $lastTranscript, deviceTranscript: $onDeviceTranscript)';
}

/// Orchestrates a data-channel voice conversation.
///
/// Wires the mic capture, LiveKit data channel and the audio playback layer
/// together into a single session object, exposes its state via [state] /
/// [stateStream], and reports transcripts and failures back through
/// [onTranscript] / [onError] (settable at any time).
final class VoiceController {
  VoiceController({
    required this.liveKit,
    required this.micCapture,
    required this.playback,
    this.tokenMinter,
    this.sttEngine,
    this.ttsEngine,
    this.onTranscript,
    this.onDeviceTranscript,
    this.onError,
  }) {
    // Mic frames → LiveKit data channel.
    _micSubscription = micCapture.audioStream.listen(_onMicAudio);
    // AI TTS frames → playback.
    _audioSubscription = liveKit.audioDataReceived.listen(_onAudioDataReceived);
    // Server STT transcripts → onTranscript / state.
    _transcriptSubscription = liveKit.transcriptsReceived.listen(
      _onTranscriptReceived,
    );
    // Session lifecycle (e.g. server-initiated disconnects) → state.
    _eventSubscription = liveKit.events.listen(_onVoiceEvent);
    // Playback activity → isAiSpeaking.
    _isPlayingSubscription = playback.isPlaying.listen(_onIsPlayingChanged);
  }

  /// The LiveKit data-channel session.
  final LiveKitService liveKit;

  /// Microphone capture used for the client side of the conversation.
  final MicCaptureService micCapture;

  /// Playback of received AI TTS audio.
  final AudioPlayback playback;

  /// Mints the JWT used to join [connectToRoom]'s room. When null, calling
  /// [connectToRoom] reports an error instead of connecting.
  VoiceTokenMinter? tokenMinter;

  /// Optional on-device STT engine (Whisper). When provided, mic audio is
  /// buffered during recording and transcribed locally on [flushTranscriptionBuffer].
  final SttEngine? sttEngine;

  /// Optional on-device TTS engine (Kokoro). When provided, [synthesizeOnDevice]
  /// can generate speech from text without the server.
  final TtsEngine? ttsEngine;

  /// Reports a server transcript back to the app whenever one arrives.
  void Function(String transcript)? onTranscript;

  /// Reports a transcript produced by the on-device STT engine.
  void Function(String transcript)? onDeviceTranscript;

  /// Reports failures encountered by the session.
  void Function(Object error)? onError;

  late final StreamSubscription<List<int>> _micSubscription;
  late final StreamSubscription<List<int>> _audioSubscription;
  late final StreamSubscription<String> _transcriptSubscription;
  late final StreamSubscription<bool> _isPlayingSubscription;
  late final StreamSubscription<VoiceConversationEvent> _eventSubscription;

  /// Whether mic audio is forwarded to the LiveKit data channel.
  ///
  /// Defaults to disabled; a capture pipeline (or other orchestrator) enables
  /// it when voice activity is detected.
  bool _isMicAudioEnabled = false;

  /// Accumulates PCM audio chunks for on-device STT when [sttEngine] is set.
  final List<int> _micAudioBuffer = [];

  VoiceConversationState _state = VoiceConversationState.initial();
  final StreamController<VoiceConversationState> _stateController =
      StreamController<VoiceConversationState>.broadcast();

  /// Immediate snapshot of the conversation's state.
  VoiceConversationState get state => _state;

  /// Emits every state change (broadcast; safe for multiple listeners).
  Stream<VoiceConversationState> get stateStream => _stateController.stream;

  /// Joins a voice room: mints a JWT via [tokenMinter], then connects over
  /// the LiveKit data channel. Fails softly (reports through [onError]) when
  /// minting is not configured or the server refuses the connection.
  Future<void> connectToRoom({required String roomName}) async {
    final minter = tokenMinter;
    if (minter == null) {
      _reportError(StateError('Token minting is not configured'));
      return;
    }
    try {
      final token = await minter(roomName);
      await liveKit.connect(roomName: roomName, token: token);
      _update(
        _state.copyWith(
          isConnected: true,
          currentRoomName: roomName,
          error: null,
        ),
      );
    } catch (e) {
      _reportError(e);
    }
  }

  /// Leaves the current room and deactivates the mic.
  Future<void> disconnect() async {
    if (_state.isRecording) {
      await stopRecording();
    }
    try {
      await liveKit.disconnect();
    } catch (e) {
      _reportError(e);
    }
    _update(_state.copyWith(isConnected: false, currentRoomName: null));
  }

  /// Starts capturing microphone audio and streaming it to the AI. No-op when
  /// already recording. Requires an active connection.
  Future<void> startRecording() async {
    if (!_state.isConnected) {
      _reportError(StateError('Not connected to a voice room'));
      return;
    }
    if (_state.isRecording) return;
    try {
      // 16 kHz mono matches the data-channel audio format.
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
  /// Intended to be called when VAD detects end-of-utterance. If no
  /// [sttEngine] is configured the buffer is simply cleared.
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
      if (transcript.isNotEmpty) {
        _update(_state.copyWith(onDeviceTranscript: transcript));
        onDeviceTranscript?.call(transcript);
        onTranscript?.call(transcript);
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

  /// Enables or disables forwarding of mic audio to the LiveKit data
  /// channel.  Intended for a capture pipeline that gates transmission by
  /// voice activity; mic capture itself is unaffected.
  void setMicAudioEnabled(bool enabled) {
    _isMicAudioEnabled = enabled;
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

  // ---- wiring -----------------------------------------------------------

  void _onMicAudio(List<int> chunk) {
    // Buffer for on-device STT when the engine is configured.
    if (sttEngine != null) {
      _micAudioBuffer.addAll(chunk);
    }

    if (!_isMicAudioEnabled) return;
    unawaited(_sendAudioChunk(chunk));
  }

  Future<void> _sendAudioChunk(List<int> chunk) async {
    try {
      await liveKit.sendAudioData(chunk);
    } catch (e) {
      _reportError(e);
    }
  }

  void _onAudioDataReceived(List<int> chunk) {
    unawaited(_playAudioChunk(chunk));
  }

  Future<void> _playAudioChunk(List<int> chunk) async {
    try {
      await playback.playAudio(chunk);
    } catch (e) {
      _reportError(e);
    }
  }

  void _onTranscriptReceived(String transcript) {
    _update(_state.copyWith(lastTranscript: transcript));
    onTranscript?.call(transcript);
  }

  /// Reacts to session lifecycle events. The only event that changes the
  /// conversation state is a teardown: the server may drop the connection at
  /// any time, and [connectToRoom]'s optimistic `isConnected: true` must not
  /// outlive an actual disconnect.
  void _onVoiceEvent(VoiceConversationEvent event) {
    if (event != VoiceConversationEvent.disconnected) return;
    if (!_state.isConnected) return;
    _update(
      _state.copyWith(isConnected: false, currentRoomName: null),
    );
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
  }

  /// Tears down this controller. The underlying services remain owned by
  /// their providers and stay usable.
  Future<void> dispose() async {
    await _micSubscription.cancel();
    await _audioSubscription.cancel();
    await _transcriptSubscription.cancel();
    await _isPlayingSubscription.cancel();
    await _eventSubscription.cancel();
    await _stateController.close();
    await playback.stop();
  }
}
