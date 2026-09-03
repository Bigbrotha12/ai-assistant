import 'dart:convert';

/// Deterministic IPA → integer token-id tokenizer for the Kokoro-82M model.
///
/// Kokoro is a phoneme-conditioned TTS: text is first converted to phonemes
/// (via `misaki`/espeak off-device, or an on-device G2P), and each phoneme (an
/// IPA character) is mapped to an integer id using the model's vocabulary.
/// This class implements that phoneme-string → id mapping, data-driven from
/// Kokoro's real `tokenizer.json` (or the built-in fallback copy of the same
/// map).
///
/// ## Vocabulary source
///
/// The authoritative map is the model's `model.vocab` — identical between
/// `onnx-community/Kokoro-82M-v1.0-ONNX` `tokenizer.json` and the
/// `hexgrad/Kokoro-82M` `config.json` at commit
/// `785407d1adfa7ae8fbef8ffd85f34ca127da3039`. [loadFromJson] parses the
/// former when a downloaded copy is present; otherwise [encode] falls back to
/// the built-in [fallbackVocab] (the same map, embedded so synthesis is
/// deterministic and works even if the tokenizer artifact is missing).
///
/// ## Context length
///
/// The model has a context length of 512, but leaves both an initial and a
/// trailing pad token (id 0) slot: `assert len(tokens) <= 510`. [encode] pads
/// to `[0, ...ids, 0]` and clamps to ≤ [maxTokens] (default 510) by truncating
/// the tail.
class KokoroTokenizer {
  /// Creates a tokenizer that resolves phonemes against [vocab].
  ///
  /// If [vocab] is omitted, [fallbackVocab] is used (the embedded, verified
  /// Kokoro vocabulary — see class docs).
  KokoroTokenizer({Map<String, int>? vocab})
      : vocab = vocab ?? fallbackVocab,
        _longest = (vocab ?? fallbackVocab).keys.fold<int>(
          0,
          (m, k) => k.length > m ? k.length : m,
        );

  /// The phoneme → id vocabulary in use.
  final Map<String, int> vocab;

  /// Longest key in [vocab] (for greedy longest-prefix matching).
  final int _longest;

  /// Pad/eos token id (`$`).
  static const int padTokenId = 0;

  /// Maximum number of *content* tokens (before pad wrapping). The model
  /// context is 512 and reserves one pad token at each end → ≤ 510 content ids.
  static const int maxTokens = 510;

