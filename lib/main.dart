import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/onboarding_gate.dart';
import 'core/theme.dart';
import 'core/theme_providers.dart';
import 'core/widgets/gold_band.dart';

void main() => runApp(const ProviderScope(child: AiAssistantApp()));

class AiAssistantApp extends ConsumerWidget {
  const AiAssistantApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tier = ref.watch(appTierProvider).value ?? AppTier.standard;
    final premium = tier == AppTier.premium;

    return MaterialApp(
      title: 'AI Assistant',
      theme: premium ? buildPremiumTheme() : buildCoreTheme(),
      // The premium tier paints the warm-ivory paper base plus grain behind
      // every screen (the scaffold chrome is transparent so both show
      // through). The paper base is required: without it the translucent
      // grain would let the window's dark background show through.
      builder: premium
          ? (context, child) => Stack(
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
          : null,
      // The startup gate decides between onboarding and the voice-first home:
      // a configured app lands on the voice home (or the `open_chat` shortcut
      // target); a not-yet-configured app lands on onboarding.
      home: const OnboardingGate(),
    );
  }
}