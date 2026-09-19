import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/chat/data/gateway_chat_client.dart';

void main() {
  group('chatApiClientProvider', () {
    test('creates a GatewayChatClient', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final client = container.read(chatApiClientProvider);
      expect(client, isA<GatewayChatClient>());
    });
  });
}