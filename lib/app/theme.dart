import 'package:flutter/material.dart';

/// Design system for the app (see `docs/design-system.md`, status: LOCKED).
///
/// Two tiers share the same structure and tokens; only surfaces, accents and
/// headline type differ:
/// - **Core (default)** — light, minimal, muted indigo, Manrope, hairline
///   borders instead of shadows.
/// - **Premium** — warm ivory paper, gold metallic accent on edges/button
///   edges (never a gold fill), EB Garamond serif headlines.
///
/// Every screen pulls from these tokens; no ad-hoc hex values in widgets.

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/// Core palette tokens (§2.1 of the design system).
abstract final class AppColors {
  static const Color surface = Color(0xFFFBFBFC);
  static const Color surfaceRaised = Color(0xFFFFFFFF);
  static const Color surfaceTint = Color(0xFFF2F3F5);
  static const Color onSurface = Color(0xFF1B1C1E);
  static const Color onSurfaceWeak = Color(0xFF6A6F76);
  static const Color outline = Color(0xFFE3E4E8);
  static const Color outlineSoft = Color(0xFFEAEBEE);
  static const Color primary = Color(0xFF4A5D8A); // muted indigo
  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color primarySoft = Color(0xFFE9EDF5);
  static const Color accent = Color(0xFF5B8C8F);
  static const Color error = Color(0xFFB3261E);

  // Premium paper (§3.1) and gold (§3.2) tokens.
  static const Color paperBase = Color(0xFFF6F2E9);
  static const Color paperRaised = Color(0xFFFBF7EF);
  static const Color goldLight = Color(0xFFE3C87A);
  static const Color goldBase = Color(0xFFC8A24B);
  static const Color goldDark = Color(0xFF9C7A2E);
}

/// Warm neutral steps used as M3 surface containers in the premium tier.
abstract final class PaperTones {
  static const Color low = Color(0xFFF3EDDF);
  static const Color base = Color(0xFFEFE8D8);
  static const Color high = Color(0xFFEAE2CF);
  static const Color highest = Color(0xFFE5DCC6);
  static const Color outline = Color(0xFFE5DECC);
  static const Color outlineSoft = Color(0xFFEDE7D6);
}

// ---------------------------------------------------------------------------
// Typography / shape / spacing
// ---------------------------------------------------------------------------

/// Font family names registered in `pubspec.yaml`.
abstract final class AppFonts {
  static const String manrope = 'Manrope';
  static const String garamond = 'EBGaramond';
}

/// Shape radii (§2.3).
abstract final class AppRadii {
  static const double lg = 12; // buttons, inputs, chips, cards
  static const double xl = 16; // message bubbles
  static const double pill = 999;
}

/// Spacing scale (§2.4). Base unit is 4.
abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

/// Metallic gold band thickness (§3.2): 1.5px hairlines, up to 3px on CTAs.
abstract final class GoldBand {
  static const double hairline = 1.5;
  static const double cta = 3;
}

/// Linear gradient that makes gold read as brushed metal, not flat yellow.
LinearGradient goldGradient({
  AlignmentGeometry begin = Alignment.topLeft,
  AlignmentGeometry end = Alignment.bottomRight,
}) =>
    LinearGradient(
      begin: begin,
      end: end,
      colors: const [AppColors.goldLight, AppColors.goldBase, AppColors.goldDark],
    );

// ---------------------------------------------------------------------------
// Theme extension
// ---------------------------------------------------------------------------

/// Per-tier theme data that custom widgets (speak button, transcript pill,
/// gold edge) consult instead of watching the tier provider themselves.
class TierTheme extends ThemeExtension<TierTheme> {
  const TierTheme({required this.premium});

  /// Whether the premium tier is active.
  final bool premium;

  /// The metallic gold gradient used for bands, borders and engraved glyphs.
  LinearGradient get gold => goldGradient();

  @override
  TierTheme copyWith({bool? premium}) =>
      TierTheme(premium: premium ?? this.premium);

  @override
  TierTheme lerp(TierTheme? other, double t) {
    if (other is! TierTheme) return this;
    return TierTheme(premium: other.premium);
  }
}

// ---------------------------------------------------------------------------
// Color schemes
// ---------------------------------------------------------------------------

/// Core (default) light color scheme from the locked tokens.
ColorScheme buildCoreScheme() =>
    ColorScheme.fromSeed(
      seedColor: AppColors.primary,
      dynamicSchemeVariant: DynamicSchemeVariant.tonalSpot,
    ).copyWith(
      primary: AppColors.primary,
      onPrimary: AppColors.onPrimary,
      primaryContainer: AppColors.primarySoft,
      onPrimaryContainer: AppColors.onSurface,
      secondary: AppColors.accent,
      onSecondary: AppColors.onPrimary,
      surface: AppColors.surface,
      onSurface: AppColors.onSurface,
      surfaceContainerLowest: AppColors.surfaceRaised,
      surfaceContainerLow: const Color(0xFFF7F7F9),
      surfaceContainer: AppColors.surfaceTint,
      surfaceContainerHigh: const Color(0xFFECEDF0),
      surfaceContainerHighest: const Color(0xFFE6E7EB),
      outline: AppColors.outline,
      outlineVariant: AppColors.outlineSoft,
      error: AppColors.error,
    );

