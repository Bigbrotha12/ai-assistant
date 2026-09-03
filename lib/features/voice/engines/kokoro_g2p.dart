/// Text-to-phonemes (G2P) boundary for the Kokoro TTS engine.
///
/// Kokoro is a phoneme-conditioned model: it does not accept natural-language
/// text, it accepts a string of IPA phonemes (normally produced off-device by
/// `misaki`/espeak-ng). The engine therefore needs a G2P stage to convert
/// natural-language `text` into an IPA phoneme string before the
/// [KokoroTokenizer] maps it to integer ids.
///
/// [TextToPhonemes] is the seam between raw text and the phoneme string. The
/// engine depends on this abstraction (constructed via an injectable factory)
/// so:
///
///  * the default [KokoroG2P] heuristic can be swapped for a higher-fidelity,
///    misaki-quality G2P later without touching the engine; and
///  * unit tests can inject a deterministic/pass-through phoneme source to
///    exercise the tokenizer + ONNX pipeline in isolation.
library;

/// Converts natural-language text into an IPA phoneme string suitable for
/// [KokoroTokenizer.encode].
abstract interface class TextToPhonemes {
  /// Returns the IPA phoneme string for [text].
  ///
  /// The output is composed of characters that [KokoroTokenizer] resolves via
  /// greedy longest-prefix matching against the Kokoro vocabulary (see
  /// `KokoroTokenizer.fallbackVocab`).
  String convert(String text);
}

/// Creates the [TextToPhonemes] used by [KokoroTtsEngine] by default.
typedef G2PFactory = TextToPhonemes Function();

/// Default production G2P factory backed by the [KokoroG2P] heuristic.
TextToPhonemes createKokoroG2P() => KokoroG2P();

/// A pragmatic, well-documented **heuristic** English grapheme-to-phoneme
/// (G2P) converter.
///
/// ## IMPORTANT — provisional, must be validated on-device
///
/// This is NOT a `misaki`-quality G2P. It is a deterministic letter/digraph
/// rule set that produces *plausible* IPA for common English spelling
/// patterns, sufficient to drive the synthesis pipeline end-to-end. It will
/// mispronounce irregular words, and its stress/tone placement is minimal.
/// A full `misaki`-quality G2P is an explicitly-noted follow-up; the
/// [TextToPhonemes] abstraction is exactly where that higher-fidelity backend
/// should slot in. **Do not rely on this for production-quality pronunciation
/// without on-device validation and replacement.**
///
/// ## Approach
///
/// Text is lowercased, split into whitespace-delimited words, and each word is
/// converted left-to-right by greedily matching the longest grapheme (up to
/// 3 chars) against an IPA mapping table, falling back to a per-letter mapping
/// for unknown characters. A trailing silent-e pass lengthens the preceding
/// vowel (magic-e). The phonemes of each word are joined with the space token.
class KokoroG2P implements TextToPhonemes {
  /// Creates a heuristic English G2P.
  KokoroG2P();

  static const _maxGrapheme = 3;

  /// Grapheme → IPA mapping; matched longest-first at each position.
  static const Map<String, String> _graphemes = <String, String>{
    // --- vowel digraphs (long / diphthongs) ---
    'ee': 'iː',
    'ea': 'iː',
    'oo': 'uː',
    'ai': 'eɪ',
    'ay': 'eɪ',
    'ey': 'eɪ',
    'oa': 'oʊ',
    'ou': 'aʊ',
    'igh': 'aɪ',
    'ie': 'aɪ',
    'aw': 'ɔː',
    'au': 'ɔː',
    'oi': 'ɔɪ',
    'oy': 'ɔɪ',
    'ew': 'juː',
    // --- consonant digraphs ---
    'th': 'θ', // voiced ð handled contextually by _voicedTh
    'sh': 'ʃ',
    'ch': 'ʧ',
    'tch': 'ʧ',
    'ph': 'f',
    'ck': 'k',
    'qu': 'kw',
    'wh': 'w',
    'ng': 'ŋ',
    'nk': 'ŋk',
    'ge': 'ʤ',
    'gi': 'ʤ',
    'gy': 'ʤ',
    'dge': 'ʤ',
    'tion': 'ʃən',
    'sion': 'ʒən',
    // --- single consonants ---
    'b': 'b',
    'c': 'k',
    'd': 'd',
    'f': 'f',
    'g': 'ɡ',
    'h': 'h',
    'j': 'ʤ',
    'k': 'k',
    'l': 'l',
    'm': 'm',
    'n': 'n',
    'p': 'p',
    'q': 'k',
    'r': 'ɹ',
    's': 's',
    't': 't',
    'v': 'v',
    'w': 'w',
    'x': 'ks',
    'z': 'z',
    // --- single vowels (short, default) ---
    'a': 'æ',
    'e': 'ɛ',
    'i': 'ɪ',
    'o': 'ɒ',
    'u': 'ʌ',
    'y': 'j',
  };

