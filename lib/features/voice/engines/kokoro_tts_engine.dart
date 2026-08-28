import 'dart:io';

import '../engine_errors.dart';
import '../engine_config.dart';
import '../tts_engine.dart';

/// On-device text-to-speech engine placeholder for Kokoro 82 M.
///
/// Kept registered in the engine registry so the feature plumbing (settings,
/// status tracking, download gating) has a stable seat, but **synthesis is not
/// implemented** ([synthesize] always throws [EngineInferenceError]).
///
/// ## Why synthesis is disabled
///
/// The Kokoro pipeline needs a phoneme / sentencepiece tokeniser (and a
/// matching model export) to turn text into the integer `input_ids` the ONNX
/// graph consumes. A naive character-grapheme tokenizer (code-point modulo
/// 10 000) produces numerically-valid but semantically meaningless input, i.e.
/// silent garbage audio — worse than an explicit error. The placeholder path
/// was therefore removed until a real tokeniser is integrated.
///
/// Until then the engine is surfaced as *not available*: the download UI
/// hides it ([EngineConfig.kokoro82mDownloadAvailable] is false while the
/// model URL is a placeholder), so users are never offered a failing download
/// or silent garbage speech.
class KokoroTtsEngine implements TtsEngine {
  /// Creates a Kokoro TTS engine.
  ///
  /// [modelPath] must point to a valid `.onnx` model file on disk.
  KokoroTtsEngine({required this._modelPath})
      : name = EngineConfig.kokoro82mId;

  @override
  final String name;

  final String _modelPath;

  /// Sync (enclosing isolate) check that the model file exists.
  bool get hasModel => File(_modelPath).existsSync();

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    throw const EngineInferenceError(
      'On-device Kokoro synthesis is not supported yet: the Kokoro phoneme '
      'tokenizer is not integrated. Enable the engine only after a real '
      'tokenizer and model export are wired up.',
    );
  }
}