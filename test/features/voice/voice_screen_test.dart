import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/auth_credentials_providers.dart';
import 'package:ai_assistant/core/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/core/chat_client_provider.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/auth/auth_flow.dart';
import 'package:ai_assistant/features/voice/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/voice_screen.dart';
import 'package:ai_assistant/features/voice/voice_settings_providers.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

void main() {
  ProviderContainer buildContainer({FakeChatClient? chatClient}) {
    final container = ProviderContainer(
      overrides: [
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'myhost')),
        ),
        authCredentialsStoreProvider.overrideWithValue(
          FakeAuthCredentialsStore(
            stored: const AuthCredentials(apiKey: 'sk-1', email: 'me@x.dev'),
          ),
        ),
        micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
        audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
        audioSessionManagerProvider.overrideWithValue(FakeAudioSessionManager()),
        chatApiClientProvider.overrideWithValue(
          chatClient ?? FakeChatClient(),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  // The SpeakButton breathes/rings forever, so pumpAndSettle never settles.
  // Pump a fixed number of frames instead.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  testWidgets('a 401 conversation error surfaces the ReauthCard',
      (tester) async {
    final chatClient = FakeChatClient()
      ..error = const ChatServerError('HTTP 401', statusCode: 401);
    final container = buildContainer(chatClient: chatClient);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // Drive a conversation turn through the controller so the 401 lands in
    // the conversation state the screen renders.
    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    await controller.sendText('hello');
    await settle(tester);

    expect(find.byType(ReauthCard), findsOneWidget);
    expect(find.text('Session expired'), findsOneWidget);
  });

  testWidgets('dismissing the ReauthCard clears the voice error',
      (tester) async {
    final chatClient = FakeChatClient()
      ..error = const ChatServerError('HTTP 401', statusCode: 401);
    final container = buildContainer(chatClient: chatClient);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    await controller.sendText('hello');
    await settle(tester);

    expect(find.byType(ReauthCard), findsOneWidget);

    await tester.tap(find.byKey(const Key('reauth-dismiss')));
    await settle(tester);

    expect(find.byType(ReauthCard), findsNothing);
    expect(controller.state.error, isNull);
    // The session itself is untouched.
    expect(controller.state.isConnected, isTrue);
  });

  testWidgets('non-401 errors still render the generic error banner',
      (tester) async {
    final chatClient = FakeChatClient()
      ..error = const ChatServerError('HTTP 503', statusCode: 503);
    final container = buildContainer(chatClient: chatClient);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    await controller.sendText('hello');
    await settle(tester);

    expect(find.byType(ReauthCard), findsNothing);
    // A non-401 server error renders the generic banner's message.
    expect(find.textContaining('HTTP 503'), findsOneWidget);
  });
}