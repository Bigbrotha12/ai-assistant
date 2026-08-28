import 'dart:async';

import 'package:ai_assistant/features/voice/audio_playback_service.dart';
import 'package:ai_assistant/features/voice/audio_session_manager.dart';
import 'package:ai_assistant/features/voice/livekit_service.dart';
import 'package:ai_assistant/features/voice/mic_capture_service.dart';
import 'package:ai_assistant/features/voice/stt_engine.dart';
import 'package:ai_assistant/features/voice/tts_engine.dart';
import 'package:ai_assistant/features/voice/vad_processor.dart';

/// In-memory [LiveKitService] double used across voice controller tests.
///
/// Surfaces the same streams as the real service so the controller's wiring
/// can be exercised without a Dart socket. Tests drive it through the
/// `emit*` helpers and inspect `sentAudio`.
class FakeLiveKitService implements LiveKitService {
  final _audioReceived = StreamController<List<int>>.broadcast();
  final _transcripts = StreamController<String>.broadcast();
  final _events = StreamController<VoiceConversationEvent>.broadcast();

  bool _connected = false;
  String? _roomName;

  /// Audio frames sent by the controller (mic → AI).
  final List<List<int>> sentAudio = [];

  /// Non-null makes [connect] throw this error.
  Object? connectError;

  @override
  bool get isConnected => _connected;

  @override
  String? get currentRoomName => _roomName;

  @override
  Stream<List<int>> get audioDataReceived => _audioReceived.stream;

  @override
  Stream<String> get transcriptsReceived => _transcripts.stream;

  @override
  Stream<VoiceConversationEvent> get events => _events.stream;

  @override
  Future<void> connect({
    required String roomName,
    required String token,
  }) async {
    final error = connectError;
    if (error != null) throw error;
    _connected = true;
    _roomName = roomName;
  }

  @override
  Future<void> disconnect() async {
    _connected = false;
    _roomName = null;
  }

  @override
  Future<void> sendAudioData(List<int> pcm16bit) async {
    sentAudio.add(pcm16bit);
  }

  /// Injects an AI TTS chunk into `audioDataReceived`.
  void emitAiAudio(List<int> chunk) => _audioReceived.add(chunk);

  /// Injects a server transcript into `transcriptsReceived`.
  void emitServerTranscript(String text) => _transcripts.add(text);

  /// Emits a `disconnected` event (mirrors a server-initiated drop).
  void emitDisconnected() => _events.add(VoiceConversationEvent.disconnected);

  Future<void> dispose() async {
    await _audioReceived.close();
    await _transcripts.close();
    await _events.close();
  }
}

/// In-memory [MicCaptureService] double. Feed chunks through [emitChunk].
class FakeMicCaptureService implements MicCaptureService {
  final _audioStream = StreamController<List<int>>.broadcast();

  bool _recording = false;
  bool permissionGranted = true;
  int? startSampleRate;

  @override
  bool get isRecording => _recording;

  @override
  Stream<List<int>> get audioStream => _audioStream.stream;

  @override
  Future<bool> requestPermission() async => permissionGranted;

  @override
  Future<void> start({int sampleRate = 16000}) async {
    if (!permissionGranted) {
      throw StateError('Microphone permission denied');
    }
    _recording = true;
    startSampleRate = sampleRate;
  }

  @override
  Future<void> stop() async {
    _recording = false;
  }

  /// Injects one PCM16 chunk into `audioStream`.
  void emitChunk(List<int> chunk) => _audioStream.add(chunk);

  Future<void> dispose() async => _audioStream.close();
}

/// In-memory [AudioPlayback] double. Inspect [playedChunks].
class FakeAudioPlayback implements AudioPlayback {
  final _isPlayingController = StreamController<bool>.broadcast();

  final List<List<int>> playedChunks = [];

  @override
  Stream<bool> get isPlaying => _isPlayingController.stream;

  @override
  Future<void> playAudio(List<int> pcm16bit) async {
    playedChunks.add(pcm16bit);
    // Emit asynchronously so the controller's subscription settles the same
    // way it would with a real player.
    await Future<void>.delayed(Duration.zero);
    if (!_isPlayingController.isClosed) {
      _isPlayingController.add(true);
    }
  }

  @override
  Future<void> stop() async {
    if (!_isPlayingController.isClosed) {
      _isPlayingController.add(false);
    }
  }

  Future<void> dispose() async => _isPlayingController.close();
}

/// In-memory [AudioSessionManager] double for pipeline tests.
class FakeAudioSessionManager implements AudioSessionManager {
  bool subscribed = false;
  int focusRequests = 0;
  int focusAbandons = 0;
  bool focusHeld = false;

  @override
  Function(bool isInterrupted)? onInterruption;

  @override
  bool get hasAudioFocus => focusHeld;

  @override
  Future<void> initialize() async {
    subscribed = true;
  }

  @override
  Future<void> requestAudioFocus() async {
    focusRequests++;
    focusHeld = true;
  }

  @override
  Future<void> abandonAudioFocus() async {
    focusAbandons++;
    focusHeld = false;
  }

  @override
  void handleInterruption({required bool isInterrupted}) {
    onInterruption?.call(isInterrupted);
  }

  @override
  Future<void> dispose() async => abandonAudioFocus();
}

/// Programmable [VadProcessor] double. Drive transitions through [emitState].
///
/// Falls back to the real (pure-Dart, platform-free) [EnergyBasedVadProcessor]
/// when the pipeline must consume actual mic chunks.
class FakeVadProcessor implements VadProcessor {
  final _stateChanges = StreamController<VadState>.broadcast();

  VadState _state = VadState.idle;
  final List<List<int>> processedChunks = [];
  double lastSensitivity = 0.5;

  /// Waits before emitting [speechStopped] the next no-op call, mirroring the
  /// real VAD's minimum-silence guard. Not needed by most tests.
  @override
  VadState get state => _state;

  @override
  Stream<VadState> get stateChanges => _stateChanges.stream;

  @override
  bool processChunk(List<int> pcm16bit) {
    processedChunks.add(pcm16bit);
    return _state == VadState.speechStarted;
  }

  @override
  void setSensitivity(double sensitivity) {
    lastSensitivity = sensitivity;
  }

  @override
  void setMinSilenceSeconds(double seconds) {}

  void emitState(VadState next) {
    _state = next;
    if (!_stateChanges.isClosed) {
      _stateChanges.add(next);
    }
  }

  @override
  void dispose() {
    _stateChanges.close();
  }
}

/// [SttEngine] double returning a canned transcription.
class FakeSttEngine implements SttEngine {
  FakeSttEngine({this.transcript = 'hello', this.name = 'fake_stt'});

  final String transcript;
  @override
  final String name;
  final List<List<int>> transcribed = [];
  final List<int> sampleRates = [];

  /// Non-null makes [transcribe] throw.
  Object? error;

  @override
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate}) async {
    final err = error;
    if (err != null) throw err;
    transcribed.add(List<int>.from(pcm16bit));
    sampleRates.add(sampleRate);
    return transcript;
  }
}

/// [TtsEngine] double returning a canned PCM sequence.
class FakeTtsEngine implements TtsEngine {
  FakeTtsEngine({this.samples = const [1, 2, 3], this.name = 'fake_tts'});

  final List<int> samples;
  @override
  final String name;
  final List<String> synthesized = [];

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    synthesized.add(text);
    return samples;
  }
}