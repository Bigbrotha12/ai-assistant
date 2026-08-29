import 'package:flutter/material.dart';

import '../theme.dart';
import 'gold_band.dart';

/// Large hold-to-talk hero button (§3.4).
///
/// Core tier: filled muted-indigo circle, quiet. Premium tier: raised
/// ivory/paper fill with a gold edge **band**, a soft bevel/shadow so it reads
/// as a tactile button, a **breathing** pulse, an animated **concentric ring**
/// (idle), and an **engraved metallic-gold mic glyph** (§3.3).
///
/// Hold semantics: recording starts on press-down and stops on release (or
/// cancel), matching the "press and hold to talk" caption.
class SpeakButton extends StatefulWidget {
  const SpeakButton({
    super.key,
    required this.onHoldStart,
    required this.onHoldEnd,
    this.recording = false,
    this.aiSpeaking = false,
    this.busy = false,
    this.diameter = 172,
  });

  /// Called when the user presses down (hold starts).
  final VoidCallback onHoldStart;

  /// Called when the user releases or the hold is cancelled.
  final VoidCallback onHoldEnd;

  /// Whether local voice capture is currently recording.
  final bool recording;

  /// Whether the AI is speaking back (drives the ring state).
  final bool aiSpeaking;

  /// When true the button ignores holds (e.g. a connection is starting).
  final bool busy;

  /// Outer diameter in logical pixels.
  final double diameter;

  @override
  State<SpeakButton> createState() => _SpeakButtonState();
}

class _SpeakButtonState extends State<SpeakButton>
    with TickerProviderStateMixin {
  late final AnimationController _ring;
  late final AnimationController _breathe;

  bool _pressed = false;

  @override
  void initState() {
    super.initState();
    _ring = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    )..repeat();
    _breathe = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ring.dispose();
    _breathe.dispose();
    super.dispose();
  }

  void _handlePressDown() {
    if (widget.busy) return;
    setState(() => _pressed = true);
    widget.onHoldStart();
  }

  void _handlePressEnd() {
    if (!_pressed) return;
    setState(() => _pressed = false);
    widget.onHoldEnd();
  }

  @override
  Widget build(BuildContext context) {
    final tier = Theme.of(context).extension<TierTheme>() ?? const TierTheme(premium: false);
    final scheme = Theme.of(context).colorScheme;
    final size = widget.diameter;

    final button = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => _handlePressDown(),
      onTapUp: (_) => _handlePressEnd(),
      onTapCancel: _handlePressEnd,
      child: Semantics(
        button: true,
        label: 'Hold to talk',
        hint: widget.busy
            ? 'Voice is starting'
            : 'Press and hold to talk, release when done',
        child: AnimatedScale(
          scale: _pressed ? 0.96 : 1.0,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          child: SizedBox.square(
            dimension: size,
            child: tier.premium
                ? _premiumButton(scheme)
                : _coreButton(scheme),
          ),
        ),
      ),
    );

    if (!tier.premium) return button;

    // Premium: breathing + concentric ring around the gold-edged button.
    return AnimatedBuilder(
      animation: Listenable.merge([_ring, _breathe]),
      builder: (context, child) {
        final r = _ring.value;
        final breathe = 1 + 0.02 * (0.5 - (_breathe.value - 0.5) * 2);
        return SizedBox.square(
          dimension: size * 1.9,
          child: Stack(
            alignment: Alignment.center,
            children: [
              // Concentric rings, idle only; represent state while active.
              for (final phase in const [0.0, 0.5])
                _ringLayer(phase, r, scheme.primary, scheme),
              _breatheLayer(phase: r),
              Transform.scale(scale: breathe, child: child),
            ],
          ),
        );
      },
      child: button,
    );
  }

  /// Expanding, fading ring behind the button (idle breathing).
  Widget _ringLayer(double phase, double t, Color color, ColorScheme scheme) {
    final progress = (t + phase) % 1.0;
    final opacity = (1 - progress) * 0.22;
    return IgnorePointer(
      child: Opacity(
        opacity: opacity,
        child: Transform.scale(
          scale: 1 + progress * 0.42,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: AppColors.goldBase, width: 1.2),
            ),
          ),
        ),
      ),
    );
  }

  /// Soft radial halo that fades gently (the "breathing" glow).
  Widget _breatheLayer({required double phase}) {
    final glow = 0.25 + 0.08 * (0.5 - (_breathe.value - 0.5) * 2);
    return IgnorePointer(
      child: Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              AppColors.goldBase.withValues(alpha: glow),
              AppColors.goldBase.withValues(alpha: 0),
            ],
          ),
        ),
      ),
    );
  }

  /// Core tier: filled primary circle with a white mic.
  Widget _coreButton(ColorScheme scheme) {
    return Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: widget.recording ? scheme.error : scheme.primary,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.08),
            blurRadius: 16,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Icon(
        widget.recording ? Icons.mic : Icons.mic_none,
        color: widget.recording ? scheme.onError : scheme.onPrimary,
        size: widget.diameter * 0.36,
      ),
    );
  }

  /// Premium tier: raised paper button with gold edge band, bevel and an
  /// engraved metallic-gold mic glyph.
  Widget _premiumButton(ColorScheme scheme) {
    final size = widget.diameter;
    final iconSize = size * 0.34;
    return GoldEdge(
      bandWidth: widget.recording ? GoldBand.cta : GoldBand.hairline,
      radius: size / 2,
      fill: AppColors.paperRaised,
      child: Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              AppColors.paperRaised,
              Color.lerp(AppColors.paperBase, Colors.white, 0.3)!,
            ],
          ),
          boxShadow: [
            // Soft drop shadow for depth.
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.12),
              blurRadius: 22,
              offset: const Offset(0, 10),
            ),
            // Upper-left bevel highlight inside the circle.
            BoxShadow(
              color: Colors.white.withValues(alpha: 0.85),
              blurRadius: 2,
              offset: const Offset(-1.5, -1.5),
            ),
          ],
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            // Engraved ridge (bottom-right) and highlight (top-left) etched
            // beneath the metallic glyph (§3.3).
            Icon(
              Icons.mic,
              size: iconSize,
              color: AppColors.goldDark.withValues(alpha: 0.5),
            ),
            Transform.translate(
              offset: const Offset(-1.1, -1.1),
              child: Icon(
                Icons.mic,
                size: iconSize,
                color: Colors.white.withValues(alpha: 0.35),
              ),
            ),
            ShaderMask(
              blendMode: BlendMode.srcIn,
              shaderCallback: (rect) => goldGradient().createShader(rect),
              child: Icon(
                widget.recording ? Icons.graphic_eq : Icons.mic,
                size: iconSize,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}