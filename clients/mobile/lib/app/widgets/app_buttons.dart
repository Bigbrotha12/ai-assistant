import 'package:flutter/material.dart';

import '../theme.dart';

/// Shared button styles (see `DESIGN.md` §2.3–2.5).
///
/// Two roles, deliberately:
///
/// - **[cta]** — the single primary action of a screen or step. Full width and
///   [ctaHeight] tall. A screen should never show two.
/// - **[regular]** — a standard action that hugs its label, [regularHeight]
///   tall.
///
/// These styles deliberately set **geometry only** (size and padding). Colour,
/// corner radius, disabled colours and the label text style all stay owned by
/// `ThemeData` — `filledButtonTheme` / `outlinedButtonTheme` / `textButtonTheme`
/// in `theme.dart` — so swapping the tier or the palette restyles every button
/// in the app without touching a call site. That is the whole point: screens
/// never hardcode a colour, a radius or a font size for a button.
///
/// Because a [ButtonStyle] merges with the widget's theme, these are `const`
/// and can be spread directly:
///
/// ```dart
/// FilledButton(style: AppButtons.cta, onPressed: _next, child: ...)
///
/// Row(
///   children: [
///     Expanded(child: FilledButton(style: AppButtons.cta, ...)),
///     const SizedBox(width: AppSpacing.sm),
///     TextButton(onPressed: _back, child: const Text('Back')),
///   ],
/// )
/// ```
abstract final class AppButtons {
  /// Height of a [cta] button. Taller than [regularHeight] to signal priority.
  static const double ctaHeight = 52;

  /// Height of a [regular] button. Also the minimum tap target for the
  /// quieter text button, matching the 48px minimum in the button themes.
  static const double regularHeight = 48;

  /// Primary action: full-bleed, [ctaHeight] tall, filled.
  ///
  /// `Size.fromHeight` is infinite in width, so the button fills its parent
  /// when that parent is a stretch-aligned [Column]. In a [Row] or [ListTile]
  /// (which do not stretch on the cross axis) wrap it in
  /// `SizedBox(width: double.infinity, ...)` or an [Expanded].
  static const ButtonStyle cta = ButtonStyle(
    minimumSize: WidgetStatePropertyAll(Size.fromHeight(ctaHeight)),
    maximumSize: WidgetStatePropertyAll(Size.fromHeight(ctaHeight)),
    padding: WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: AppSpacing.xl),
    ),
  );

  /// Standard action: hugs its label, [regularHeight] tall, filled.
  static const ButtonStyle regular = ButtonStyle(
    minimumSize: WidgetStatePropertyAll(Size(64, regularHeight)),
    maximumSize: WidgetStatePropertyAll(Size(double.infinity, regularHeight)),
    padding: WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: AppSpacing.xl),
    ),
  );

  /// Outlined counterpart to [regular] — same metrics, hairline border from
  /// the theme.
  static const ButtonStyle regularOutlined = ButtonStyle(
    minimumSize: WidgetStatePropertyAll(Size(64, regularHeight)),
    maximumSize: WidgetStatePropertyAll(Size(double.infinity, regularHeight)),
    padding: WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: AppSpacing.xl),
    ),
  );

  /// Quiet text action (Back, "Do it later") sized to a comfortable tap target
  /// rather than the label's own bounds.
  static const ButtonStyle text = ButtonStyle(
    minimumSize: WidgetStatePropertyAll(Size(64, regularHeight)),
    maximumSize: WidgetStatePropertyAll(Size(double.infinity, regularHeight)),
    padding: WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: AppSpacing.lg),
    ),
  );
}