  /// Builds a [KokoroTokenizer] from a downloaded `tokenizer.json` payload.
  ///
  /// Throws [FormatException] if [json] is not the expected structure.
  factory KokoroTokenizer.fromJson(String json) {
    final decoded = jsonDecode(json);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('tokenizer.json must be a JSON object');
    }
    final model = decoded['model'];
    if (model is! Map<String, dynamic>) {
      throw const FormatException('tokenizer.json missing "model" object');
    }
    final vocab = model['vocab'];
    if (vocab is! Map<String, dynamic>) {
      throw const FormatException('tokenizer.json missing "model.vocab"');
    }
    final map = <String, int>{
      for (final e in vocab.entries) e.key: _asInt(e.value),
    };
    if (map.isEmpty) {
      throw const FormatException('tokenizer.json vocab is empty');
    }
    return KokoroTokenizer(vocab: map);
  }

  static int _asInt(Object? v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    throw FormatException('Vocab value is not an integer: $v');
  }

  /// Encodes an IPA phoneme string into padded integer token ids.
  ///
  /// Returns `[0, ...contentIds, 0]` where `contentIds` are the vocab id for
  /// each known phoneme (unknown characters are skipped, matching Kokoro's
  /// character filter). The content is clamped to [maxTokens].
  List<int> encode(String phonemes) {
    final content = <int>[];
    var i = 0;
    while (i < phonemes.length) {
      int? id;
      var len = _longest;
      // Greedy longest-prefix match against the vocab (also handles
      // multi-char IPA graphemes should the vocabulary ever use them).
      for (; len >= 1; len--) {
        if (i + len > phonemes.length) continue;
        final slice = phonemes.substring(i, i + len);
        final hit = vocab[slice];
        if (hit != null) {
          id = hit;
          break;
        }
      }
      if (id != null) {
        content.add(id);
        i += len;
      } else {
        // Unknown phoneme: drop it and move on (Kokoro filters non-vocab chars).
        i += 1;
      }
    }
    return wrap(content);
  }

  /// Wraps [content] with the initial/trailing pad tokens and clamps length.
  ///
  /// Content longer than [maxTokens] is truncated (safe: Kokoro's G2P output
  /// for a single on-device utterance rarely exceeds this, but the model
  /// would otherwise reject the padded sequence).
  List<int> wrap(List<int> content) {
    final trimmed = content.length <= maxTokens
        ? content
        : content.sublist(0, maxTokens);
    return [padTokenId, ...trimmed, padTokenId];
  }

  /// The verified Kokoro-82M phoneme → id vocabulary (fallback / canonical
  /// deterministic source). Mirrors `oll`-eval `model.vocab` from
  /// `onnx-community/Kokoro-82M-v1.0-ONNX` `tokenizer.json`.
  static const Map<String, int> fallbackVocab = <String, int>{
    r'$': 0, // pad / end
    ';': 1,
    ':': 2,
    ',': 3,
    '.': 4,
    '!': 5,
    '?': 6,
    '\u2014': 9, // —
    '\u2026': 10, // …
    '"': 11,
    '(': 12,
    ')': 13,
    '\u201c': 14, // “
    '\u201d': 15, // ”
    ' ': 16,
    '\u0303': 17, // combining tilde
    '\u02a3': 18, // ʣ
    '\u02a5': 19, // ʥ
    '\u02a6': 20, // ʦ
    '\u02a8': 21, // ʨ
    '\u1d5d': 22, // ᵝ
    '\uab67': 23, // ꭧ
    'A': 24,
    'I': 25,
    'O': 31,
    'Q': 33,
    'S': 35,
    'T': 36,
    'W': 39,
    'Y': 41,
    '\u1d4a': 42, // ᵊ
    'a': 43,
    'b': 44,
    'c': 45,
    'd': 46,
    'e': 47,
    'f': 48,
    'h': 50,
    'i': 51,
    'j': 52,
    'k': 53,
    'l': 54,
    'm': 55,
    'n': 56,
    'o': 57,
    'p': 58,
    'q': 59,
    'r': 60,
    's': 61,
    't': 62,
    'u': 63,
    'v': 64,
    'w': 65,
    'x': 66,
    'y': 67,
    'z': 68,
    '\u0251': 69, // ɑ
    '\u0250': 70, // ɐ
    '\u0252': 71, // ɒ
    '\u00e6': 72, // æ
    '\u03b2': 75, // β
    '\u0254': 76, // ɔ
    '\u0255': 77, // ɕ
    '\u00e7': 78, // ç
    '\u0256': 80, // ɖ
    '\u00f0': 81, // ð
    '\u02a4': 82, // ʤ
    '\u0259': 83, // ə
    '\u025a': 85, // ɚ
    '\u025b': 86, // ɛ
    '\u025c': 87, // ɜ
    '\u025f': 90, // ɟ
    '\u0261': 92, // ɡ
    '\u0265': 99, // ɥ
    '\u0268': 101, // ɨ
    '\u026a': 102, // ɪ
    '\u029d': 103, // ʝ
    '\u026f': 110, // ɯ
    '\u0270': 111, // ɰ
    '\u014b': 112, // ŋ
    '\u0273': 113, // ɳ
    '\u0272': 114, // ɲ
    '\u0274': 115, // ɴ
    '\u00f8': 116, // ø
    '\u0278': 118, // ɸ
    '\u03b8': 119, // θ
    '\u0153': 120, // œ
    '\u0279': 123, // ɹ
    '\u027e': 125, // ɾ
    '\u027b': 126, // ɻ
    '\u0281': 128, // ʁ
    '\u027d': 129, // ɽ
    '\u0282': 130, // ʂ
    '\u0283': 131, // ʃ
    '\u0288': 132, // ʈ
    '\u02a7': 133, // ʧ
    '\u028a': 135, // ʊ
    '\u028b': 136, // ʋ
    '\u028c': 138, // ʌ
    '\u0263': 139, // ɣ
    '\u0264': 140, // ɤ
    '\u03c7': 142, // χ
    '\u028e': 143, // ʎ
    '\u0292': 147, // ʒ
    '\u0294': 148, // ʔ
    '\u02c8': 156, // ˈ
    '\u02cc': 157, // ˌ
    '\u02d0': 158, // ː
    '\u02b0': 162, // ʰ
    '\u02b2': 164, // ʲ
    '\u2193': 169, // ↓
    '\u2192': 171, // →
    '\u2197': 172, // ↗
    '\u2198': 173, // ↘
    '\u1d7b': 177, // ᵻ
  };
}
