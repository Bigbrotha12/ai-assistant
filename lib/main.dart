import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:smooth_page_indicator/smooth_page_indicator.dart';

import './app/global_messenger.dart';
import './app/onboarding_gate.dart';
import './app/theme.dart';
import './app/theme_providers.dart';
import './app/widgets/gold_band.dart';
import './app/widgets/step_dots.dart';
import './features/plugins/data/managed_chat_providers.dart';

void main() {
  // Loads the date symbol/pattern tables for *every* locale. Without this,
  // `DateFormat.yMMMd` throws `LocaleDataException` for any locale other than
  // `en_US`, which would crash date rendering for every non-US user. Safe to
  // call before `runApp` — it registers data synchronously and returns an
  // already-completed future.
  initializeDateFormatting();
  runApp(const ProviderScope(child: AiAssistantApp()));
}

class AiAssistantApp extends ConsumerWidget {
  const AiAssistantApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tier = ref.watch(appTierProvider).value ?? AppTier.standard;
    final premium = tier == AppTier.premium;
    // Keep the background-poll lifecycle observer alive app-wide (plan P3):
    // reading it here (never in an autoDispose UI family) means a conversation
    // notifier rebuild can never orphan the foreground/background wiring while
    // a background job is pending.
    ref.watch(chatPollerLifecycleObserverProvider);

    return MaterialApp(
      title: 'Voice Assist',
      // Root messenger handle for context-less snackbars (showGlobalSnack).
      scaffoldMessengerKey: scaffoldMessengerKey,
      theme: premium ? buildPremiumTheme() : buildCoreTheme(),
      // The premium tier paints the warm-ivory paper base plus grain behind
      // every screen (the scaffold chrome is transparent so both show
      // through). The paper base is required: without it the translucent
      // grain would let the window's dark background show through.
      builder: (context, child) {
        final body = premium
            ? Stack(
                fit: StackFit.expand,
                children: [
                  RepaintBoundary(
                    child: ColoredBox(
                      color: AppColors.paperBase,
                      child: PaperTexture(),
                    ),
                  ),
                  child!,
                ],
              )
            : child!;
        // Single app-root home for the page-indicator look: the package's
        // defaults are hardcoded and ignore ThemeData, so seed them from the
        // active tier's scheme. `StepDots.effectFor`/`colorsFor` are the single
        // source of these values.
        final scheme = Theme.of(context).colorScheme;
        return SmoothPageIndicatorTheme(
          effect: StepDots.effectFor(scheme),
          defaultColors: StepDots.colorsFor(scheme),
          child: body,
        );
      },
      // The startup gate decides between onboarding and the voice-first home:
      // a configured app lands on the voice home (or the `open_chat` shortcut
      // target); a not-yet-configured app lands on onboarding.
      home: const OnboardingGate(),
    );
  }
}