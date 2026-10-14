/// Normalises reply text for synthesis so the TTS engine reads symbols and
/// abbreviations the way a human would.
///
/// On-device engines like Supertonic consume natural-language text directly
/// and expand plain words, but language symbols such as `€`, `%`, `&`, `°` and
/// common abbreviations (`e.g.`, `Mr.`) have no faithful pronunciation — the
/// model either reads them verbatim, mangles them, or produces dead air.
/// This pass rewrites those tokens into words BEFORE the engine sees them.
///
/// Applied only on the spoke-audio path ([VoiceController._enqueueText] /
/// [synthesizeOnDevice]); the text shown in the transcript is never rewritten.
///
/// Deliberately conservative:
///  * Numbers stay as digits — the model reads them fine, and verbose spelling
///    (ordinals, decimals, thousands separators) is error-prone.
///  * Only standalone symbols are expanded; no attempt to parse the full
///    measure — magnitude words ("€5 million") are the one exception.
///  * Emoji / silent unicode artifacts are dropped so they cannot produce
///    dead air or a skipped utterance.
final class SpeechTextNormalizer {
  SpeechTextNormalizer._();

  /// Currency symbol → (singular, plural) spoken form.
  static const Map<String, (String, String)> _currencies = <String, (String, String)>{
    '\u20AC': ('euro', 'euros'), // €
    '\$': ('dollar', 'dollars'),
    '\u00A3': ('pound', 'pounds'), // £
    '\u00A5': ('yen', 'yen'), // ¥
    '\u20B9': ('rupee', 'rupees'), // ₹
  };

  /// An amount: digits with optional thousands separators and decimals.
  /// The comma only binds when followed by further digits, so a trailing
  /// comma after the amount ("€5,") is never swallowed into "5,".
  /// Deliberately non-capturing — each use site wraps it in its own group so
  /// capture indices stay predictable.
  static final RegExp _amount =
      RegExp(r'[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?');

  /// An optional magnitude word directly after the amount ("€5 million").
  /// Capture group 1, absent for plain amounts.
  static final String _magnitude = r'(?:\s*(million|billion|trillion|thousand))?';

  /// Any currency symbol we expand.
  static final RegExp _currencySymbol = RegExp(
    _currencies.keys.map(RegExp.escape).join('|'),
  );

  /// Symbol before the amount (`€5`) and amount before the symbol (`5 €`),
  /// each with an optional trailing magnitude word (`€5 million`).
  static final RegExp _currencyBeforeAmount = RegExp(
    '(${_currencySymbol.pattern})\\s*(${_amount.pattern})$_magnitude',
  );
  static final RegExp _amountBeforeCurrency = RegExp(
    '(${_amount.pattern})$_magnitude\\s*(${_currencySymbol.pattern})',
  );

  /// `%` after an amount (`50%`, `50 %`); a lone `%` is expanded on its own.
  static final RegExp _percent =
      RegExp('(${_amount.pattern})\\s*%');
  static final RegExp _lonePercent = RegExp(r'%');

  /// `°C` / `°F` after an amount; a lone `°` becomes "degrees".
  static final RegExp _degrees =
      RegExp('(${_amount.pattern})\\s*\\u00B0\\s*([cCfF])');
  /// A bare unit with no amount ("the °C scale") — must not leave the C or F
  /// dangling off "degrees".
  static final RegExp _degreeUnit = RegExp(r'\u00B0\s*([cCfF])');
  static final RegExp _loneDegree = RegExp(r'\u00B0');

  /// A standalone ampersand (own token), so `AT&T` is never mangled.
  static final RegExp _ampersand = RegExp(r'(^|\s)&(?=\s|$)');

  /// Trailing token boundary for an abbreviation: the token (optionally
  /// period-terminated) must be followed by whitespace, sentence punctuation,
  /// or the end of the text — never a letter. This keeps `Dr` from matching
  /// the prefix of `drove`, `approx` of `approximately`, and `vs` of
  /// `vSphere`. The optional trailing period also covers the splitter's edge
  /// case where the period was consumed as a sentence boundary
  /// ("e.g. Five" → "e.g" + "Five").
  static final String _abbrTail = r'\.?(?=[\s,;:!?)\]}]|$)';

  /// Whole-token abbreviations, applied in order. Keys are bare tokens
  /// (`e.g`, `vs`, `approx`) matched case-insensitively; [_abbrTail] on the
  /// regex consumes the period. `Ms` is matched only with its period so
  /// millisecond timings ("15 ms") are untouched.
  static const List<(String, String)> _abbreviations = <(String, String)>[
    ('e.g', 'for example'),
    ('i.e', 'that is'),
    ('etc', 'et cetera'),
    ('vs', 'versus'),
    ('approx', 'approximately'),
    ('Mrs', 'missus'),
    ('Mr', 'mister'),
    ('Ms.', 'miss'),
    ('Dr', 'doctor'),
  ];