  /// Single-vowel *phonemes* (as emitted by the short-vowel rules) whose value
  /// is replaced by a long value under magic-e (a trailing silent `e`).
  static const Map<String, String> _magicE = <String, String>{
    'æ': 'eɪ', // a → long a
    'ɛ': 'iː', // e → long e
    'ɪ': 'aɪ', // i → long i
    'ɒ': 'oʊ', // o → long o
    'ʌ': 'juː', // u → long u
  };

  @override
  String convert(String text) {
    final words = text.toLowerCase().split(RegExp(r'\s+'));
    final phonemes = <String>[];
    for (final word in words) {
      if (word.isEmpty) continue;
      phonemes.add(_convertWord(word));
    }
    return phonemes.join(' ');
  }

  /// Converts a single lowercase word to an IPA string.
  String _convertWord(String word) {
    // Convert left-to-right, greedily matching the longest grapheme.
    final out = StringBuffer();
    var i = 0;
    while (i < word.length) {
      // magic-e: a final single `e` (length>1, not a known vowel digraph).
      if (i == word.length - 1 &&
          word[i] == 'e' &&
          word.length > 1 &&
          !_endsInDiphthong(word)) {
        // Single-consonant + e ("be"/"he"/"we"/"me"): the final e IS the
        // (long) vowel, so emit it directly.
        if (word.length == 2 && !_isVowelLetter(word[0])) {
          out.write('iː');
          i++;
          continue;
        }
        // Otherwise, when stripping the e still leaves a vowel, treat it as
        // silent and lengthen the preceding vowel ("make" → meɪk).
        if (_hasVowelBeforeLastE(word)) {
          _lengthenLastVowel(out);
          i++;
          continue;
        }
        // Fall through → the final e is a real vowel, emit it normally.
      }

      var matched = false;
      for (var len = _maxGrapheme; len >= 1; len--) {
        if (i + len > word.length) continue;
        final slice = word.substring(i, i + len);
        final ipa = _graphemes[slice];
        if (ipa != null) {
          // contextual /ð/ for 'th' between (or near) vowels
          if (slice == 'th') {
            out.write(_voicedTh(word, i) ? 'ð' : 'θ');
          } else {
            out.write(ipa);
          }
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Fallback per-character mapping for content not in the table.
        out.write(_fallbackLetter(word[i]));
        i++;
      }
    }
    return out.toString();
  }

  /// Whether [word] ends in a vowel digraph that "consumes" the final `e`
  /// (so it is NOT treated as a silent magic-e).
  static bool _endsInDiphthong(String word) {
    if (word.length < 2) return false;
    final tail = word.substring(word.length - 2);
    const diphthongs = {
      'ee',
      'ie',
      'oe',
      'ye',
      'ue',
      'ai',
      'ay',
      'ey',
      'ea',
      'oo',
      'ou',
      'aw',
      'au',
      'oi',
      'oy',
    };
    return diphthongs.contains(tail);
  }

  /// Whether stripping the final `e` from [word] still leaves a vowel — used
  /// to avoid swallowing a needed vowel from consonant-cluster words like
  /// "the".
  static bool _hasVowelBeforeLastE(String word) {
    if (word.length < 2) return false;
    return word.substring(0, word.length - 1).contains(RegExp(r'[aeiou]'));
  }

  static bool _isVowelLetter(String c) => 'aeiou'.contains(c);

  /// Rewrites the last vowel emitted into [out] to its long (magic-e) value.
  /// Best-effort: scans from the end for the last vowel character.
  static void _lengthenLastVowel(StringBuffer out) {
    final s = out.toString();
    final idx = _lastVowelIndex(s);
    if (idx < 0) return;
    final shortVowel = s[idx];
    final longVowel = _magicE[shortVowel];
    if (longVowel == null) return;
    // Rebuild with the vowel replaced by its long form.
    final rebuilt = StringBuffer()
      ..write(s.substring(0, idx))
      ..write(longVowel)
      ..write(s.substring(idx + 1));
    out.clear();
    out.write(rebuilt);
  }

  static int _lastVowelIndex(String s) {
    for (var i = s.length - 1; i >= 0; i--) {
      if (_magicE.containsKey(s[i])) return i;
    }
    return -1;
  }

  /// Chooses voiced /ð/ vs voiceless /θ/ for 'th' based on surrounding
  /// characters (a rough heuristic: voiced when between vowels/finals).
  static bool _voicedTh(String word, int index) {
    // Voiced when preceded by a vowel character (rough approximation).
    if (index > 0) {
      final prev = word[index - 1];
      if (_voicedContextLetter(prev)) return true;
    }
    if (index + 2 < word.length) {
      final next = word[index + 2];
      if (_voicedContextLetter(next)) return true;
    }
    return false;
  }

  static bool _voicedContextLetter(String c) {
    return 'aeioursl'.contains(c);
  }

  /// Maps a single character to an IPA phoneme, falling back to a space-liked
  /// separator for characters we cannot represent.
  static String _fallbackLetter(String c) {
    if (RegExp(r'[a-z]').hasMatch(c)) {
      return _graphemes[c] ?? '';
    }
    return '';
  }
}
