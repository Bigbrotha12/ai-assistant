import 'package:flutter/material.dart';

import '../theme.dart';
import './gold_band.dart';

/// Shared pill chrome (§3.2): core tier is a quiet `surfaceContainer` stadium
/// with an outline; premium tier is a paper fill with a 1.5px **metallic gold
/// gradient border** — gold stays accent-only (never a gold fill).
///
/// Used by the shared voice/text mode pill so both tiers render identically.
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