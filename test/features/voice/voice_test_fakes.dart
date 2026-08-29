import 'dart:async';

import 'package:ai_assistant/features/voice/audio_playback_service.dart';
import 'package:ai_assistant/features/voice/audio_session_manager.dart';
import 'package:ai_assistant/features/voice/engine_manager.dart';
import 'package:ai_assistant/features/voice/mic_capture_service.dart';
import 'package:ai_assistant/features/voice/model_downloader.dart';
import 'package:ai_assistant/features/voice/stt_engine.dart';
import 'package:ai_assistant/features/voice/tts_engine.dart';
import 'package:ai_assistant/features/voice/vad_processor.dart';
import 'package:ai_assistant/features/voice/voice_settings.dart';
import 'package:ai_assistant/features/voice/voice_settings_store.dart';

/// In-memory [EngineManager] double for widget tests.
///
/// The real manager resolves model paths via `path_provider` and downloads
/// executables, which is neither available nor desirable in tests. All
/// overrides are no-ops with hollow statuses.
class FakeEngineManager extends EngineManager {
  @override
  Future<void> initialize() async {}

  @override
  Future<void> get initialized async {}

  @override
  Map<String, VoiceEngineStatus> get allStatuses => const {};

  @override
  SttEngine? get sttEngine => null;

  @override
  TtsEngine? get ttsEngine => null;

  @override
  Stream<ModelDownloadProgress> get downloadProgress => const Stream.empty();

  @override
  Future<bool> ensureModelsDownloaded({
    void Function(String modelId)? progress,
  }) async => false;
}

/// In-memory [VoiceSettingsStore] double returning default settings.
class FakeVoiceSettingsStore implements VoiceSettingsStore {
  FakeVoiceSettingsStore([this.saved = const VoiceSettings()]);

  VoiceSettings? saved;

  @override
  Future<VoiceSettings?> load() async => saved;

  @override
  Future<void> save(VoiceSettings settings) async => saved = settings;

  @override
  Future<void> clear() async => saved = null;
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