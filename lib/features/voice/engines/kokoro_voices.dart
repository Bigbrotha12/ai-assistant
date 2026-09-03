import 'dart:typed_data';

import '../engine_errors.dart';

/// Parser for Kokoro voice/style `.bin` artifacts.
///
/// ## Layout (verified from the `onnx-community/Kokoro-82M-v1.0-ONNX` repo)
///
/// Each voice file (e.g. `voices/af.bin`, `voices/af_heart.bin`) is a flat
/// `float32` array reshaped **row-major** as `[n_vectors, 1, 256]`:
///
/// ```py
/// voices = np.fromfile(path, dtype=np.float32).reshape(-1, 1, 256)
/// ref_s  = voices[len(tokens)]   # → shape [1, 256]
/// ```
///
/// The **row index equals the *content* token count** of the phoneme sequence
/// (i.e. the token ids BEFORE the leading/trailing pad ids are added). The
/// reference indexes by content length: it looks up `voices[len(tokens)]` while
/// `tokens` is still unpadded, and only then wraps with `tokens = [[0, *tokens, 0]]`.

/// A voice file must therefore hold at least `maxTokens + 1` rows (content
/// token count 0 .. 510 inclusive → ≥ 511 rows). The packed `af.bin` ships
/// **512 rows** (524288 bytes = 512×256 floats), which covers every valid
/// content token count. This convention MUST be re-validated on-device against
/// the real model before shipping.
class KokoroVoices {
  KokoroVoices._(this._floats, this.dim);

  /// Raw float32 payload.
  final Float32List _floats;

  /// Dimension of each style vector (256 for Kokoro).
  final int dim;

  /// Number of style vectors held by this artifact.
  int get rowCount => _floats.length ~/ dim;

  /// Returns the style vector (length [dim]) for a sequence of [tokenCount]
  /// **content** phoneme tokens (i.e. the unpadded count), as expected for the
  /// model's `style=[1,256]` float32 input. This mirrors the reference lookup
  /// `voices[len(tokens)]` (see class docs).
  ///
  /// Throws [EngineModelLoadError] if [tokenCount] is out of range for the
  /// artifact (too short a file, or a too-long token sequence).
  Float32List styleFor(int tokenCount) {
    if (tokenCount < 0 || tokenCount >= rowCount) {
      throw EngineModelLoadError(
        'Voice style vector index $tokenCount out of range '
        '(file holds $rowCount vectors)',
      );
    }
    return Float32List.sublistView(_floats, tokenCount * dim, (tokenCount + 1) * dim);
  }

  /// Parses a voice `.bin` file from raw bytes.
  ///
  /// The file must contain a whole number of `dim`-sized vectors. [dim]
  /// defaults to 256 (Kokoro's style dimension).
  static KokoroVoices fromBytes(Uint8List bytes, {int dim = 256}) {
    if (bytes.length % (dim * 4) != 0) {
      throw EngineModelLoadError(
        'Voice file byte length ${bytes.length} is not a whole multiple of '
        '$dim float32 ($dim*4 bytes); cannot reshape row-major.',
      );
    }
    final floats = Float32List.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes ~/ 4);
    return KokoroVoices._(floats, dim);
  }
}