  /// Math/typographic symbols with a spoken form, applied as literal swaps.
  static const Map<String, String> _symbols = <String, String>{
    '\u00B1': 'plus or minus', // ±
    '\u2248': 'approximately', // ≈
    '\u00D7': 'times', // ×
    '\u00F7': 'divided by', // ÷
  };

  /// Code-point ranges (inclusive) of emoji and silent unicode artifacts that
  /// cannot be spoken. Dropped entirely so they never produce dead air.
  static const List<(int, int)> _removeRanges = <(int, int)>[
    (0x00A9, 0x00A9), // ©
    (0x00AE, 0x00AE), // ®
    (0x20E3, 0x20E3), // keycap combining enclose
    (0x2122, 0x2122), // ™
    (0x2190, 0x21FF), // arrows (→ ←) — dead air in model replies
    (0x2500, 0x257F), // box drawing (table remnants from stripped code fences)
    (0x2600, 0x27BF), // misc symbols, dingbats, legacy emoticons (★☀✈✎✓)
    (0x2B00, 0x2BFF), // misc symbols and arrows (⭐⭕)
    (0xFE0F, 0xFE0F), // variation selector-16 (emoji presentation)
    (0x200D, 0x200D), // zero-width joiner (ZWJ sequences)
    (0xFFFD, 0xFFFD), // replacement character (encoding failures)
    (0x1F000, 0x1FAFF), // whole emoji block (faces, hearts, flags, …
  ];

  /// Rewrites [text] into something the TTS engine can pronounce.
  ///
  /// Symbol expansion happens before artifact removal results are tidied, so
  /// the order is irrelevant to the tokens we care about. Empty text passes
  /// through unchanged.
  static String normalizeForSpeech(String text) {
    if (text.isEmpty) return text;
    var out = _dropSilentArtifacts(text);
    out = _expandCurrencies(out);
    out = out.replaceAllMapped(_percent, (m) => '${m.group(1)} percent');
    out = out.replaceAll(_lonePercent, ' percent');
    out = out.replaceAllMapped(
      _degrees,
      (m) =>
          '${m.group(1)} degrees ${m.group(2)!.toUpperCase() == 'C' ? 'Celsius' : 'Fahrenheit'}',
    );
    out = out.replaceAllMapped(
      _degreeUnit,
      (m) => 'degrees ${m.group(1)!.toUpperCase() == 'C' ? 'Celsius' : 'Fahrenheit'}',
    );
    out = out.replaceAll(_loneDegree, ' degrees');
    out = out.replaceAllMapped(
      _ampersand,
      (m) => '${m.group(1)}and',
    );
    for (final (token, words) in _abbreviations) {
      out = out.replaceAllMapped(
        RegExp('\\b${RegExp.escape(token)}$_abbrTail', caseSensitive: false),
        (_) => words,
      );
    }
    for (final MapEntry(key: symbol, value: words) in _symbols.entries) {
      // Pad so `±5` reads "plus or minus 5" ("± 5" keeps its space); the
      // final tidy collapses the doubled spaces.
      out = out.replaceAll(symbol, ' $words ');
    }
    return _tidy(out);
  }

  static String _expandCurrencies(String text) {
    var out = text.replaceAllMapped(
      _currencyBeforeAmount,
      (m) => _currencyWords(m.group(1)!, m.group(2)!, m.group(3)),
    );
    out = out.replaceAllMapped(
      _amountBeforeCurrency,
      (m) => _currencyWords(m.group(3)!, m.group(1)!, m.group(2)),
    );
    // A lone symbol with no amount still deserves a word over dead air.
    out = out.replaceAllMapped(
      _currencySymbol,
      (m) => _currencies[m.group(0)]!.$1,
    );
    return out;
  }

  /// `€5` / `5 €` → `5 euro(s)`, `€5 million` → `5 million euros`.
  /// Singular only for exactly "1"; "1.00" stays plural. A magnitude word
  /// always forces the plural ("€1 million" → "1 million euros"). Yen never
  /// pluralises ("¥10" → "10 yen").
  static String _currencyWords(String symbol, String amount, String? magnitude) {
    final pair = _currencies[symbol];
    if (pair == null) return '$amount $magnitude $symbol';
    final head = magnitude == null ? amount : '$amount $magnitude';
    final plural = magnitude != null || amount.replaceAll(',', '') != '1';
    return '$head ${plural ? pair.$2 : pair.$1}';
  }

  static String _dropSilentArtifacts(String text) {
    final buffer = StringBuffer();
    for (final rune in text.runes) {
      var keep = true;
      for (final (start, end) in _removeRanges) {
        if (rune >= start && rune <= end) {
          keep = false;
          break;
        }
      }
      if (keep) buffer.writeCharCode(rune);
    }
    return buffer.toString();
  }

  static String _tidy(String text) {
    var out = text.replaceAll(RegExp(r'\s+'), ' ');
    out = out.replaceAllMapped(
      RegExp(r'\s+([,.;:!?])'),
      (m) => m.group(1)!,
    );
    return out.trim();
  }
}