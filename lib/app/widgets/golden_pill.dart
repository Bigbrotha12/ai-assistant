import 'package:flutter/material.dart';

import '../theme.dart';
import './gold_band.dart';

/// Shared pill chrome (§3.2): core tier is a quiet `surfaceContainer` stadium
/// with an outline; premium tier is a paper fill with a 1.5px **metallic gold
/// gradient border** — gold stays accent-only (never a gold fill).
///
/// Used by [GoldenPill] and by the voice screen's mode toggle so both share
/// the exact same visual style.
class PillChrome extends StatelessWidget {
  const PillChrome({
    super.key,
    required this.child,
  });

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tier = Theme.of(context).extension<TierTheme>() ?? const TierTheme(premium: false);

    if (!tier.premium) {
      return Material(
        color: scheme.surfaceContainer,
        shape: StadiumBorder(
          side: BorderSide(color: scheme.outline),
        ),
        child: child,
      );
    }

    return GoldEdge(
      bandWidth: GoldBand.hairline,
      radius: AppRadii.pill,
      fill: AppColors.paperRaised,
      child: child,
    );
  }
}

/// The signature "golden border" pill (§3.2) used for the Transcript toggle.
///
/// Core tier: a quiet `surfaceTint` pill. Premium tier: ivory/paper fill with
/// a 1.5px **metallic gold gradient border** and dark gold text — gold stays
/// accent-only (never a gold fill).
///
/// The chevron **points UP** whenever the panel expands upward (the transcript
/// rises from the bottom of the voice screen).
class GoldenPill extends StatelessWidget {
  const GoldenPill({
    super.key,
    required this.label,
    required this.open,
    required this.onTap,
    this.trailing,
    this.enabled = true,
  });

  /// Pill text, e.g. "Transcript".
  final String label;

  /// Whether the associated panel is open (drives the chevron direction).
  final bool open;

  final VoidCallback onTap;

  /// Optional status text shown next to the label (e.g. "2 messages").
  final String? trailing;

  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tier = theme.extension<TierTheme>() ?? const TierTheme(premium: false);
    final chevron = open ? Icons.keyboard_arrow_down : Icons.expand_less;

    return PillChrome(
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(AppRadii.pill),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: tier.premium ? AppColors.goldDark : scheme.onSurface,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: 6),
                Text(
                  trailing!,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(width: 2),
              Icon(
                chevron,
                size: 18,
                color: tier.premium ? AppColors.goldBase : scheme.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}