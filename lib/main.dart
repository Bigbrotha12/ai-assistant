import 'package:flutter/material.dart';

import 'core/config.dart';

void main() => runApp(const AiAssistantApp());

class AiAssistantApp extends StatelessWidget {
  const AiAssistantApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Assistant',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const ConnectionScreen(),
    );
  }
}

/// Phase-0 placeholder: verifies the tailnet backend is reachable before
/// chat/voice features land (see PLAN.md phases).
class ConnectionScreen extends StatelessWidget {
  const ConnectionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AI Assistant')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Scaffold ready - implementation pending PLAN.md'),
            const SizedBox(height: 12),
            Text(
              'host: ${BackendConfig.host}\n'
              'token-mint: ${BackendConfig.tokenMint}\n'
              'llm proxy: ${BackendConfig.llmProxy}',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
