// Shared language/date-format options for the settings and onboarding
// screens, plus option builders that append the current value when missing.
// Single source of truth so the two dropdowns stay in sync.

/// Language options shown in the "Language & region" / "General" sections.
const appLanguages = <(String, String)>[
  ('en', 'English'),
  ('es', 'Spanish'),
  ('fr', 'French'),
  ('de', 'German'),
  ('zh', 'Chinese'),
];

/// Date-format locale options. The 24h variants (en-GB/de-DE/fr-FR/ja-JP) sit
/// alongside the 12h US default.
const appDateFormats = <(String, String)>[
  ('en-US', 'US — MM/DD/YYYY'),
  ('en-GB', 'UK — DD/MM/YYYY'),
  ('de-DE', 'Germany — DD.MM.YYYY'),
  ('fr-FR', 'France — DD/MM/YYYY'),
  ('ja-JP', 'Japan — YYYY/MM/DD'),
];

/// [appLanguages] plus [selected] appended when it is not in the fixed list
/// (e.g. a locale picked elsewhere), so the dropdown never shows an
/// unrepresentable value.
List<(String, String)> languageOptions(String selected) {
  final all = [...appLanguages];
  if (!all.any((e) => e.$1 == selected)) all.add((selected, selected));
  return all;
}

/// [appDateFormats] plus [selected] appended when it is not in the fixed list.
List<(String, String)> dateFormatOptions(String selected) {
  final all = [...appDateFormats];
  if (!all.any((e) => e.$1 == selected)) all.add((selected, selected));
  return all;
}