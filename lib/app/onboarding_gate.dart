import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/chat/ui/chat_screen.dart';
import '../features/onboarding/ui/onboarding_screen.dart';
import '../features/voice/ui/voice_screen.dart';
import './widgets/launcher_shortcuts.dart';
import './app_startup.dart';
import '../features/auth/data/auth_credentials_providers.dart';
import '../features/settings/data/prefs_providers.dart';
import '../features/settings/data/settings_providers.dart';

/// Startup gate that decides onboarding vs home.
///
/// Decision rule (single source of truth):
/// - While any of the watched providers is still loading → branded splash.
/// - If any provider failed to read → error card with Retry. A read failure is
///   **never** treated as "not configured", and this path never calls any
///   store's `clear()`, so stored credentials can never be wiped here.
/// - Otherwise the app is **configured** iff `isConfigured(...)` — the user
///   has both an API key and an explicitly stored, valid host. `--dart-define`
///   defaults alone do NOT count as configured (they only prefill the forms).
///   - configured → the launcher-shortcut target screen (`ChatScreen` for
///     `open_chat`, `VoiceScreen` otherwise), preserving deep-link behavior.
///   - not configured → [OnboardingScreen].
class OnboardingGate extends ConsumerWidget {
  const OnboardingGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final credentials = ref.watch(authCredentialsProvider);
    final prefs = ref.watch(appPrefsProvider);

    if (settings.isLoading || credentials.isLoading || prefs.isLoading) {
      return const _SplashView();
    }

    if (settings.hasError || credentials.hasError || prefs.hasError) {
      return _ErrorView(
        onRetry: () {
          if (settings.hasError) ref.invalidate(settingsProvider);
          if (credentials.hasError) ref.invalidate(authCredentialsProvider);
          if (prefs.hasError) ref.invalidate(appPrefsProvider);
        },
      );
    }

    final configured = isConfigured(
      credentials: credentials.value,
      stored: settings.value,
    );
    if (!configured) {
      return const OnboardingScreen();
    }
    return switch (resolveInitialTarget()) {
      LauncherShortcutTarget.chat => const ChatScreen(),
      _ => const VoiceScreen(),
    };
  }
}

/// Plain branded splash shown while the startup providers load.
class _SplashView extends StatelessWidget {
  const _SplashView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'AI Assistant',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 24),
            const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}

/// Error card shown when any startup provider failed to read. [onRetry]
/// re-reads only the failed provider(s); it never touches the stores.
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.error_outline, color: scheme.error, size: 40),
                  const SizedBox(height: 12),
                  Text(
                    'Could not read your saved setup',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'The app could not load your saved host and API key. '
                    'Nothing was erased — tap Retry to try again.',
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: onRetry,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}