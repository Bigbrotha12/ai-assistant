import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_credentials_providers.dart';
import '../../chat/data/status_tracker.dart';
import '../../notifications/data/notif_provider.dart';
import '../../notifications/data/notify_admin_client.dart';
import '../../notifications/data/notify_credentials_store.dart';

/// Settings surface for device push notifications.
///
/// The token is a secret the gateway reveals exactly once, so [Provision] and
/// [Rotate] show it in a one-shot dialog with a copy affordance and a clear
/// "won't be shown again" warning; it is persisted to the per-account secure
/// store before the dialog opens, so the subscription survives the dialog.
///
/// When the build carries no `NOTIF_URL` the whole feature is disabled with a
/// clear explanatory state rather than a silent no-op.
class NotificationsSettingsScreen extends ConsumerStatefulWidget {
  const NotificationsSettingsScreen({super.key});

  @override
  ConsumerState<NotificationsSettingsScreen> createState() =>
      _NotificationsSettingsScreenState();
}

class _NotificationsSettingsScreenState
    extends ConsumerState<NotificationsSettingsScreen> {
  bool _busy = false;

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _gatewayKey =>
      ref.read(authCredentialsProvider).value?.apiKey.trim() ?? '';

  void _showError(Object error) {
    if (!mounted) return;
    final message = switch (error) {
      NotifyNotConfiguredException() =>
        'Notifications are not set up on the server yet. Provision first.',
      _ => statusPhraseForError(error),
    };
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _reload() async {
    // Rebuild the credentials provider from the secure store so the screen and
    // the subscription observe the write.
    ref.invalidate(notifyCredentialsProvider);
    await ref.read(notifyCredentialsProvider.future);
  }

  Future<void> _provision() async {
    if (_busy) return;
    final client = ref.read(notifyAdminClientProvider);
    final key = _gatewayKey;
    if (client == null || key.isEmpty) return;
    NotifyProvision? result;
    // `_run` keeps `_busy` true until the action completes, and persisting the
    // credentials happens inside it, so the button can never re-enable in the
    // window between the network call returning and the token being stored.
    await _run(() async {
      final NotifyProvision provision;
      try {
        provision = await client.provision(gatewayKey: key);
        result = provision;
      } catch (error) {
        _showError(error);
        return;
      }
      final scope = ref.read(notifyAccountScopeProvider);
      if (scope == null || !mounted) return;
      final token = provision.accessToken;
      if (token == null) {
        // Server already holds credentials but only reveals the token on the
        // first call; this device has none stored. Direct the user to Rotate.
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Already set up on the server. Rotate to get a token for this '
              'device.',
            ),
          ),
        );
        await _reload();
        return;
      }
      await ref
          .read(notifyCredentialsStoreProvider)
          .save(
            scope,
            NotifyCredentials(topic: provision.topic, accessToken: token),
          );
      await _reload();
    });
    // `_run` has cleared `_busy` only after the credentials were persisted.
    final provisioned = result;
    if (!mounted || provisioned == null) return;
    final token = provisioned.accessToken;
    if (token == null) return;
    await _showTokenOnce(topic: provisioned.topic, token: token);
  }

  Future<void> _rotate() async {
    if (_busy) return;
    final client = ref.read(notifyAdminClientProvider);
    final scope = ref.read(notifyAccountScopeProvider);
    final key = _gatewayKey;
    if (client == null || scope == null || key.isEmpty) return;
    NotifyRotation? result;
    await _run(() async {
      final NotifyRotation rotation;
      try {
        rotation = await client.rotate(gatewayKey: key);
        result = rotation;
      } catch (error) {
        _showError(error);
        return;
      }
      await ref
          .read(notifyCredentialsStoreProvider)
          .save(
            scope,
            NotifyCredentials(
              topic: rotation.topic,
              accessToken: rotation.accessToken,
            ),
          );
      await _reload();
    });
    // `_run` has cleared `_busy` only after the new token was persisted.
    final rotation = result;
    if (!mounted || rotation == null) return;
    await _showTokenOnce(topic: rotation.topic, token: rotation.accessToken);
  }

  Future<void> _revoke() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Revoke notifications'),
        content: const Text(
          'Stop receiving notifications on this device? The topic and token '
          'are deleted on the server; provisioning again starts fresh.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Revoke'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _run(() async {
      final client = ref.read(notifyAdminClientProvider);
      final scope = ref.read(notifyAccountScopeProvider);
      final key = _gatewayKey;
      if (client == null || scope == null || key.isEmpty) return;
      try {
        await client.revoke(gatewayKey: key);
      } catch (error) {
        _showError(error);
        return;
      }
      await ref.read(notifyCredentialsStoreProvider).remove(scope);
      await _reload();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Notifications revoked')));
    });
  }

  /// One-shot reveal of the freshly minted credentials. The values are already
  /// persisted; the dialog exists so the user can copy them.
  Future<void> _showTokenOnce({required String topic, required String token}) {
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('notify-token-dialog'),
        title: const Text('Save your notification token'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Copy this token now — it won’t be shown again. You can keep '
                'using notifications on this device without it.',
              ),
              const SizedBox(height: 16),
              _SecretRow(
                label: 'Topic',
                value: topic,
                keyValue: const Key('notify-topic-value'),
              ),
              const SizedBox(height: 12),
              _SecretRow(
                label: 'Token',
                value: token,
                keyValue: const Key('notify-token-value'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            key: const Key('notify-token-done'),
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final baseUrl = ref.watch(notifBaseUrlProvider);
    final scope = ref.watch(notifyAccountScopeProvider);
    final credentials = ref.watch(notifyCredentialsProvider);
    // Keep the account's gateway key loaded: the actions read it
    // synchronously, and an unloaded provider would read as an empty key.
    ref.watch(authCredentialsProvider.select((auth) => auth.value?.apiKey));
    final signedIn = scope != null;
    final enabled = baseUrl.isNotEmpty && signedIn && !_busy;

    return Scaffold(
      appBar: AppBar(title: const Text('Notifications')),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (baseUrl.isEmpty)
              _InfoCard(
                key: const Key('notify-not-configured'),
                icon: Icons.notifications_off_outlined,
                title: 'Not configured in this build',
                body:
                    'This app was built without a notification server '
                    '(NOTIF_URL). Ask whoever built it to configure one, then '
                    'rebuild.',
              )
            else if (!signedIn)
              const _InfoCard(
                key: Key('notify-signed-out'),
                icon: Icons.lock_outline,
                title: 'Sign in required',
                body:
                    'Notifications are tied to your account. Sign in from the '
                    'Account section to provision this device.',
              )
            else
              _StatusCard(credentials: credentials.value, busy: _busy),
            const SizedBox(height: 20),
            Text('Actions', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            FilledButton.icon(
              key: const Key('notify-provision'),
              onPressed: enabled ? _provision : null,
              icon: const Icon(Icons.add_alert_outlined),
              label: const Text('Provision'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const Key('notify-rotate'),
              onPressed: enabled && credentials.value != null ? _rotate : null,
              icon: const Icon(Icons.autorenew),
              label: const Text('Rotate'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const Key('notify-revoke'),
              onPressed: enabled && credentials.value != null ? _revoke : null,
              icon: Icon(
                Icons.notifications_off_outlined,
                color: Theme.of(context).colorScheme.error,
              ),
              label: Text(
                'Revoke',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Notifications are delivered while the app is running. '
              'Background delivery requires system push (not yet enabled).',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.credentials, required this.busy});

  final NotifyCredentials? credentials;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final configured = credentials != null;
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : Icon(
                configured ? Icons.notifications_active : Icons.notifications,
                color: configured
                    ? Colors.green.shade600
                    : scheme.onSurfaceVariant,
              ),
        title: Text(configured ? 'Configured' : 'Not set up on this device'),
        subtitle: configured
            ? Text('Topic: ${credentials!.topic}')
            : const Text('Provision to receive alerts from your assistant.'),
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      color: scheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: scheme.onSurfaceVariant),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(
                    body,
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SecretRow extends StatelessWidget {
  const _SecretRow({
    required this.label,
    required this.value,
    required this.keyValue,
  });

  final String label;
  final String value;
  final Key keyValue;

  Future<void> _copy(BuildContext context) async {
    try {
      await Clipboard.setData(ClipboardData(text: value));
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$label copied')));
    } catch (_) {
      // Clipboard unavailable (e.g. plain unit tests): the value stays
      // selectable, so the user can still copy it manually.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(child: SelectableText(value, key: keyValue)),
            IconButton(
              key: Key('notify-copy-$label'),
              tooltip: 'Copy $label',
              icon: const Icon(Icons.copy, size: 18),
              onPressed: () => _copy(context),
            ),
          ],
        ),
      ],
    );
  }
}
