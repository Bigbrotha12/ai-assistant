import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

/// Service that captures raw microphone audio as PCM16 chunks.
abstract interface class MicCaptureService {
  /// Start capturing microphone audio at the specified sample rate (default 16kHz).
  Future<void> start({int sampleRate = 16000});

  /// Stop capturing.
  Future<void> stop();

  /// Whether currently recording.
  bool get isRecording;

  /// Stream of decoded PCM16 samples (signed int16, one per sample).
  ///
  /// The [record] plugin streams raw little-endian byte pairs; they are
  /// decoded here so every downstream consumer (VAD energy, STT WAV packing)
  /// works in samples, not bytes. At 16 kHz mono, a 20 ms frame is
  /// 16000 × 0.02 = 320 samples.
  Stream<List<int>> get audioStream;

  /// Request microphone permission (returns true if granted).
  Future<bool> requestPermission();
}

/// Implementation of [MicCaptureService] backed by the [record] package,
/// streaming uncompressed 16-bit PCM.
class RecordMicCaptureService implements MicCaptureService {
  final AudioRecorder _recorder = AudioRecorder();
  final StreamController<List<int>> _audioController =
      StreamController<List<int>>.broadcast();
  StreamSubscription<Uint8List>? _subscription;
  bool _isRecording = false;

  @override
  bool get isRecording => _isRecording;

  @override
  Stream<List<int>> get audioStream => _audioController.stream;

  @override
  Future<bool> requestPermission() => _recorder.hasPermission();

  @override
  Future<void> start({int sampleRate = 16000}) async {
    if (_isRecording) return;
    final granted = await requestPermission();
    if (!granted) {
      throw StateError('Microphone permission denied');
    }

    final Stream<Uint8List> stream;
    try {
      stream = await _recorder.startStream(
        RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: sampleRate,
          numChannels: 1,
          // The shared AudioSessionManager owns audio focus for the voice
          // conversation. record's own focus request (default `pause`) steals
          // AUDIOFOCUS_GAIN from the active session on every turn, pausing
          // TTS playback mid-utterance (on device: focus loss events +
          // AudioTrack obtainBuffer 'Try again' starvation).
          audioInterruption: AudioInterruptionMode.none,
        ),
      );
    } catch (e) {
      // Surface via rethrow; the broadcast stream may have no listener yet,
      // and an addError here would be an unhandled stream error.
      rethrow;
    }

    _isRecording = true;
    _subscription = stream.listen(
      (bytes) => _audioController.add(_decodePcm16Le(bytes)),
      onError: (Object e) => _audioController.addError(e),
      onDone: () => _isRecording = false,
    );
  }

  /// Decodes raw little-endian PCM16 byte pairs into signed int16 samples.
  ///
  /// [bytes] holds whole frames (2 bytes per sample), as produced by the
  /// record plugin's stream.
  static Int16List _decodePcm16Le(Uint8List bytes) {
    final sampleCount = bytes.length ~/ 2;
    final samples = Int16List(sampleCount);
    final view = ByteData.view(
      bytes.buffer,
      bytes.offsetInBytes,
      sampleCount * 2,
    );
    for (var i = 0; i < sampleCount; i++) {
      samples[i] = view.getInt16(i * 2, Endian.little);
    }
    return samples;
  }

  @override
  Future<void> stop() async {
    if (!_isRecording) return;
    _isRecording = false;
    await _subscription?.cancel();
    _subscription = null;
    try {
      await _recorder.stop();
    } catch (_) {
      // Best-effort stop; the underlying stream has already finished.
    }
  }

  /// Stops recording and releases every resource held by this service.
  Future<void> dispose() async {
    await stop();
    await _audioController.close();
  }
}
