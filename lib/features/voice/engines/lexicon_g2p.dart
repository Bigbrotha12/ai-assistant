// The lexicon/fallback constructor seam uses a public parameter name for a
// private field (test injectability); the initializing-formals lint is muted.
// ignore_for_file: prefer_initializing_formals

import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;

import 'kokoro_g2p.dart';

export 'kokoro_g2p.dart' show TextToPhonemes;

/// Lexicon-backed English grapheme-to-phoneme converter for Kokoro.
///
/// Pipeline: text normalisation (numbers, currency, ordinals) → word lookup
/// in the CMU Pronouncing Dictionary (bundled, 0.7b, 134k words) with
/// regular-suffix fallback (-s/-ed/-ing/'s) → heuristic fallback for
/// out-of-vocabulary words. Pronunciations carry primary/secondary stress
/// marks (ˈ/ˌ) the same way Kokoro's reference G2P (`misaki`) emits them,
/// which is where the bulk of the naturalness over the letter-rule heuristic
/// comes from.
///
/// The bundled dictionary is CMUdict 0.7b (BSD-style licence, redistribution
/// with attribution permitted — the original header ships inside the asset).
///
/// The engine calls [ensureLoaded] once before synthesis; until then
/// [convert] degrades to the heuristic fallback, so a first utterance racing
/// the load never fails.
class LexiconG2P implements TextToPhonemes {
  LexiconG2P({
    Map<String, String>? lexicon,
    TextToPhonemes? fallback,
    this.assetPath = defaultAssetPath,
  }) : _lexicon = lexicon,
       _fallback = fallback ?? KokoroG2P();

  /// Bundled CMUdict (gzipped plain text).
  static const String defaultAssetPath = 'assets/g2p/cmudict-0.7b.gz';

  /// Asset path the dictionary loads from (injectable for tests).
  final String assetPath;

  /// Word (UPPERCASE) → space-separated ARPAbet phones with stress digits.
  Map<String, String>? _lexicon;
  final TextToPhonemes _fallback;
  Future<void>? _loading;

  /// Loads the bundled dictionary. Memoised; safe to call repeatedly.
  @override
  Future<void> ensureLoaded() {
    if (_lexicon != null) return Future.value();
    return _loading ??= _load();
  }

  Future<void> _load() async {
    try {
      final bytes = await rootBundle.load(assetPath);
      final text = utf8.decode(
        bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
        allowMalformed: true,
      );
      _lexicon = parseCmuDict(text);
    } catch (e) {
      // A missing/corrupt dictionary must never break synthesis: degrade to
      // the heuristic permanently and remember the failure so we do not
      // retry every turn.
      assert(() {
        // ignore: avoid_print
        print('LexiconG2P: failed to load $assetPath ($e); using heuristic.');
        return true;
      }());
      _lexicon = const {};
    }
  }

  /// Parses CMUdict text (one `WORD  PHONE PHONE...` per line, `;;;`
  /// comments, `(n)` pronunciation-variant suffixes) into a lookup map.
  /// Later duplicate entries do not override earlier ones; unnumbered
  /// entries win over `(1)` variants.
  static Map<String, String> parseCmuDict(String text) {
    final dict = <String, String>{};
    for (final line in text.split('\n')) {
      if (line.isEmpty || line.startsWith(';;;')) continue;
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      final split = trimmed.indexOf(RegExp(r'\s'));
      if (split <= 0) continue;
      var word = trimmed.substring(0, split).toUpperCase();
      final phones = trimmed.substring(split + 1).trim();
      if (phones.isEmpty) continue;
      // "ABNORMAL(1)" → "ABNORMAL": first entry for a word wins.
      final paren = word.indexOf('(');
      if (paren > 0) word = word.substring(0, paren);
      dict.putIfAbsent(word, () => phones);
    }
    return dict;
  }

  @override
  String convert(String text) {
    final lexicon = _lexicon;
    if (lexicon == null || lexicon.isEmpty) {
      // Dictionary not available (load racing first use, or load failed):
      // pure heuristic, same behaviour as before this backend existed.
      return _fallback.convert(text);
    }

    final phonemes = <String>[];
    for (final token in _normalize(text).split(RegExp(r'\s+'))) {
      if (token.isEmpty) continue;
      final converted = _convertToken(token);
      if (converted.isNotEmpty) phonemes.add(converted);
    }
    return phonemes.join(' ');
  }

