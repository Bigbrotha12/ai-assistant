import 'package:flutter/material.dart';

import '../../core/backend_probe.dart';

/// Single probe result row shared by the settings and onboarding screens:
/// status icon/color mapped from [ProbeStatus], plus the check [label] and
/// [CheckResult.detail].
class ProbeStatusRow extends StatelessWidget {
  const ProbeStatusRow({
    super.key,
    required this.result,
    required this.label,
    this.dense = false,
  });

  final CheckResult result;
  final String label;

  /// Compact variant used by the onboarding flow (smaller icon/spacing).
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, color) = switch (result.status) {
      ProbeStatus.ok => (Icons.check_circle, Colors.green.shade600),
      ProbeStatus.unauthorized =>
        (Icons.gpp_bad_outlined, Colors.red.shade700),
      ProbeStatus.noCredentials => (Icons.lock_outline, Colors.orange.shade800),
      ProbeStatus.error => (Icons.error, Colors.orange.shade800),
      ProbeStatus.unreachable => (Icons.cloud_off, Colors.grey.shade600),
    };
    return Padding(
      padding: EdgeInsets.symmetric(vertical: dense ? 4 : 6),
      child: Row(
        children: [
          Icon(icon, color: color, size: dense ? 18 : 20),
          SizedBox(width: dense ? 10 : 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: dense
                      ? theme.textTheme.bodyMedium
                      : theme.textTheme.bodyLarge,
                ),
                Text(
                  result.detail,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}