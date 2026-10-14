/// Speech-to-text engine interface.
abstract interface class SttEngine {
  /// Transcribes [pcm16bit] — raw PCM-encoded 16-bit signed integer samples —
  /// recorded at [sampleRate] Hz, returning the recognised text.
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate});

  /// Human-readable identifier for this engine implementation.
  String get name;

  /// Languages this engine is validated to recognise: a **curated** (not
  /// exhaustive) list of ISO 639-1 [code]s paired with human-readable
  /// [label]s (e.g. `(code: 'fr', label: 'Français')`).
  ///
  /// Engines without language selection still declare the single language
  /// they operate in (use [kBaseSttSupportedLanguages]).
  List<({String code, String label})> get supportedLanguages;

  /// ISO 639-1 code of the language the engine recognises.
  ///
  /// Defaults to `'en'`. Engines without language selection may treat the
  /// setter as a no-op; consumers should only assign codes from
  /// [supportedLanguages] — use [resolveSttLanguage] to fall back
  /// deterministically when a persisted code is not supported.
  String get preferredLanguage;
  set preferredLanguage(String value);
}

/// Base language list for engines that do not curate their own set (and for
/// registry misses on unknown/custom engine ids): English only.
const kBaseSttSupportedLanguages = <({String code, String label})>[
  (code: 'en', label: 'English'),
];

/// Deterministically resolves a persisted [preferred] language code against
/// an engine's [supported] list:
///
/// - keeps [preferred] when the engine supports it (a supported choice is
///   never lost);
/// - otherwise falls back to `'en'` when the engine supports it;
/// - otherwise the engine's first entry (or `'en'` for an empty list).
String resolveSttLanguage(
  String preferred,
  List<({String code, String label})> supported,
) {
  if (supported.any((lang) => lang.code == preferred)) return preferred;
  if (supported.any((lang) => lang.code == 'en')) return 'en';
  return supported.isNotEmpty ? supported.first.code : 'en';
}