  /// Converts one whitespace-delimited token: punctuation → pause token,
  /// dictionary word (with suffix fallback) → IPA, anything else → heuristic.
  String _convertToken(String token) {
    // Peel pause punctuation off both ends so "hello," and "world!" keep
    // their pause tokens.
    var start = 0;
    while (start < token.length && _pauseTokens.contains(token[start])) {
      start++;
    }
    var end = token.length;
    while (end > start && _pauseTokens.contains(token[end - 1])) {
      end--;
    }
    final leading = token.substring(0, start);
    final trailing = token.substring(end);
    final word = token
        .substring(start, end)
        .replaceAll(RegExp(r"[^a-z']"), '');
    final out = <String>[];
    if (leading.isNotEmpty) out.add(leading);
    if (word.isNotEmpty) out.add(_convertWord(word));
    if (trailing.isNotEmpty) out.add(trailing);
    return out.join(' ');
  }

  /// Word → IPA. Order: exact dictionary hit → inflection-stripped hit →
  /// heuristic letter rules.
  String _convertWord(String word) {
    final upper = word.toUpperCase().replaceAll(RegExp(r"['’]"), "'");
    final lexicon = _lexicon;
    if (lexicon != null) {
      final direct = lexicon[upper];
      if (direct != null) {
        return _phonesToIpa(direct);
      }
      final inflected = _convertWithSuffix(word, upper);
      if (inflected != null) return inflected;
    }
    return _fallback.convert(word);
  }

  /// Regular-inflection fallback: try stem lookups for -s/-es/-ed/-ing/'s
  /// and append the regular suffix phonemes.
  String? _convertWithSuffix(String word, String upper) {
    String? stem;
    if (upper.endsWith("'S") || upper.endsWith("’S")) {
      stem = upper.substring(0, upper.length - 2);
    } else if (upper.endsWith('S')) {
      stem = upper.substring(0, upper.length - 1);
      if (upper.endsWith('ES') && !upper.endsWith('SES')) {
        stem = upper.substring(0, upper.length - 2);
      }
    } else if (upper.endsWith('ED')) {
      stem = upper.substring(0, upper.length - 2);
    } else if (upper.endsWith('ING')) {
      stem = upper.substring(0, upper.length - 3);
    } else {
      return null;
    }

    var stemPhones = _lookupStem(stem);
    if (stemPhones == null && upper.endsWith('ED')) {
      // Doubled consonant: "stopped" → STOP.
      stemPhones = _lookupStem(upper.substring(0, upper.length - 3));
    }
    if (stemPhones == null && upper.endsWith('ING')) {
      // "coming" → COME (e-dropping), "running" → RUN (doubling).
      stemPhones ??= _lookupStem('${stem}E');
      stemPhones ??= _lookupStem(stem.substring(0, stem.length - 1));
    }
    if (stemPhones == null) return null;

    final stemIpa = _phonesToIpa(stemPhones);
    if (stemIpa.isEmpty) return null;
    final String suffix;
    if (upper.endsWith('ED')) {
      final ed = _edSuffix(stemIpa);
      if (ed == null) return null;
      suffix = ed;
    } else if (upper.endsWith('ING')) {
      suffix = 'ɪŋ';
    } else {
      final s = _pluralSuffix(stemIpa);
      if (s == null) return null;
      suffix = s;
    }
    return '$stemIpa$suffix';
  }

  String? _lookupStem(String stem) {
    final lexicon = _lexicon;
    if (lexicon == null) return null;
    if (stem.isEmpty) return null;
    return lexicon[stem];
  }

  /// /z/, /s/, or /ɪz/ depending on the stem's final phone.
  String? _pluralSuffix(String? stemPhones) {
    if (stemPhones == null) return null;
    final last = _lastIpaPhone(stemPhones);
    if (last == null) return null;
    if (_sibilants.contains(last)) return 'ɪz';
    return _voiceless.contains(last) ? 's' : 'z';
  }

  /// /t/, /d/, or /ɪd/ depending on the stem's final phone.
  String? _edSuffix(String stemPhones) {
    final last = _lastIpaPhone(stemPhones);
    if (last == null) return null;
    if (last == 't' || last == 'd') return 'ɪd';
    return _voiceless.contains(last) ? 't' : 'd';
  }

