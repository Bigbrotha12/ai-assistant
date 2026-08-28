import 'dart:io';
import 'dart:isolate';

import 'package:whisper_kit/whisper_kit.dart';

import '../engine_errors.dart';
import '../engine_config.dart';
import '../stt_engine.dart';
import '../wav_util.dart';

/// Self-hosted speech-to-text engine backed by whisper_kit.
///
/// Uses [WhisperModel.tiny] (English-only download, smallest footprint) and
/// runs inference on a background isolate.
///
/// whisper_kit 0.3.x expects `TranscribeRequest.audio` to be a **file path**
/// to a WAV on disk (the native side opens it with `drwav_init_file`); it does
/// not accept raw PCM or base64. The engine therefore writes the incoming
/// PCM16 samples to a temporary WAV file — inside the isolate, off the UI
/// thread — and passes that path. The temp file is deleted after inference.
///
/// [modelPath] must point to the `ggml-tiny.bin` model file. whisper_kit
/// resolves the actual model file from the directory containing [modelPath]
/// (`<dir>/ggml-tiny.bin`), so the downloaded model must be named accordingly.
class WhisperSttEngine implements SttEngine {
  /// Creates a Whisper STT engine.
  ///
  /// [modelPath] must point to a valid `ggml-*.bin` model file on disk.
  const WhisperSttEngine({required this.modelPath});

  @override
  final String name = EngineConfig.whisperTinyId;

  /// Path to the Whisper ggml model file.
  final String modelPath;

  /// Sync (enclosing isolate) check that the model file exists.
  bool get hasModel => File(modelPath).existsSync();

  @override
  Future<String> transcribe(
    List<int> pcm16bit, {
    required int sampleRate,
  }) async {
    if (!hasModel) {
      throw const EngineModelNotFoundError();
    }

    // Capture locals so the isolate closure does not reference `this`.
    final modelDir = File(modelPath).parent.path;
    final samples = pcm16bit;
    final sr = sampleRate;

    return Isolate.run<String>(() async {
      // WAV building and the temp-file write happen in the isolate so the
      // UI thread never touches the (potentially large) buffer.
      final wavBytes = pcm16ToWav(samples, sampleRate: sr);
      final wavFile = File(
        '${Directory.systemTemp.path}'
        '/whisper_${DateTime.now().microsecondsSinceEpoch}_$pid.wav',
      );
      try {
        await wavFile.writeAsBytes(wavBytes, flush: true);

        final whisper = Whisper(
          model: WhisperModel.tiny,
          modelDir: modelDir,
        );
        final result = await whisper.transcribe(
          transcribeRequest: TranscribeRequest(
            audio: wavFile.path,
            language: 'en',
            isNoTimestamps: true,
            threads: 1,
          ),
        );
        return result.text.trim();
      } on EngineError {
        rethrow;
      } catch (e) {
        throw EngineInferenceError('Whisper inference failed: $e');
      } finally {
        // Best-effort cleanup: whisper.cpp has finished reading the file once
        // transcribe returns, so the temp WAV can go.
        try {
          if (await wavFile.exists()) {
            await wavFile.delete();
          }
        } catch (_) {
          // Temp file cleanup must never mask the transcription result.
        }
      }
    });
  }
}