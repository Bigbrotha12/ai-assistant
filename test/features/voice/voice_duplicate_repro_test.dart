import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/screen_wake_lock.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/ui/voice_screen.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

/// [ActiveConversationNotifier] pinned to a fixed initial id.
class _FixedActiveConversation extends ActiveConversationNotifier {
  _FixedActiveConversation(this.initial);

  final String initial;

  @override
  String? build() => initial;
}

void main() {
  ProviderContainer buildContainer({
    required FakeChatClient chat,
    FakeChatStore? store,
    String? activeConversationId,
  }) {
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
        screenWakeLockProvider.overrideWithValue(NoopScreenWakeLock()),
        chatApiClientProvider.overrideWithValue(chat),
        chatStoreProvider.overrideWithValue(store ?? FakeChatStore()),
        if (activeConversationId != null)
          activeConversationIdProvider.overrideWith(
            () => _FixedActiveConversation(activeConversationId),
          ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  testWidgets(
      'a second voice turn never re-emits the previous assistant reply '
      'alongside the new user utterance', (tester) async {
    final chat = FakeChatClient(
      streamDeltas: const [
        ['First reply'],
        ['Second reply'],
      ],
      results: const [
        ChatResult(content: 'First reply', toolCalls: [], finishReason: 'stop'),
        ChatResult(content: 'Second reply', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final container = buildContainer(
      chat: chat,
      store: store,
      activeConversationId: 'conv-dup',
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await tester.pump();

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();

    // Every state emission that introduces a new user utterance must NOT
    // carry a stale lastReply from the previous turn — that pairing is what
    // made the transcript append the previous reply a second time.
    final emissions = <(String?, String?)>[];
    final sub = controller.stateStream.listen(
      (s) => emissions.add((s.onDeviceTranscript, s.lastReply)),
    );
    addTearDown(sub.cancel);

    await controller.sendText('hello', speakReply: false);
    expect(controller.state.lastReply, 'First reply');

    await controller.sendText('who are you?', speakReply: false);
    expect(controller.state.lastReply, 'Second reply');

    await tester.pump();

    for (final (transcript, lastReply) in emissions) {
      if (transcript != null && transcript.trim().isNotEmpty) {
        // The moment a new user utterance is emitted, no stale reply may ride
        // along with it.
        expect(lastReply, isNull);
      }
    }

    // The persisted conversation holds exactly one user + one assistant per
    // turn — never a duplicate assistant reply.
    final conv = await store.loadConversation('conv-dup');
    expect(conv, isNotNull);
    expect(
      conv!.messages.map((m) => m.role).toList(),
      [MessageRole.user, MessageRole.assistant, MessageRole.user, MessageRole.assistant],
    );
    expect(conv.messages.map((m) => m.content).toList(),
        ['hello', 'First reply', 'who are you?', 'Second reply']);
  });
}