  /// The final IPA phone (multi-char phones like iː kept whole).
  static const _vowels = {
    'ɑ', 'ɐ', 'ɒ', 'æ', 'ɔ', 'ə', 'ɚ', 'ɛ', 'ɜ', 'ɪ', 'ɨ', 'o', 'u', 'ʌ',
    'e', 'a', 'i',
  };
  static const _sibilants = {'s', 'z', 'ʃ', 'ʒ', 'ʧ', 'ʤ'};
  static const _voiceless = {'p', 'k', 't', 'f', 'θ', 's', 'ʃ', 'ʧ', 'h'};

  String? _lastIpaPhone(String ipa) {
    if (ipa.isEmpty) return null;
    // Length marks and stress marks bind to the preceding vowel.
    final chars = ipa.runes.toList();
    var i = chars.length - 1;
    while (i > 0 &&
        (String.fromCharCode(chars[i]) == 'ː' ||
            String.fromCharCode(chars[i]) == 'ˈ' ||
            String.fromCharCode(chars[i]) == 'ˌ')) {
      i--;
    }
    return String.fromCharCode(chars[i]);
  }

  /// Converts a space-separated ARPAbet phone string (with stress digits)
  /// into the IPA string Kokoro expects, inserting ˈ/ˌ before stressed
  /// syllables. Single-vowel words carry no stress mark.
  String _phonesToIpa(String phones) {
    final parts = phones.split(RegExp(r'\s+'))..removeWhere((p) => p.isEmpty);

    final segments = <({String ipa, bool primary, bool secondary})>[];
    for (final part in parts) {
      final stress = part.endsWith('0') ||
          part.endsWith('1') ||
          part.endsWith('2')
          ? int.parse(part[part.length - 1])
          : -1;
      final phone = stress >= 0 ? part.substring(0, part.length - 1) : part;
      final ipa = _phoneIpa(phone, stress);
      if (ipa == null) continue;
      segments.add((
        ipa: ipa,
        primary: stress == 1,
        secondary: stress == 2,
      ));
    }

    final vowelCount = segments.where((s) => _hasVowel(s.ipa)).length;
    final out = StringBuffer();
    for (final segment in segments) {
      final mark = segment.primary
          ? 'ˈ'
          : segment.secondary
              ? 'ˌ'
              : '';
      // A lone vowel gets no mark; misaki-style, monosyllables are unmarked.
      final shouldMark =
          mark.isNotEmpty && vowelCount > 1 && _hasVowel(segment.ipa);
      if (shouldMark) out.write(mark);
      out.write(segment.ipa);
    }
    return out.toString();
  }

  /// Per-phone IPA, with CMUdict quirks handled: AH0 → schwa, ER stressed →
  /// ɜːɹ, ER unstressed → ɚ.
  String? _phoneIpa(String phone, int stress) {
    switch (phone) {
      case 'AH':
        return stress == 0 ? 'ə' : 'ʌ';
      case 'ER':
        return stress == 0 ? 'ɚ' : 'ɜːɹ';
      default:
        return _arpabetToIpa[phone];
    }
  }

  bool _hasVowel(String ipa) => ipa.runes.any(
        (r) => _vowels.contains(String.fromCharCode(r)),
      );

  /// Punctuation the tokenizer maps to pause tokens (kept for prosody).
  static const _pauseTokens = {',', '.', '!', '?', ';', ':', '…', '—'};

