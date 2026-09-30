import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/widgets/app_buttons.dart';
import '../data/account_deleted_handler.dart';
import '../data/account_deleted_state.dart';
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
/// Also hosts the forgotten-password sub-flow (email → reset link, reached via
/// "Forgot password?" on the sign-in segment) and recovers from a duplicate
/// sign-up by offering to switch straight to sign-in with the email prefilled.
/// Used by the onboarding Account step, the Settings re-auth path and the
/// in-conversation re-auth card. Renders a bare form (no [Scaffold]); the host
/// screen supplies the surrounding layout.
class AuthFlow extends ConsumerStatefulWidget {
  const AuthFlow({super.key, required this.onSuccess, this.showSubmit = true});

  /// Invoked after a session was obtained AND its API key was minted and
  /// persisted. Receives the authenticated session (token + email).
  final ValueChanged<AuthSession> onSuccess;

  /// Whether to render the built-in submit button on the credentials form.
  ///
  /// Set to `false` when the host supplies its own primary action (the
  /// onboarding Account step puts a full-width CTA in a sticky action bar, and
  /// two stacked filled buttons read as competing primaries). The host then
  /// drives submission with [AuthFlowState.submit] via a [GlobalKey]. The
  /// forgot-password and verify sub-forms always keep their own buttons, since
  /// they are secondary states the host has no action for.
  final bool showSubmit;

  @override
  ConsumerState<AuthFlow> createState() => AuthFlowState();
}

/// Public state handle so a host can drive submission when it owns the
/// primary action (see [AuthFlow.showSubmit]).
class AuthFlowState extends ConsumerState<AuthFlow> {
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  bool _createAccount = false;
  bool _obscurePassword = true;
  bool _submitting = false;
  String? _error;

  /// True while the forgot-password sub-flow is shown instead of the form.
  bool _forgotMode = false;

  /// True when the reset request succeeded (show the "check your email"
  /// confirmation instead of the form).
  bool _forgotSent = false;

  /// Set when the last create-account attempt was rejected because the email
  /// is already registered; surfaces the "Sign in instead" affordance.
  bool _emailTaken = false;

  /// True while the email-verification "check your inbox" state is shown
  /// instead of the credentials form: either the sign-up came back without a
  /// session (C2 tokenless sign-up) or sign-in was rejected with
  /// EMAIL_NOT_VERIFIED. Offers resend + a way back to sign-in.
  bool _verifyMode = false;

  /// True when a resend attempt succeeded (shows the confirmation line).
  bool _verifySent = false;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  /// Drives the credentials-form submit from a host-owned primary action.
  ///
  /// No-op while already submitting, and while a sub-form (forgot-password /
  /// verify) is showing — those own their own buttons. Callers that hide the
  /// built-in button should disable their action while a submit is in flight;
  /// [isSubmitting] exposes that.
  Future<void> submit() async {
    if (_forgotMode || _verifyMode) return;
    await _submit();
  }

