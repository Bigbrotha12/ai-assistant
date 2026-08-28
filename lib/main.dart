import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'features/chat/chat_screen.dart';
import 'features/voice/voice_screen.dart';
import 'features/widgets/launcher_shortcuts.dart';

void main() => runApp(const ProviderScope(child: AiAssistantApp()));

class AiAssistantApp extends StatelessWidget {
  const AiAssistantApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Assistant',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      // Launcher shortcuts launch with `aiassistant://<target>` as the intent
      // data, surfaced as the initial route. Route it to the matching screen;
      // a normal launch (no URI) always opens chat.
      home: switch (resolveInitialTarget()) {
        LauncherShortcutTarget.voice => const VoiceScreen(),
        _ => const ChatScreen(),
      },
    );
  }
}