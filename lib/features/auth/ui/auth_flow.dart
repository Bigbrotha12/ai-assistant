import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/auth_client.dart';
import '../data/auth_client_provider.dart';
import '../data/auth_credentials_providers.dart';
import '../data/auth_credentials_store.dart';

/// Reusable better-auth sign-in / create-account form.
///
/// Self-contained: owns its text controllers, the "Sign in / Create account"
/// toggle, the obscured password and the submit state. On a successful
/// sign-in/sign-up it mints a long-lived API key from the session token and
/// persists it through [authCredentialsProvider] (secure storage) before
/// invoking [onSuccess], so the caller only acts once the key is stored.
///
/// Used by the onboarding Account step now and by the Settings re-auth path
/// later. Renders a bare form (no [Scaffold]); the host screen supplies the
/// surrounding layout.
class AuthFlow extends ConsumerStatefulWidget {
  const AuthFlow({super.key, required this.onSuccess});

  /// Invoked after a session was obtained AND its API key was minted and
  /// persisted. Receives the authenticated session (token + email).
  final ValueChanged<AuthSession> onSuccess;

  @override
  ConsumerState<AuthFlow> createState() => _AuthFlowState();
}

class _AuthFlowState extends ConsumerState<AuthFlow> {
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  bool _createAccount = false;
  bool _obscurePassword = true;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) return;
    final credentialsNotifier = ref.read(authCredentialsProvider.notifier);
    final authEpoch = credentialsNotifier.captureEpoch();
    final email = _emailController.text.trim();
    final password = _passwordController.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Enter your email and password');
      return;
    }
    if (_createAccount && _nameController.text.trim().isEmpty) {
      setState(() => _error = 'Enter your name');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final auth = ref.read(authClientProvider);
      final session = _createAccount
          ? await auth.signUp(
              name: _nameController.text.trim(),
              email: email,
              password: password,
            )
          : await auth.signIn(email: email, password: password);
      // The minted key is the single source of truth going forward: persist it
      // (updating the notifier state so the gate sees the app as configured)
      // before reporting success to the caller. The key record id and session
      // token are stored alongside so the app can revoke the key later.
      final minted = await auth.mintApiKey(sessionToken: session.token);
      if (!mounted) return;
      await credentialsNotifier.save(
        AuthCredentials(
          apiKey: minted.key,
          email: session.email,
          keyId: minted.id,
          sessionToken: session.token,
          ownerId: session.ownerId,
          backendOrigin: session.backendOrigin,
        ),
        expectedEpoch: authEpoch,
      );
      if (!mounted) return;
      widget.onSuccess(session);
      setState(() => _submitting = false);
    } on AuthApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = _authErrorText(e);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = 'Could not finish signing in. Try again.';
      });
    }
  }

  static String _authErrorText(AuthApiError e) => switch (e) {
    AuthInvalidCredentials() => 'Incorrect email or password',
    AuthEmailTaken() => 'An account already exists for this email',
    AuthUnauthorized() => 'This session was rejected. Try signing in again.',
    AuthNetworkError() => 'Could not reach the server. Check your connection.',
    AuthServerError() => 'Server error: ${e.message}',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SegmentedButton<bool>(
          segments: const [
            ButtonSegment(
              value: false,
              label: Text('Sign in'),
              icon: Icon(Icons.login),
            ),
            ButtonSegment(
              value: true,
              label: Text('Create account'),
              icon: Icon(Icons.person_add_alt_1),
            ),
          ],
          selected: {_createAccount},
          onSelectionChanged: (selection) {
            setState(() => _createAccount = selection.first);
          },
        ),
        const SizedBox(height: 16),
        if (_createAccount) ...[
          TextField(
            key: const Key('auth-name'),
            controller: _nameController,
            decoration: const InputDecoration(
              labelText: 'Name',
              border: OutlineInputBorder(),
            ),
            textInputAction: TextInputAction.next,
          ),
          const SizedBox(height: 16),
        ],
        TextField(
          key: const Key('auth-email'),
          controller: _emailController,
          decoration: const InputDecoration(
            labelText: 'Email address',
            border: OutlineInputBorder(),
          ),
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 16),
        TextField(
          key: const Key('auth-password'),
          controller: _passwordController,
          obscureText: _obscurePassword,
          autocorrect: false,
          enableSuggestions: false,
          keyboardType: TextInputType.visiblePassword,
          onSubmitted: (_) => _submit(),
          decoration: InputDecoration(
            labelText: 'Password',
            border: const OutlineInputBorder(),
            suffixIcon: IconButton(
              icon: Icon(
                _obscurePassword ? Icons.visibility_off : Icons.visibility,
              ),
              tooltip: _obscurePassword ? 'Show password' : 'Hide password',
              onPressed: () =>
                  setState(() => _obscurePassword = !_obscurePassword),
            ),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ],
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('auth-submit'),
          onPressed: _submitting ? null : _submit,
          child: _submitting
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(_createAccount ? 'Create account' : 'Sign in'),
        ),
      ],
    );
  }
}

/// Re-authentication affordance for a gateway 401: a banner explaining the
/// session expired, an embedded [AuthFlow] to sign in and mint a fresh API
/// key, and an optional dismiss action. Shared by the chat, voice and settings
/// surfaces.
///
/// Self-contained: on success [onSuccess] fires after the new key was minted
/// and persisted, so the host can retry the failed request with confidence.
class ReauthCard extends StatelessWidget {
  const ReauthCard({
    super.key,
    required this.onSuccess,
    this.onDismiss,
    this.title = 'Session expired',
    this.message =
        'Your API key was rejected by the gateway. Sign in again to continue.',
  });

  /// Invoked once a fresh session AND API key were obtained and persisted.
  final ValueChanged<AuthSession> onSuccess;

  /// Called when the user dismisses the card (clears the auth-required state).
  final VoidCallback? onDismiss;

  /// Banner headline.
  final String title;

  /// Explanatory copy below the headline.
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
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
                Icon(Icons.lock_outline, color: scheme.error),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: theme.textTheme.titleSmall),
                      const SizedBox(height: 2),
                      Text(
                        message,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (onDismiss != null)
                  IconButton(
                    key: const Key('reauth-dismiss'),
                    tooltip: 'Dismiss',
                    icon: const Icon(Icons.close),
                    onPressed: onDismiss,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            AuthFlow(onSuccess: onSuccess),
          ],
        ),
      ),
    );
  }
}