/// Premium color scheme: warm ivory paper + gold accents layered on top.
ColorScheme buildPremiumScheme() => buildCoreScheme().copyWith(
      surface: AppColors.paperBase,
      onSurface: AppColors.onSurface,
      surfaceContainerLowest: AppColors.paperRaised,
      surfaceContainerLow: PaperTones.low,
      surfaceContainer: PaperTones.base,
      surfaceContainerHigh: PaperTones.high,
      surfaceContainerHighest: PaperTones.highest,
      outline: PaperTones.outline,
      outlineVariant: PaperTones.outlineSoft,
    );

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

TextTheme _textTheme({required bool premium}) {
  final brand = premium ? AppFonts.garamond : AppFonts.manrope;
  // §2.2 type scale. Line-height is relative (double).
  const display = TextStyle(
    fontFamily: null,
    fontSize: 28,
    fontWeight: FontWeight.w700,
    height: 1.25,
    letterSpacing: -0.5,
  );
  const title = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w600,
    height: 1.3,
    letterSpacing: -0.2,
  );
  const heading = TextStyle(
    fontSize: 17,
    fontWeight: FontWeight.w600,
    height: 1.35,
  );
  const body = TextStyle(fontSize: 15, fontWeight: FontWeight.w400, height: 1.5);
  const label =
      TextStyle(fontSize: 13, fontWeight: FontWeight.w500, height: 1.4, letterSpacing: 0.15);
  const caption = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w400,
    height: 1.4,
    letterSpacing: 0.12,
  );

  return TextTheme(
    displaySmall: display.copyWith(fontFamily: brand),
    headlineMedium: title.copyWith(fontFamily: brand),
    headlineSmall: title.copyWith(fontSize: 20, fontFamily: brand),
    titleLarge: heading.copyWith(fontSize: 20, fontFamily: brand),
    titleMedium: heading,
    titleSmall: label.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
    bodyLarge: body.copyWith(fontSize: 16),
    bodyMedium: body,
    bodySmall: body.copyWith(fontSize: 13, color: AppColors.onSurfaceWeak),
    labelLarge: label.copyWith(fontSize: 14),
    labelMedium: label,
    labelSmall: caption,
  );
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

ThemeData _baseTheme(ColorScheme scheme, {required bool premium}) {
  final tier = TierTheme(premium: premium);
  final hairline = premium ? AppColors.goldBase : scheme.outline;
  final hairlineWidth = premium ? GoldBand.hairline : 1.0;

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: AppFonts.manrope,
    textTheme: _textTheme(premium: premium),
    // Premium scaffolds are transparent so the global paper grain (painted by
    // `MaterialApp.builder`) shows through; core keeps an opaque surface.
    scaffoldBackgroundColor: premium ? Colors.transparent : scheme.surface,
    extensions: [tier],
    appBarTheme: AppBarTheme(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      scrolledUnderElevation: 0,
      elevation: 0,
      centerTitle: false,
      iconTheme: IconThemeData(color: scheme.onSurface),
      // Hairline bottom divider; premium upgrades it to a gold hairline.
      shape: Border(
        bottom: BorderSide(color: hairline, width: hairlineWidth),
      ),
      titleTextStyle: TextStyle(
        fontFamily: premium ? AppFonts.garamond : AppFonts.manrope,
        fontSize: 18,
        fontWeight: FontWeight.w600,
        color: scheme.onSurface,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        borderSide: BorderSide(color: scheme.outline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        borderSide: BorderSide(color: scheme.outline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        borderSide: BorderSide(
          color: premium ? AppColors.goldBase : scheme.primary,
          width: hairlineWidth,
        ),
      ),
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: 14,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        disabledBackgroundColor: scheme.surfaceContainerHighest,
        disabledForegroundColor: scheme.onSurfaceVariant,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.lg),
        ),
        minimumSize: const Size(64, 48),
        textStyle: _textTheme(premium: premium).labelMedium,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: scheme.onSurface,
        side: BorderSide(color: premium ? AppColors.goldDark : scheme.outline),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.lg),
        ),
        minimumSize: const Size(64, 48),
        textStyle: _textTheme(premium: premium).labelMedium,
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: scheme.surfaceContainer,
      side: BorderSide(color: premium ? AppColors.goldBase : scheme.outline),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      labelStyle: _textTheme(premium: premium).labelMedium,
    ),
    cardTheme: CardThemeData(
      color: scheme.surfaceContainerLowest,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.lg),
        side: BorderSide(color: scheme.outline),
      ),
    ),
    dividerTheme: DividerThemeData(color: scheme.outline, thickness: 1),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: scheme.primary,
      foregroundColor: scheme.onPrimary,
      shape: const CircleBorder(),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: scheme.primary),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: TextStyle(color: scheme.onInverseSurface),
    ),
  );
}

/// Core (default) theme — modern, light, minimal noise.
ThemeData buildCoreTheme() => _baseTheme(buildCoreScheme(), premium: false);

/// Premium theme — paper texture + gold-as-accent.
ThemeData buildPremiumTheme() => _baseTheme(
      buildPremiumScheme(),
      premium: true,
    );