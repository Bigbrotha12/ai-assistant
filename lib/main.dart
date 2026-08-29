import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'core/theme_providers.dart';
import 'core/widgets/gold_band.dart';
import 'features/chat/chat_screen.dart';
import 'features/voice/voice_screen.dart';
import 'features/widgets/launcher_shortcuts.dart';

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
      // The app is voice-first: a normal launch (and the `open_voice`
      // shortcut) lands on the voice home; the `open_chat` shortcut opens
      // the chat screen directly. Chat stays reachable from the voice
      // home's menu.
      home: switch (resolveInitialTarget()) {
        LauncherShortcutTarget.chat => const ChatScreen(),
        _ => const VoiceScreen(),
      },
    );
  }
}