  /// Whether a submit is currently in flight, so a host-owned action can show
  /// a spinner and disable itself.
  bool get isSubmitting => _submitting;

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
      _emailTaken = false;
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
      if (session.token.isEmpty) {
        // C2 tokenless sign-up: the account exists but the server created no
        // session (email verification gates sign-in). No key can be minted —
        // enter the check-your-inbox state instead.
        if (!mounted) return;
        setState(() {
          _submitting = false;
          _error = null;
          _emailTaken = false;
          _verifyMode = true;
          _verifySent = false;
        });
        return;
      }
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
          mintedAt: DateTime.now(),
        ),
        expectedEpoch: authEpoch,
      );
      if (!mounted) return;
      widget.onSuccess(session);
      setState(() => _submitting = false);
    } on AuthAccountDeleted catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = accountDeletedNotice;
        _emailTaken = false;
        _verifyMode = false;
        _verifySent = false;
      });
      await ref.read(accountDeletedHandlerProvider).handle(error);
    } on AuthEmailNotVerified catch (_) {
      // Sign-in of an unverified account: route to the check-inbox state
      // with the typed email already in the controller for resend.
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = null;
        _emailTaken = false;
        _verifyMode = true;
        _verifySent = false;
      });
    } on AuthApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = _authErrorText(e);
        _emailTaken = e is AuthEmailTaken;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = _createAccount
            ? 'Could not create your account. Try again.'
            : 'Could not finish signing in. Try again.';
      });
    }
  }

  Future<void> _submitForgot() async {
    if (_submitting) return;
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Enter your email address');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(authClientProvider).requestPasswordReset(email: email);
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _forgotSent = true;
      });
    } on AuthApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = _authErrorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = 'Could not request a password reset. Try again.';
      });
    }
  }

  void _switchToSignIn() {
    setState(() {
      _createAccount = false;
      _forgotMode = false;
      _forgotSent = false;
      _emailTaken = false;
      _verifyMode = false;
      _verifySent = false;
      _error = null;
    });
  }

  Future<void> _resendVerification() async {
    if (_submitting) return;
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Enter your email address');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
      _verifySent = false;
    });
    try {
      await ref.read(authClientProvider).sendVerificationEmail(email: email);
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _verifySent = true;
      });
    } on AuthRateLimited catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _verifySent = false;
        _error = e.retryAfterSeconds != null
            ? 'Too many requests — try again in ${e.retryAfterSeconds} seconds.'
            : 'Too many requests — try again in a minute.';
      });
    } on AuthApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _verifySent = false;
        _error = _authErrorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _verifySent = false;
        _error = 'Could not send the verification email. Try again.';
      });
    }
  }

  /// Resends the verification mail straight from the sign-in form, then
  /// routes into the check-inbox state on success. Mirrors the verify form's
  /// action so a user who already knows their email is unverified does not
  /// have to submit credentials (and wait for a 403) first.
  static String _authErrorText(AuthApiError e) => switch (e) {
    AuthInvalidCredentials(code: final code?)
        when code == 'PASSWORD_TOO_SHORT' =>
      'Password must be at least 8 characters',
    AuthInvalidCredentials(code: final code?)
        when code == 'PASSWORD_TOO_LONG' =>
      'Password is too long',
    AuthInvalidCredentials(code: final code?) when code == 'INVALID_EMAIL' =>
      'Enter a valid email address',
    AuthInvalidCredentials() => 'Incorrect email or password',
    AuthEmailTaken() => 'An account already exists for this email',
    AuthEmailNotVerified() => 'Verify your email — check your inbox.',
    AuthAccountDeleted() => accountDeletedNotice,
    AuthRateLimited(retryAfterSeconds: final seconds?) =>
      'Too many requests — try again in $seconds seconds.',
    AuthRateLimited() => 'Too many requests — try again in a minute.',
    AuthUnauthorized() => 'This session was rejected. Try signing in again.',
    AuthNetworkError() => 'Could not reach the server. Check your connection.',
    AuthServerError(statusCode: final status)
        when status != null && status >= 500 =>
      'The server hit a problem (HTTP $status). Please try again.',
    AuthServerError() => 'Server error: ${e.message}',
  };

  @override
  Widget build(BuildContext context) {
    if (_verifyMode) {
      return _buildVerifyForm(context);
    }
    if (_forgotMode) {
      return _buildForgotForm(context);
    }
    return _buildCredentialsForm(context);
  }

  Widget _buildCredentialsForm(BuildContext context) {
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
            setState(() {
              _createAccount = selection.first;
              _emailTaken = false;
              _verifyMode = false;
              _verifySent = false;
              _error = null;
            });
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
        if (!_createAccount)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              key: const Key('auth-forgot-link'),
              style: AppButtons.text,
              onPressed: () => setState(() {
                _forgotMode = true;
                _error = null;
              }),
              child: const Text('Forgot password?'),
            ),
          ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ],
        if (_emailTaken) ...[
          const SizedBox(height: 4),
          TextButton(
            key: const Key('auth-signin-instead'),
            onPressed: _switchToSignIn,
            child: const Text('Sign in instead'),
          ),
        ],
        if (widget.showSubmit) ...[
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
      ],
    );
  }

  /// The "verify your email — check your inbox" state: shown after a
  /// tokenless sign-up or an EMAIL_NOT_VERIFIED sign-in. Displays the
  /// addressed email, a resend action (429 surfaces the retry-after wait)
  /// and a way back to the sign-in form.
  Widget _buildVerifyForm(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final email = _emailController.text.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.mark_email_read_outlined, size: 40),
        const SizedBox(height: 12),
        Text(
          'Verify your email — check your inbox',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          email,
          key: const Key('auth-verify-email'),
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'We sent a verification link to this address. Open it to activate '
          'your account, then come back and sign in.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        if (_verifySent) ...[
          const SizedBox(height: 8),
          Text(
            'Verification email sent again to $email.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.primary),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ],
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('auth-resend'),
          onPressed: _submitting ? null : _resendVerification,
          child: _submitting
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Resend email'),
        ),
        TextButton(
          key: const Key('auth-verify-back'),
          onPressed: _submitting ? null : _switchToSignIn,
          child: const Text('Back to sign in'),
        ),
      ],
    );
  }

  Widget _buildForgotForm(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (_forgotSent) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(Icons.mark_email_read_outlined, size: 40),
          const SizedBox(height: 12),
          Text(
            'If an account exists for ${_emailController.text.trim()}, a '
            'password reset link is on its way.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 20),
          TextButton(
            key: const Key('auth-forgot-back'),
            onPressed: _switchToSignIn,
            child: const Text('Back to sign in'),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Reset your password', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          'Enter the email address on your account and we will send you a '
          'password reset link.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const Key('auth-forgot-email'),
          controller: _emailController,
          decoration: const InputDecoration(
            labelText: 'Email address',
            border: OutlineInputBorder(),
          ),
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submitForgot(),
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
          key: const Key('auth-forgot-submit'),
          onPressed: _submitting ? null : _submitForgot,
          child: _submitting
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Send reset link'),
        ),
        TextButton(
          key: const Key('auth-forgot-back'),
          onPressed: _submitting ? null : _switchToSignIn,
          child: const Text('Back to sign in'),
        ),
      ],
    );
  }
}

