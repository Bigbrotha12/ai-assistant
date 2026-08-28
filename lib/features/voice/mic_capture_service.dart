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

  /// Stream of raw PCM16 audio chunks.
  ///
  /// At 16kHz mono 16-bit a 20ms frame is 16000 × 0.02 × 2 = 640 bytes.
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
          bitRate: sampleRate * 16,
        ),
      );
    } catch (e) {
      _audioController.addError(e);
      rethrow;
    }

    _isRecording = true;
    _subscription = stream.listen(
      (bytes) => _audioController.add(Uint8List.fromList(bytes)),
      onError: (Object e) => _audioController.addError(e),
      onDone: () => _isRecording = false,
    );
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
