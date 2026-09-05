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

  /// Number of [start] calls — lets tests observe mic restarts (self-heal).
  int startCount = 0;

  @override
  bool get isRecording => _recording;

  @override
  Stream<List<int>> get audioStream => _audioStream.stream;

  @override
  Future<bool> requestPermission() async => permissionGranted;

  @override
  Future<void> start({int sampleRate = 16000}) async {
    if (_recording) return;
    if (!permissionGranted) {
      throw StateError('Microphone permission denied');
    }
    _recording = true;
    startCount++;
    startSampleRate = sampleRate;
  }

  @override
  Future<void> stop() async {
    _recording = false;
  }

  /// Injects one PCM16 chunk into `audioStream`.
  void emitChunk(List<int> chunk) => _audioStream.add(chunk);

  /// Injects an error into `audioStream` (e.g. a dead-object read failure).
  /// Marks the recorder stopped, mirroring the real service where the
  /// underlying stream finishing ends the recording.
  void emitError(Object error) {
    _recording = false;
    _audioStream.addError(error);
  }

  Future<void> dispose() async => _audioStream.close();
}

/// In-memory [AudioPlayback] double. Inspect [playedChunks].
class FakeAudioPlayback implements AudioPlayback {
  final _isPlayingController = StreamController<bool>.broadcast();
  final _errorsController = StreamController<Object>.broadcast();

  final List<List<int>> playedChunks = [];

  /// When set, [playAudio] holds `isPlaying` true until this completes,
  /// simulating a long-running track (for interrupt / barge-in scenarios).
  Completer<void>? holdCompletion;

  /// When set, [stop] awaits this before emitting `isPlaying` false,
  /// simulating a slow/hung playback stop (for barge-in robustness
  /// scenarios — recording must start regardless of the stop's latency).
  Completer<void>? stopGate;

  @override
  Stream<bool> get isPlaying => _isPlayingController.stream;

  @override
  Stream<Object> get errors => _errorsController.stream;

  @override
  Future<void> playAudio(List<int> pcm16Samples) async {
    playedChunks.add(pcm16Samples);
    // Emit asynchronously so the controller's subscription settles the same
    // way it would with a real player.
    await Future<void>.delayed(Duration.zero);
    if (!_isPlayingController.isClosed) {
      _isPlayingController.add(true);
    }
    final hold = holdCompletion;
    if (hold != null) {
      // Mirrors production fire-and-forget playback (the real service returns
      // immediately and just_audio keeps playing): playAudio returns while
      // the track is still playing, and the completion (isPlaying false) is
      // emitted only when the held track finishes. This keeps callers parked
      // in the flush turn's `firstWhere(!playing)` wait during the hold, the
      // same timeline the real service produces.
      unawaited(
        hold.future.then((_) {
          if (!_isPlayingController.isClosed) {
            _isPlayingController.add(false);
          }
        }),
      );
      return;
    }
    // Natural completion: the real player flips isPlaying false when the
    // track finishes (ProcessingState.completed). Callers (turn serialization,
    // the echo gate) await this transition.
    if (!_isPlayingController.isClosed) {
      _isPlayingController.add(false);
    }
  }

  @override
  Future<void> stop() async {
    final gate = stopGate;
    if (gate != null) {
      await gate.future;
    }
    if (!_isPlayingController.isClosed) {
      _isPlayingController.add(false);
    }
  }

  Future<void> dispose() async {
    await _isPlayingController.close();
    await _errorsController.close();
  }
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

  /// When set, [transcribe] awaits this before returning, letting tests hold
  /// a turn in flight (for serialization / cancellation scenarios).
  Completer<void>? gate;

  @override
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate}) async {
    final err = error;
    if (err != null) throw err;
    transcribed.add(List<int>.from(pcm16bit));
    sampleRates.add(sampleRate);
    final g = gate;
    if (g != null) {
      await g.future;
    }
    return transcript;
  }
}

/// [TtsEngine] double returning a canned PCM sequence.
class FakeTtsEngine implements TtsEngine {
  FakeTtsEngine({
    this.samples = const [1, 2, 3],
    this.sampleVariants = const [],
    this.name = 'fake_tts',
  });

  final List<int> samples;

  /// Per-call PCM overrides, indexed by call order: lets tests tie a played
  /// chunk to the utterance that produced it (ordering assertions). Falls
  /// back to [samples] when empty or exhausted.
  final List<List<int>> sampleVariants;

  @override
  final String name;
  final List<String> synthesized = [];

  /// When set, [synthesize] awaits this before returning, letting tests hold
  /// synthesis in flight (for interrupt / barge-in scenarios). Applies to
  /// every call unless [gateCallLimit] bounds it to the first N calls.
  Completer<void>? gate;

  /// When non-null, [gate] only holds the first N synthesis calls — later
  /// calls return immediately (e.g. hold the reply's first sentence while a
  /// later acknowledgement synthesizes freely).
  int? gateCallLimit;

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    final index = synthesized.length;
    synthesized.add(text);
    final g = gate;
    if (g != null && (gateCallLimit == null || index < gateCallLimit!)) {
      await g.future;
    }
    if (sampleVariants.isNotEmpty) {
      final clamped =
          index >= sampleVariants.length ? sampleVariants.length - 1 : index;
      return sampleVariants[clamped];
    }
    return samples;
  }
}