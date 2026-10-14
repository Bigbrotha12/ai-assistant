import 'package:flutter/material.dart';

import '../theme.dart';

/// Brand logo tile for the Voice Assist app.
///
/// Renders the bundled logo asset inside a rounded tile with a 1px hairline
/// `outline` border — the design system prefers hairline borders over shadows
/// (§2.5) and a 12px radius for cards/tiles (§2.3).
///
/// The asset lives at [defaultAsset]. To rebrand, drop the selected variant
/// into that path (see `docs/logo-variants/`).
class AppLogo extends StatelessWidget {
  const AppLogo({
    super.key,
    this.size = AppSpacing.xxl,
    this.radius = AppRadii.lg,
    this.showBorder = true,
    this.asset = defaultAsset,
  });

  /// Default bundled app logo asset (registered in `pubspec.yaml`).
  static const String defaultAsset = 'assets/branding/app_logo.png';

  /// Tile edge length in logical pixels.
  final double size;

  /// Corner radius (§2.3); defaults to [AppRadii.lg] (12px).
  final double radius;

  /// Whether to draw the 1px hairline `outline` border (§2.5).
  final bool showBorder;

  /// Asset path of the logo image.
  final String asset;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final borderColor = Theme.of(context).brightness == Brightness.light
        ? AppColors.outline
        : scheme.outline;
    final borderRadius = BorderRadius.circular(radius);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: borderRadius,
        border: showBorder
            ? Border.all(color: borderColor, width: 1)
            : null,
      ),
      child: ClipRRect(
        borderRadius: borderRadius,
        child: Image.asset(
          asset,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) => ColoredBox(
            color: AppColors.primarySoft,
            child: Icon(
              Icons.mic,
              size: size * 0.5,
              color: AppColors.primary,
            ),
          ),
        ),
      ),
    );
  }
}

/// [AppLogo] tile plus the product wordmark, used as an app bar title on the
/// brand surfaces (onboarding, chat, voice, settings).
///
/// Keeps to the "little noise" principle: a small logo and the product name at
/// the default app-bar title style.
class BrandAppBarTitle extends StatelessWidget {
  const BrandAppBarTitle({super.key, this.logoSize = 26});

  /// Logo tile size inside the app bar.
  final double logoSize;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AppLogo(size: logoSize),
        const SizedBox(width: AppSpacing.sm),
        Text('Voice Assist', style: theme.textTheme.titleLarge),
      ],
    );
  }
}
