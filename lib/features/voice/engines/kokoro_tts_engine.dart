import 'dart:io';

import 'package:flutter/foundation.dart';

import '../engine_config.dart';
import '../engine_errors.dart';
import '../tts_engine.dart';
import 'kokoro_g2p.dart';
import 'kokoro_onnx_session.dart';
import 'kokoro_tokenizer.dart';
import 'kokoro_voices.dart';

/// The model's native sample rate (Hz). Kokoro synthesises 24 kHz mono audio.
const int kKokoroSampleRate = 24000;

/// On-device text-to-speech engine for Kokoro 82M.
///
/// Replaces the historical throwing placeholder with a real ONNX synthesis
/// pipeline:
///
/// ```text
/// text (natural language)
///   → TextToPhonemes (G2P) → IPA phonemes
///   → KokoroTokenizer (IPA → integer ids, padded)
///   → style vector from KokoroVoices (indexed by content token count)
///   → KokoroOnnxSession (input_ids int64, style float32, speed float32)
///   → float32 audio (24 kHz mono)
///   → linear resample to the requested sampleRate
///   → 16-bit signed PCM (mono)
/// ```
///
/// The engine stays behind the [TtsEngine] interface and is registered via
/// `engine_registry.dart` (through [EngineManager]).
///
/// ## Testability
///
/// The ONNX session is constructed through an injectable [KokoroSessionFactory]
/// seam (defaulting to the real onnxruntime backend), and phonemization through
/// an injectable [G2PFactory] seam — so tests can exercise the full pipeline
/// without a real `.onnx` file or a real G2P. The tokenizer, voices parser and
/// resample/PCM conversion are all pure and unit-tested directly.
///
/// ## Unverified-on-device assumptions
///
/// The pipeline, vocab, io node naming and voices layout were verified by
/// inspection of the `onnx-community/Kokoro-82M-v1.0-ONNX` repo artifacts, but
/// the graph could **not** be executed in this environment. The default G2P is
/// a provisional heuristic (see [KokoroG2P]) and both it and the engines must
/// be validated on a real device — see the M0b implementation report.
class KokoroTtsEngine implements TtsEngine {
  /// Creates a Kokoro TTS engine.
  ///
  /// [modelPath] must point to a downloaded `.onnx` model file. [voicesPath]
  /// and [tokenizerPath] default to the model's directory using the canonical
  /// artifact file names ([EngineConfig.kokoro82mVoicesFileName] /
  /// [EngineConfig.kokoro82mTokenizerFileName]).
  ///
  /// [sessionFactory] is an injectable seam for tests; omit to use the real
  /// onnxruntime backend. [g2pFactory] is an injectable seam for the
  /// text→phoneme stage; omit to use the heuristic [KokoroG2P].
  KokoroTtsEngine({
    required String modelPath,
    String? voicesPath,
    String? tokenizerPath,
    KokoroSessionFactory? sessionFactory,
    G2PFactory? g2pFactory,
    this.speed = 1.0,
  })  : _modelPath = modelPath,
        _voicesPath = voicesPath ??
            _defaultAdjacent(modelPath, EngineConfig.kokoro82mVoicesFileName),
        _tokenizerPath = tokenizerPath ??
            _defaultAdjacent(modelPath, EngineConfig.kokoro82mTokenizerFileName),
        _sessionFactory = sessionFactory ?? createKokoroOnnxSession,
        _g2p = (g2pFactory ?? createKokoroG2P)();

  @override
  final String name = EngineConfig.kokoro82mId;

  final String _modelPath;
  final String _voicesPath;
  final String _tokenizerPath;
  final KokoroSessionFactory _sessionFactory;

  /// Converters natural-language text → IPA phonemes before tokenization.
  final TextToPhonemes _g2p;

  /// Synthesis speed factor fed to the model's `speed` input (1.0 = normal).
  final double speed;

  /// Sync (enclosing isolate) check that the ONNX model file exists.
  bool get hasModel => File(_modelPath).existsSync();

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    if (!hasModel) {
      throw const EngineModelNotFoundError(
        'Kokoro ONNX model not found; download it first.',
      );
    }

    final voicesFile = File(_voicesPath);
    final tokenizerFile = File(_tokenizerPath);
    if (!voicesFile.existsSync()) {
      throw EngineModelLoadError(
        'Kokoro voice/style artifact not found at $_voicesPath; '
        'download it first.',
      );
    }
    if (!tokenizerFile.existsSync()) {
      // The tokenizer is embedded as a fallback, so a missing tokenizer.json is
      // not fatal — log and use the fallback vocabulary.
      if (kDebugMode) {
        debugPrint(
          'Kokoro tokenizer artifact missing at $_tokenizerPath; '
          'using built-in vocabulary.',
        );
      }
    }

    // 1) G2P: natural-language text → IPA phonemes.
    final phonemes = _g2p.convert(text);

    // 2) Tokenize: IPA phonemes → padded integer ids.
    final tokenizer = tokenizerFile.existsSync()
        ? _loadTokenizer(tokenizerFile)
        : KokoroTokenizer();
    final ids = tokenizer.encode(phonemes);
    // `ids` is `[0, ...content, 0]` (padded). The style vector is indexed by
    // the *content* token count (`len(tokens)` before pads are added), matching
    // the reference: `ref_s = voices[len(tokens)]` then `tokens = [[0, *tokens, 0]]`
    // (onnx-community/Kokoro-82M-v1.0-ONNX README). MUST be re-validated
    // on-device against the real model.
    final contentCount = ids.length - 2;

    // 3) Load the style vector for this token count.
    final style = _loadStyle(voicesFile, contentCount);

    // 4) Run the ONNX graph.
    final session = _sessionFactory(File(_modelPath));
    try {
      final rawAudio = await session.run(
        inputIds: ids,
        style: style,
        speed: Float32List.fromList([speed]),
      );
      if (rawAudio.isEmpty) {
        throw const EngineInferenceError(
          'Kokoro produced empty audio for this utterance.',
        );
      }

      // 5) Resample 24 kHz → requested rate and convert float → PCM16.
      return resamplePcm16(
        rawAudio,
        inputRate: kKokoroSampleRate,
        outputRate: sampleRate,
      );
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineInferenceError('Kokoro synthesis failed: $e');
    } finally {
      session.release();
    }
  }

  static KokoroTokenizer _loadTokenizer(File file) {
    try {
      final json = file.readAsStringSync();
      return KokoroTokenizer.fromJson(json);
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Kokoro tokenizer.json could not be parsed ($e); '
            'using built-in vocabulary.');
      }
      return KokoroTokenizer();
    }
  }

  static Float32List _loadStyle(File voicesFile, int tokenCount) {
    final bytes = voicesFile.readAsBytesSync();
    final voices = KokoroVoices.fromBytes(bytes);
    return voices.styleFor(tokenCount);
  }

  static String _defaultAdjacent(String modelPath, String fileName) {
    final dir = File(modelPath).parent.path;
    return '$dir/$fileName';
  }
}
