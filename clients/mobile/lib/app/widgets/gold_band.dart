import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// Which edges of a [GoldEdge] carry the metallic gold band.
enum GoldEdgeEdges {
  /// A full gradient border surrounding the child.
  all,

  /// A top and bottom band only (cards / settings sections, §3.2).
  topBottom,
}

/// Wraps a child in the metallic gold band treatment (§3.2).
///
/// Gold is always an **accent** — a thin gradient border/band around an
/// ivory/paper (or theme) fill, never a gold body.
class GoldEdge extends StatelessWidget {
  const GoldEdge({
    super.key,
    required this.child,
    this.bandWidth = GoldBand.hairline,
    this.radius = AppRadii.lg,
    this.edges = GoldEdgeEdges.all,
    this.gradient,
    this.fill,
  });

  final Widget child;

  /// Band thickness in logical pixels (1.5 hairline, up to 3 on CTAs).
  final double bandWidth;

  /// Corner radius of the outer shape. Ignored for [GoldEdgeEdges.topBottom].
  final double radius;

  final GoldEdgeEdges edges;

  /// Metallic gold gradient; defaults to [goldGradient].
  final Gradient? gradient;

  /// Fill of the inner surface; defaults to the theme's raised surface so the
  /// widget works in both tiers without callers passing colors.
  final Color? fill;

  @override
  Widget build(BuildContext context) {
    final g = gradient ?? goldGradient();
    final bg = fill ??
        Theme.of(context).colorScheme.surfaceContainerLowest;

    if (edges == GoldEdgeEdges.all) {
      return DecoratedBox(
        decoration: BoxDecoration(
          gradient: g,
          borderRadius: BorderRadius.circular(radius),
        ),
        child: Padding(
          padding: EdgeInsets.all(bandWidth),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(
                math.max(0, radius - bandWidth),
              ),
            ),
            child: child,
          ),
        ),
      );
    }

    // Top + bottom bands; hairlines (≤2px) do not need corner rounding.
    return Column(
      children: [
        Container(
          height: bandWidth,
          decoration: BoxDecoration(gradient: g),
        ),
        Expanded(child: ColoredBox(color: bg, child: child)),
        Container(
          height: bandWidth,
          decoration: BoxDecoration(gradient: g),
        ),
      ],
    );
  }
}

/// Subtle hand-laid paper grain for the premium tier (§3.1).
///
/// Paints a deterministic mottled grain at ≤ ~4% opacity so it reads as
/// "premium paper", never noise. Place once behind the app (the premium theme
/// does this via `MaterialApp.builder`); mark decorative with
/// [ExcludeSemantics].
class PaperTexture extends StatelessWidget {
  const PaperTexture({super.key});

  @override
  Widget build(BuildContext context) {
    return const ExcludeSemantics(
      child: IgnorePointer(
        child: CustomPaint(
          painter: PaperTexturePainter(),
          isComplex: true,
        ),
      ),
    );
  }
}

class PaperTexturePainter extends CustomPainter {
  const PaperTexturePainter();

  /// Seed keeps the grain stable across repaints and frames.
  static const _seed = 0xA11CE;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final random = math.Random(_seed);

    final fiber = Paint()
      ..color = Colors.black.withValues(alpha: 0.022)
      ..strokeWidth = 1;
    final speck = Paint()
      ..color = Colors.black.withValues(alpha: 0.03);
    final highlight = Paint()
      ..color = Colors.white.withValues(alpha: 0.04);

    // Fibrous horizontal streaks: short faint lines, mostly above the fold.
    final streakCount = (size.width * size.height / 9000).round().clamp(40, 240);
    for (var i = 0; i < streakCount; i++) {
      final y = random.nextDouble() * size.height;
      final x = random.nextDouble() * size.width;
      final length = 12 + random.nextDouble() * 52;
      canvas.drawLine(
        Offset(x, y),
        Offset(x + length, y),
        fiber,
      );
    }

    // Finer dotted specks sprinkled over the sheet.
    final speckCount = (size.width * size.height / 2200).round().clamp(80, 900);
    for (var i = 0; i < speckCount; i++) {
      canvas.drawCircle(
        Offset(random.nextDouble() * size.width, random.nextDouble() * size.height),
        0.35 + random.nextDouble() * 0.4,
        random.nextBool() ? speck : highlight,
      );
    }
  }

  @override
  bool shouldRepaint(covariant PaperTexturePainter oldDelegate) => false;
}