import 'dart:async';
import 'dart:math';

/// State of voice activity detection.
enum VadState {
  /// No speech detected.
  idle,

  /// Speech just began (emitted once per utterance).
  speechStarted,

  /// Speech just ended (emitted once per utterance).
  speechStopped,
}

/// Detects voice activity in a stream of PCM16 audio chunks.
abstract interface class VadProcessor {
  /// Process an audio chunk and return whether speech is currently active.
  bool processChunk(List<int> pcm16bit);

  /// Current VAD state.
  VadState get state;

  /// Stream of state transitions.
  Stream<VadState> get stateChanges;

  /// Adjust sensitivity (0.0 = least sensitive, 1.0 = most sensitive).
  void setSensitivity(double sensitivity);

  /// Release resources.
  void dispose();
}

/// Simple energy-based (RMS) voice activity detector.
///
/// Uses root-mean-square energy measured in dBFS to decide whether the
/// current audio frame contains speech.  Hysteresis and minimum-duration
/// guards prevent rapid toggling.
///
/// Note: the `flutter_vad` package is not published on pub.dev, so this
/// provides a lightweight fallback using signal energy alone.
class EnergyBasedVadProcessor implements VadProcessor {
  EnergyBasedVadProcessor({double sensitivity = 0.5})
      : _sensitivity = sensitivity.clamp(0.0, 1.0);

  double _sensitivity;
  VadState _state = VadState.idle;
  DateTime? _speechStartTime;
  DateTime? _silenceStartTime;

  final _stateController = StreamController<VadState>.broadcast();

  /// Minimum duration of above-threshold energy before speech is confirmed.
  static const _minSpeechDuration = Duration(milliseconds: 200);

  /// Minimum duration of below-threshold energy before speech is declared
  /// ended.
  static const _minSilenceDuration = Duration(milliseconds: 350);

  /// Start threshold in dBFS.  Higher sensitivity → lower (more negative)
  /// threshold.
  double get _startThreshold => -20.0 - (_sensitivity * 30.0);

  /// Stop threshold – 6 dB below start for hysteresis.
  double get _stopThreshold => _startThreshold - 6.0;

  @override
  VadState get state => _state;

  @override
  Stream<VadState> get stateChanges => _stateController.stream;

  @override
  void setSensitivity(double sensitivity) {
    _sensitivity = sensitivity.clamp(0.0, 1.0);
  }

  @override
  bool processChunk(List<int> pcm16bit) {
    if (pcm16bit.isEmpty) return _state == VadState.speechStarted;

    final dbfs = _calculateDbfs(pcm16bit);
    final now = DateTime.now();

    switch (_state) {
      case VadState.idle:
        _silenceStartTime = null;
        if (dbfs > _startThreshold) {
          _speechStartTime ??= now;
          if (now.difference(_speechStartTime!) >= _minSpeechDuration) {
            _transition(VadState.speechStarted);
          }
        } else {
          _speechStartTime = null;
        }

      case VadState.speechStarted:
        _speechStartTime = null;
        if (dbfs < _stopThreshold) {
          _silenceStartTime ??= now;
          if (now.difference(_silenceStartTime!) >= _minSilenceDuration) {
            _transition(VadState.speechStopped);
          }
        } else {
          _silenceStartTime = null;
        }

      case VadState.speechStopped:
        _transition(VadState.idle);
    }

    return _state == VadState.speechStarted;
  }

  void _transition(VadState next) {
    if (_state == next) return;
    _state = next;
    if (!_stateController.isClosed) {
      _stateController.add(next);
    }
  }

  /// Converts a buffer of 16-bit signed PCM samples to dBFS.
  static double _calculateDbfs(List<int> samples) {
    if (samples.isEmpty) return -100.0;

    var sumSquares = 0.0;
    for (var i = 0; i < samples.length; i++) {
      final s = samples[i].toDouble();
      sumSquares += s * s;
    }
    final rms = sqrt(sumSquares / samples.length);
    if (rms == 0) return -100.0;
    return 20 * log(rms / 32768) / ln10;
  }

  @override
  void dispose() {
    _stateController.close();
  }
}