  /// Normalises text before lookup: numbers → words, currency/percent →
  /// spoken forms, '&'/'+' → words. Sentence punctuation survives (it drives
  /// pauses).
  String _normalize(String text) {
    var out = text
        .replaceAll('—', ' — ')
        .replaceAll('…', '…')
        .replaceAll('&', ' and ')
        .replaceAll('+', ' plus ')
        .replaceAll(RegExp(r'[“”"]'), ' ');
    out = out.replaceAllMapped(RegExp(r'\$(\d+)(?:\.(\d{1,2}))?'), (m) {
      final dollars = _numberToWords(int.parse(m.group(1)!));
      final cents = m.group(2);
      final centsValue = int.parse(cents ?? '0');
      final centsWords = centsValue == 0
          ? ''
          : ' ${_numberToWords(centsValue)} cent${centsValue == 1 ? '' : 's'}';
      return ' $dollars dollar${int.parse(m.group(1)!) == 1 ? '' : 's'}$centsWords ';
    });
    out = out.replaceAllMapped(RegExp(r'(\d+)\s?%'), (m) {
      final n = int.parse(m.group(1)!);
      return ' ${_numberToWords(n)} percent ';
    });
    out = out.replaceAllMapped(RegExp(r'\b(\d+)(st|nd|rd|th)\b'), (m) {
      final n = int.parse(m.group(1)!);
      final word = _ordinalToWords(n);
      return word == null ? m.group(0)! : ' $word ';
    });
    out = out.replaceAllMapped(
      RegExp(r'\b\d+\b'),
      (m) => ' ${_numberToWords(int.parse(m.group(0)!))} ',
    );
    return out.toLowerCase();
  }

  static const _ones = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ];
  static const _tens = [
    '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
    'eighty', 'ninety',
  ];

  /// Integers 0..999,999,999 → words ("forty two", "one million two
  /// thousand five").
  String _numberToWords(int n) {
    if (n < 0) return 'minus ${_numberToWords(-n)}';
    if (n < 20) return _ones[n];
    if (n < 100) {
      final t = _tens[n ~/ 10];
      final r = n % 10;
      return r == 0 ? t : '$t ${_ones[r]}';
    }
    if (n < 1000) {
      final h = '${_ones[n ~/ 100]} hundred';
      final r = n % 100;
      return r == 0 ? h : '$h ${_numberToWords(r)}';
    }
    if (n < 1000000) {
      final th = '${_numberToWords(n ~/ 1000)} thousand';
      final r = n % 1000;
      return r == 0 ? th : '$th ${_numberToWords(r)}';
    }
    final m = '${_numberToWords(n ~/ 1000000)} million';
    final r = n % 1000000;
    return r == 0 ? m : '$m ${_numberToWords(r)}';
  }

  String? _ordinalToWords(int n) {
    if (n <= 0) return null;
    final base = _numberToWords(n);
    final specials = <int, String>{
      1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth',
      9: 'ninth', 12: 'twelfth',
    };
    final special = specials[n];
    if (special != null) return special;
    if (base.endsWith('y')) return '${base.substring(0, base.length - 1)}ieth';
    if (base.endsWith('one')) return '${base.substring(0, base.length - 3)}first';
    if (base.endsWith('two')) return '${base.substring(0, base.length - 3)}second';
    if (base.endsWith('three')) return '${base.substring(0, base.length - 5)}third';
    if (base.endsWith('five')) return '${base.substring(0, base.length - 4)}fifth';
    if (base.endsWith('eight')) return '${base.substring(0, base.length - 5)}eighth';
    if (base.endsWith('nine')) return '${base.substring(0, base.length - 4)}ninth';
    if (base.endsWith('twelve')) return '${base.substring(0, base.length - 6)}twelfth';
    return '${base}th';
  }

  /// ARPAbet phone → IPA (defaults; AH/ER handled contextually in
  /// [_phoneIpa]). Every output character exists in KokoroTokenizer's vocab.
  static const Map<String, String> _arpabetToIpa = {
    'AA': 'ɑ',
    'AE': 'æ',
    'AO': 'ɔ',
    'AW': 'aʊ',
    'AY': 'aɪ',
    'B': 'b',
    'CH': 'ʧ',
    'D': 'd',
    'DH': 'ð',
    'EH': 'ɛ',
    'EY': 'eɪ',
    'F': 'f',
    'G': 'ɡ',
    'HH': 'h',
    'IH': 'ɪ',
    'IY': 'iː',
    'JH': 'ʤ',
    'K': 'k',
    'L': 'l',
    'M': 'm',
    'N': 'n',
    'NG': 'ŋ',
    'OW': 'oʊ',
    'OY': 'ɔɪ',
    'P': 'p',
    'R': 'ɹ',
    'S': 's',
    'SH': 'ʃ',
    'T': 't',
    'TH': 'θ',
    'UH': 'ʊ',
    'UW': 'uː',
    'V': 'v',
    'W': 'w',
    'Y': 'j',
    'Z': 'z',
    'ZH': 'ʒ',
  };
}
