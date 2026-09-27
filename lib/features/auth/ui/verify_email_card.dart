import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/auth_client.dart';
import '../data/auth_client_provider.dart';

/// Inline "verify your email" recovery card shared by Settings, chat and
/// voice.
///
/// Shown for a gateway 403 `email_not_verified`: the stored API key is valid
/// but the account's email is unconfirmed (C2), so the user needs a (re)send
/// of the verification link. Distinct from `ReauthCard` — signing in again
/// does not help, and a valid session may not even exist.
class VerifyEmailCard extends ConsumerStatefulWidget {
  const VerifyEmailCard({
    super.key,
    required this.email,
    this.message =
        'Your account email isn\'t verified yet. Open the verification link '
        'we emailed you, then try again.',
    this.onDismiss,
  });

  /// The account address to resend to. When null/blank the card shows a field
  /// so the user can enter it.
  final String? email;

  /// Explanatory copy below the headline.
  final String message;

  /// Called when the user dismisses the card (clears the verify-email state).
  final VoidCallback? onDismiss;

  @override
  ConsumerState<VerifyEmailCard> createState() => _VerifyEmailCardState();
}

class _VerifyEmailCardState extends ConsumerState<VerifyEmailCard> {
  late final TextEditingController _emailController;
  bool _submitting = false;
  bool _sent = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _emailController = TextEditingController(text: widget.email ?? '');
  }

  @override
  void didUpdateWidget(VerifyEmailCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Adopt a newly-available address (e.g. credentials finished loading) so
    // the resend targets the account rather than an empty field. Never clobber
    // a transiently-typed value when the provided address is unchanged/blank.
    final next = widget.email;
    if (next != null && next != oldWidget.email) {
      _emailController.text = next;
    }
  }

  @override
  void dispose() {
    _emailController.dispose();
    super.dispose();
  }

  Future<void> _resend() async {
    if (_submitting) return;
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Enter your email address');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
      _sent = false;
    });
    try {
      await ref.read(authClientProvider).sendVerificationEmail(email: email);
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _sent = true;
      });
    } on AuthRateLimited catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = e.retryAfterSeconds != null
            ? 'Too many requests — try again in ${e.retryAfterSeconds} seconds.'
            : 'Too many requests — try again in a minute.';
      });
    } on AuthApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = _errorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = 'Could not send the verification email. Try again.';
      });
    }
  }

  static String _errorText(AuthApiError e) => switch (e) {
    AuthNetworkError() => 'Could not reach the server. Check your connection.',
    AuthServerError(statusCode: final status)
        when status != null && status >= 500 =>
      'The server hit a problem (HTTP $status). Please try again.',
    AuthServerError() => 'Server error: ${e.message}',
    _ => 'Could not send the verification email. Try again.',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final hasEmail = _emailController.text.trim().isNotEmpty;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      color: scheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.mark_email_read_outlined, color: scheme.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Verify your email',
                        style: theme.textTheme.titleSmall,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        widget.message,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (widget.onDismiss != null)
                  IconButton(
                    key: const Key('verify-email-dismiss'),
                    tooltip: 'Dismiss',
                    icon: const Icon(Icons.close),
                    onPressed: widget.onDismiss,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (!hasEmail) ...[
              TextField(
                key: const Key('verify-email-address'),
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Email address',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_sent) ...[
              Text(
                'Verification email sent to ${_emailController.text.trim()}.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.primary,
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_error != null) ...[
              Text(
                _error!,
                style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
              ),
              const SizedBox(height: 12),
            ],
            FilledButton.icon(
              key: const Key('verify-email-resend'),
              onPressed: _submitting ? null : _resend,
              icon: _submitting
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send_outlined),
              label: const Text('Resend verification email'),
            ),
          ],
        ),
      ),
    );
  }
}
