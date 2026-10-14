import 'package:flutter/material.dart';
import 'package:smooth_page_indicator/smooth_page_indicator.dart';

import '../theme.dart';

/// Horizontal dot indicator for the card-per-step onboarding flow.
///
/// Wraps `smooth_page_indicator`'s [ExpandingDotsEffect] — the one thing that
/// package buys us, since Material 3 ships no dot/page indicator. The step
/// bodies are a plain [PageView], so this widget only ever renders the dots.
///
/// Appearance is intentionally two-tone (active + inactive) because
/// [ExpandingDotsEffect] takes exactly two colours; a third "completed" state
/// would mean a second indicator or a custom painter, which is more machinery
/// than the design system's "little noise" principle justifies at four steps.
/// The active dot is *elongated*, so it reads as both "you are here" and
/// "there are N steps".
///
/// [PageController]-driven (not [AnimatedSmoothIndicator]) so the dots stay in
/// lockstep with the [PageView] rather than duplicating the current index.
class StepDots extends StatelessWidget {
  const StepDots({
    super.key,
    required this.controller,
    required this.count,
    required this.index,
    this.onDotTapped,
  });

  /// Controller of the [PageView] showing the step cards. The package listens
  /// to its scroll offset, so the dot animates while the page is dragged.
  final PageController controller;

  /// Total number of steps.
  final int count;

  /// Index of the visible step. Used only for the semantics label; the painted
  /// position is derived from [controller].
  final int index;

  /// Invoked with the tapped dot's index. Hosts should reject forward jumps
  /// past a step that is not yet valid (see `onboarding_screen.dart`).
  final ValueChanged<int>? onDotTapped;

  /// Dot metrics, from the design system's spacing scale (§2.4).
  static const double _dotSize = 6;

  /// `expansionFactor` multiplies [_dotSize], so the active dot is 6 -> 18
  /// logical px wide while inactive dots stay 6 px.
  static const double _expansionFactor = 3;

  /// Builds the effect, seeded from [scheme]. Exposed so the app root can feed
  /// the same values into `SmoothPageIndicatorTheme` (see `main.dart`), keeping
  /// one copy of these numbers.
  static ExpandingDotsEffect effectFor(ColorScheme scheme) =>
      ExpandingDotsEffect(
        expansionFactor: _expansionFactor,
        dotWidth: _dotSize,
        dotHeight: _dotSize,
        radius: _dotSize / 2,
        spacing: AppSpacing.sm,
        activeDotColor: scheme.primary,
        dotColor: scheme.outline,
      );

  /// The two indicator colours for [scheme], for `DefaultIndicatorColors`.
  static DefaultIndicatorColors colorsFor(ColorScheme scheme) =>
      DefaultIndicatorColors(active: scheme.primary, inactive: scheme.outline);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // The package paints the dots as a bare CustomPaint inside a
    // GestureDetector, with no Semantics node of its own — a screen reader
    // would otherwise announce nothing at all. Describe the position once here
    // and exclude the painted widget, leaving "Back" as the accessible way to
    // move between steps (tappable dots are redundant with it anyway).
    return Semantics(
      label: 'Step ${index + 1} of $count',
      container: true,
      child: ExcludeSemantics(
        child: SmoothPageIndicator(
          controller: controller,
          count: count,
          // Explicit rather than inherited so the indicator is correct even in
          // a test harness or a subtree that skips the app-root
          // `SmoothPageIndicatorTheme`; the two stay in sync via [effectFor].
          effect: effectFor(scheme),
          onDotClicked: onDotTapped,
        ),
      ),
    );
  }
}