/// Shows the re-auth flow as a modal pop-up overlay (chat + voice). Pops on
/// success or dismiss; [onSuccess]/[onDismiss] are invoked by the host AFTER
/// the dialog closes so it can retry / clear state exactly once.
Future<void> showReauthDialog(
  BuildContext context, {
  required ValueChanged<AuthSession> onSuccess,
  VoidCallback? onDismiss,
  String title = 'Session expired',
  String message =
      'Your API key was rejected by the gateway. Sign in again to continue.',
}) {
  return showDialog<void>(
    context: context,
    // Tapping outside counts as dismiss (clears the auth-required state).
    barrierDismissible: true,
    builder: (dialogContext) => AlertDialog(
      key: const Key('reauth-dialog'),
      scrollable: true,
      contentPadding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
      actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      content: _ReauthDialogBody(
        title: title,
        message: message,
        onSuccess: (session) {
          Navigator.of(dialogContext).pop();
          onSuccess(session);
        },
        onDismiss: () {
          Navigator.of(dialogContext).pop();
          onDismiss?.call();
        },
      ),
    ),
  );
}

/// Pop-up (dialog) body for the re-auth flow — the same title/message and
/// [AuthFlow] as [ReauthCard], excluding the card's outer margin/colour.
class _ReauthDialogBody extends StatelessWidget {
  const _ReauthDialogBody({
    required this.title,
    required this.message,
    required this.onSuccess,
    required this.onDismiss,
  });

  final String title;
  final String message;
  final ValueChanged<AuthSession> onSuccess;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
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
