import 'package:flutter/material.dart';

/// Tells the user the selected agent needs configuration and routes them to
/// Plugins. The fix is configuration — the account is signed in, so this is
/// deliberately distinct from the re-auth flow.
class PluginKeyCard extends StatelessWidget {
  const PluginKeyCard({
    super.key,
    required this.onDismiss,
    required this.onOpenPlugins,
  });

  /// Clears the underlying error (user chose "not now").
  final VoidCallback onDismiss;

  /// Navigates to the Plugins screen where the key can be set/repaired.
  final VoidCallback onOpenPlugins;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      color: scheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Row(
          children: [
            Icon(Icons.vpn_key_outlined, color: scheme.error),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Selected agent needs configuration',
                style: theme.textTheme.titleSmall,
              ),
            ),
            IconButton(
              key: const Key('plugin-key-dismiss'),
              tooltip: 'Dismiss',
              icon: const Icon(Icons.close),
              onPressed: onDismiss,
            ),
            TextButton.icon(
              key: const Key('open-plugins'),
              onPressed: onOpenPlugins,
              icon: const Icon(Icons.tune),
              label: const Text('Plugins'),
            ),
          ],
        ),
      ),
    );
  }
}
