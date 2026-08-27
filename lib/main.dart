import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'features/chat/chat_screen.dart';

void main() => runApp(const ProviderScope(child: AiAssistantApp()));

class AiAssistantApp extends StatelessWidget {
  const AiAssistantApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Assistant',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const ChatScreen(),
    );
  }
}