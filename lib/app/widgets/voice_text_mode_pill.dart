import 'package:flutter/material.dart';

import '../theme.dart';
import './golden_pill.dart';

/// Shared voice / text mode switch rendered in the pill chrome, used on both
/// the voice screen (voice-first home) and the chat screen (text mode) so the
/// two surfaces can hand off to each other through the same affordance.
///
/// `selected` is true when the **Text** segment is active (chat screen), false
/// when **Voice** is active (voice screen).
class VoiceTextModePill extends StatelessWidget {
  const VoiceTextModePill({
    super.key,
    required this.selected,
    required this.enabled,
    required this.onChanged,
  });

  /// True when the Text (chat) mode is active.
  final bool selected;

  /// False disables both segments (e.g. while recording).
  final bool enabled;

  /// Fired with the tapped segment's value (false = voice, true = text).
  final ValueChanged<bool> onChanged;

  Widget _segment(
    BuildContext context, {
    required bool isSelected,
    required IconData icon,
    required String label,
    required String key,
    required bool segmentValue,
  }) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tier = theme.extension<TierTheme>() ?? const TierTheme(premium: false);
    final color = !enabled
        ? scheme.onSurfaceVariant
        : isSelected
            ? (tier.premium ? AppColors.goldDark : scheme.onSurface)
            : scheme.onSurfaceVariant;
    return InkWell(
      key: Key(key),
      onTap: enabled ? () => onChanged(segmentValue) : null,
      borderRadius: BorderRadius.circular(AppRadii.pill),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 6),
            Text(
              label,
              style: theme.textTheme.labelMedium?.copyWith(
                color: color,
                fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tier = theme.extension<TierTheme>() ?? const TierTheme(premium: false);
    return PillChrome(
      key: const Key('voice-input-mode-toggle'),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _segment(
            context,
            isSelected: !selected,
            icon: Icons.mic_none,
            label: 'Voice',
            key: 'voice-mode-voice',
            segmentValue: false,
          ),
          Container(
            height: 20,
            width: 1,
            color: tier.premium ? AppColors.goldBase : theme.colorScheme.outline,
          ),
          _segment(
            context,
            isSelected: selected,
            icon: Icons.keyboard_outlined,
            label: 'Text',
            key: 'voice-mode-text',
            segmentValue: true,
          ),
        ],
      ),
    );
  }
}