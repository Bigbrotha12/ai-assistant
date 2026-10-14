import 'package:flutter/material.dart';

import '../data/auth_client.dart';
import 'auth_flow.dart';

/// Dedicated Sign in / Create account screen used from the Settings account
/// section.
///
/// Wraps the reusable [AuthFlow] in a [Scaffold] and pops with the
/// authenticated [AuthSession] on success, so the caller can act on the
/// returned session (persist the fresh credential, revoke a rotated key, show
/// a confirmation).
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, this.rotation = false});

  /// When true, the screen explains that signing in mints a NEW API key to
  /// replace the current one (the rotate-key path). Behavior is otherwise
  /// identical to a plain sign-in.
  final bool rotation;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
          children: [
            Icon(
              Icons.assistant_outlined,
              size: 64,
              color: theme.colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(
              widget.rotation
                  ? 'Sign in again to mint a new key.'
                  : 'Sign in to your account',
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Your API key is stored only on this device. If you do not '
              'have an account yet, create one below.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            AuthFlow(onSuccess: (session) => _finish(session)),
          ],
        ),
      ),
    );
  }

  void _finish(AuthSession session) {
    if (!mounted) return;
    Navigator.of(context).pop(session);
  }
}