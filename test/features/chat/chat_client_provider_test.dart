import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';

void main() {
  group('chatApiClientProvider', () {
    test('throws when inference is not configured at build time', () async {
      // In a test build the LLM_BASE_URL/LLM_MODEL/LLM_API_KEY dart-defines
      // are blank, mirroring a build that omitted them. The provider must fail
      // loudly (riverpod wraps the StateError in a ProviderException) instead
      // of silently routing chat to any fallback.
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(
        () => container.read(chatApiClientProvider),
        throwsA(
          isA<Object>().having(
            (e) => e.toString(),
            'message',
            contains('No inference endpoint configured'),
          ),
        ),
      );
    });
  });
}