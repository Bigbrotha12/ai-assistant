import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/app/theme_providers.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/app/widgets/speak_button.dart';
import 'package:ai_assistant/features/auth/ui/auth_flow.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_screen.dart';
import 'package:ai_assistant/features/chat/ui/conversation_list.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/screen_wake_lock.dart';
import 'package:ai_assistant/features/voice/data/tts_engine.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/ui/voice_screen.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:ai_assistant/features/voice/data/stt_engine.dart';
import 'package:ai_assistant/main.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

/// [ActiveConversationNotifier] pinned to a fixed initial id.
class _FixedActiveConversation extends ActiveConversationNotifier {
  _FixedActiveConversation(this.initial);

  final String initial;

  @override
  String? build() => initial;
}

/// [FakeEngineManager] that exposes a [FakeTtsEngine], so voice-turn tests can
/// assert TTS is invoked as expected.
class _TtsAwareEngineManager extends FakeEngineManager {
  _TtsAwareEngineManager(this.tts);

  final FakeTtsEngine tts;

  @override
  TtsEngine? get ttsEngine => tts;
}

/// [FakeEngineManager] that exposes a [FakeSttEngine], so busy-state tests
/// can drive real mid-generation flushes through the controller.
class _SttAwareEngineManager extends FakeEngineManager {
  _SttAwareEngineManager(this.stt);

  final FakeSttEngine stt;

  @override
  SttEngine? get sttEngine => stt;
}

void main() {
  ProviderContainer buildContainer({
    FakeChatClient? chatClient,
    FakeChatStore? store,
    FakeTtsEngine? tts,
    FakeAudioPlayback? playback,
    FakeSttEngine? stt,
    String? activeConversationId,
  }) {
    // One scripted client drives the managed voice send seam override — the
    // controller's sendTurn goes through voiceTurnSenderProvider, which must
    // script the same instance.
    final resolvedChat = chatClient ?? FakeChatClient();
    final container = ProviderContainer(
      overrides: [
        engineManagerProvider.overrideWithValue(
          tts != null
              ? _TtsAwareEngineManager(tts)
              : stt != null
              ? _SttAwareEngineManager(stt)
              : FakeEngineManager(),
        ),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'myhost')),
        ),
        authCredentialsStoreProvider.overrideWithValue(
          FakeAuthCredentialsStore(
            stored: const AuthCredentials(apiKey: 'sk-1', email: 'me@x.dev'),
          ),
        ),
        backendProbeProvider.overrideWithValue(FakeProbe()),
        micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
        audioPlaybackServiceProvider.overrideWithValue(
          playback ?? FakeAudioPlayback(),
        ),
        audioSessionManagerProvider.overrideWithValue(
          FakeAudioSessionManager(),
        ),
        screenWakeLockProvider.overrideWithValue(NoopScreenWakeLock()),
        voiceTurnSenderProvider.overrideWithValue(({
          required conversationId,
          required messages,
          required userText,
          systemPrompt,
          cancelToken,
          onReceived,
          onContent,
          onToolCallDelta,
        }) {
          return resolvedChat.sendTurn(
            conversationId,
            history: const [],
            userText: userText,
            messages: messages,
            systemPrompt: systemPrompt,
            cancelToken: cancelToken,
            onReceived: onReceived,
            onContent: onContent,
            onToolCallDelta: onToolCallDelta,
          );
        }),
        chatStoreProvider.overrideWithValue(store ?? FakeChatStore()),
        filesStoreProvider.overrideWithValue(FakeFileStore()),
        if (activeConversationId != null)
          activeConversationIdProvider.overrideWith(
            () => _FixedActiveConversation(activeConversationId),
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

  /// Pumps [frames] frames of 40ms each — enough to ride out AnimatedSize and
  /// route transitions without pumpAndSettle (which the SpeakButton blocks).
  Future<void> pumpFrames(WidgetTester tester, [int frames = 10]) async {
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 40));
    }
  }

  Conversation conversation({
    required String id,
    required String title,
    required List<Message> messages,
  }) => Conversation(
    id: id,
    title: title,
    messages: messages,
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 1, 1, 0, 0, 1),
  );

  Message message({
    required String id,
    required MessageRole role,
    required String content,
  }) =>
      Message(id: id, role: role, content: content, createdAt: DateTime(2026));

  testWidgets('a 401 conversation error surfaces the ReauthCard', (
    tester,
  ) async {
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

  testWidgets(
    'missing credentials surface the ReauthCard on the voice surface',
    (tester) async {
      // No stored session/API key: the resolver throws ChatAuthRequiredError
      // before any network call; the voice surface must treat it like a gateway
      // 401 and surface the login flow.
      final chatClient = FakeChatClient()
        ..error = const ChatAuthRequiredError('Not authenticated');
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
      expect(find.text('Session expired'), findsOneWidget);
    },
  );

  testWidgets('dismissing the ReauthCard clears the voice error', (
    tester,
  ) async {
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

  testWidgets('non-401 errors still render the generic error banner', (
    tester,
  ) async {
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

  testWidgets('the Text segment of the pill opens the chat screen', (
    tester,
  ) async {
    final container = buildContainer(activeConversationId: 'conv-1');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // The voice surface has no text composer — text mode lives on the chat
    // screen, reached through the shared pill. Assert no TextField (the chat
    // composer) is present while on the voice surface.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(SpeakButton), findsOneWidget);

    await tester.tap(find.byKey(const Key('voice-mode-text')));
    await pumpFrames(tester);

    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('history action opens the session list and switching selects '
      'the conversation', (tester) async {
    final store = FakeChatStore(
      initial: [
        conversation(
          id: 'conv-a',
          title: 'Conversation A',
          messages: [
            message(id: 'a1', role: MessageRole.user, content: 'Hello A'),
          ],
        ),
        conversation(
          id: 'conv-b',
          title: 'Conversation B',
          messages: [
            message(id: 'b1', role: MessageRole.user, content: 'Hello B'),
          ],
        ),
      ],
    );
    final container = buildContainer(
      store: store,
      activeConversationId: 'conv-a',
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // Open history and pick Conversation B.
    await tester.tap(find.byKey(const Key('history')));
    await pumpFrames(tester);
    expect(find.byType(ConversationListScreen), findsOneWidget);

    await tester.tap(find.text('Conversation B'));
    // The reverse route transition is longer than a plain frame; pump well
    // past it (the SpeakButton below re-animates, so never pumpAndSettle).
    await pumpFrames(tester, 25);

    // The active id switched; the chat screen will read it when opened.
    expect(container.read(activeConversationIdProvider), 'conv-b');
    expect(find.byType(ConversationListScreen), findsNothing);
  });

  testWidgets('the SpeakButton shows a stop affordance while the AI speaks', (
    tester,
  ) async {
    final tts = FakeTtsEngine();
    final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
    final container = buildContainer(tts: tts, playback: playback);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();

    // Mic glyph while idle (no stop affordance).
    expect(find.byIcon(Icons.stop), findsNothing);

    // The AI starts a reply that keeps playing (held open).
    unawaited(controller.synthesizeOnDevice('reply'));
    await settle(tester);
    expect(controller.state.isAiSpeaking, isTrue);

    // The stop affordance signals that pressing the button will barge in.
    expect(find.byIcon(Icons.stop), findsWidgets);

    // Releasing the held track must not leave the stop affordance behind.
    playback.holdCompletion!.complete();
    await settle(tester);
    expect(controller.state.isAiSpeaking, isFalse);
    expect(find.byIcon(Icons.stop), findsNothing);
  });

  testWidgets('the SpeakButton sits at the exact vertical middle of the hero', (
    tester,
  ) async {
    final container = buildContainer();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // The hero text above (status line, phase label, waveform) and the
    // caption below must not pull the button off the viewport's vertical
    // middle.
    final buttonCenter = tester.getCenter(find.byType(SpeakButton));
    final heroRect = tester.getRect(find.byType(SingleChildScrollView));
    expect(buttonCenter.dy, moreOrLessEquals(heroRect.center.dy, epsilon: 0.5));
  });

  testWidgets('holding the talk button while the AI speaks stops the AI and '
      'starts recording', (tester) async {
    final tts = FakeTtsEngine();
    final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
    final container = buildContainer(tts: tts, playback: playback);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();

    // The AI starts a reply that keeps playing (held open).
    unawaited(controller.synthesizeOnDevice('reply'));
    await settle(tester);
    expect(controller.state.isAiSpeaking, isTrue);

    // Press and hold the talk button: barge-in stops the AI and recording
    // starts so the user's utterance is captured.
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(SpeakButton)),
    );
    await settle(tester);

    expect(controller.state.isAiSpeaking, isFalse);
    expect(controller.state.isRecording, isTrue);
    expect(playback.playedChunks, hasLength(1));

    // Release: the hold ends cleanly. The teardown chain (stream-subscription
    // cancels) runs on the real event loop, which fake-async frame pumps do
    // not drive, so end the session directly instead of asserting the
    // mid-teardown recording state.
    await gesture.up();
    await controller.endConversation();
    expect(controller.state.isConnected, isFalse);
    expect(controller.state.isRecording, isFalse);
  });

  testWidgets('holding the talk button while the AI is still generating '
      '(no audio yet) interrupts the turn and starts recording', (
    tester,
  ) async {
    // The reply streams but the turn hangs mid-generation, so isGenerating is
    // true while isAiSpeaking is still false ("Working…" status).
    final chat = FakeChatClient()..hang = Completer<ChatResult>();
    final tts = FakeTtsEngine();
    final container = buildContainer(chatClient: chat, tts: tts);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    // The turn never produces audio while the stream is held.
    unawaited(controller.sendText('hello'));
    await settle(tester);
    expect(controller.state.isGenerating, isTrue);
    expect(controller.state.isAiSpeaking, isFalse);
    expect(controller.state.isRecording, isFalse);

    // Press and hold: recording starts AND the generating turn is interrupted.
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(SpeakButton)),
    );
    await settle(tester);

    expect(controller.state.isRecording, isTrue);
    expect(controller.state.isGenerating, isTrue); // stream still held

    // Releasing the interrupted stream must abandon the turn — no TTS may
    // speak the interrupted reply over the user's recording.
    chat.hang!.complete(
      const ChatResult(
        content: 'Would have spoken',
        toolCalls: [],
        finishReason: 'stop',
      ),
    );
    await pumpFrames(tester);
    expect(controller.state.isGenerating, isFalse);
    expect(controller.state.isAiSpeaking, isFalse);
    expect(tts.synthesized, isEmpty);
    expect(controller.state.isRecording, isTrue);

    await gesture.up();
    await controller.endConversation();
  });

  testWidgets('holding the talk button while the AI speaks starts recording '
      'even when the playback stop is slow', (tester) async {
    final tts = FakeTtsEngine();
    final playback = FakeAudioPlayback()
      ..holdCompletion = Completer<void>()
      ..stopGate = Completer<void>();
    final container = buildContainer(tts: tts, playback: playback);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();

    // The AI is audibly speaking (playback held open).
    unawaited(controller.synthesizeOnDevice('reply'));
    await settle(tester);
    expect(controller.state.isAiSpeaking, isTrue);

    // Press and hold: the barge-in awaits a bounded interrupt, so a slow
    // playback stop delays recording only up to the bound — it must never
    // wedge the hold. The stop is held open here.
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(SpeakButton)),
    );
    await settle(tester);

    // The stop is still held open: within the bound, the mic has not opened
    // yet, but the barge-in already re-opened the mic gates synchronously.
    expect(controller.state.isAiSpeaking, isFalse);
    expect(controller.state.isRecording, isFalse);

    // Past the interrupt bound: the mic opens even though the stop hangs.
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 20));
    expect(controller.state.isRecording, isTrue);

    // The stop completes; the hold ends cleanly.
    playback.stopGate!.complete();
    playback.holdCompletion!.complete();
    await gesture.up();
    await controller.endConversation();
    expect(controller.state.isConnected, isFalse);
    expect(controller.state.isRecording, isFalse);
  });

  testWidgets('shows the Working status while the LLM stream is in flight', (
    tester,
  ) async {
    final chat = FakeChatClient()..hang = Completer<ChatResult>();
    final container = buildContainer(chatClient: chat);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    unawaited(controller.sendText('hello'));
    await settle(tester);

    expect(controller.state.isGenerating, isTrue);
    // The phase label animates its trailing dots, so match on the phase word.
    expect(find.textContaining('Working'), findsOneWidget);

    chat.hang!.complete(
      const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
    );
    await settle(tester);

    expect(controller.state.isGenerating, isFalse);
    expect(find.textContaining('Working'), findsNothing);
  });

  testWidgets('renders the transient notice when a busy flush is dropped', (
    tester,
  ) async {
    final chat = FakeChatClient()..hang = Completer<ChatResult>();
    final container = buildContainer(chatClient: chat, stt: FakeSttEngine());
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    final controller = container.read(voiceControllerProvider);
    final mic =
        container.read(micCaptureServiceProvider) as FakeMicCaptureService;
    await controller.startConversation();
    // Turn 1 is a flushed utterance whose stream hangs mid-generation.
    mic.emitChunk([1, 1, 1]);
    await tester.pump();
    await controller.flushTranscriptionBuffer();
    await settle(tester);

    // A queued utterance (accepted), then a dropped one: the notice renders.
    mic.emitChunk([2, 2, 2]);
    await tester.pump();
    await controller.flushTranscriptionBuffer();
    mic.emitChunk([3, 3, 3]);
    await tester.pump();
    await controller.flushTranscriptionBuffer();
    await settle(tester);

    expect(controller.state.notice, isNotNull);
    expect(find.text('Dropped — one utterance at a time.'), findsOneWidget);

    chat.hang!.complete(
      const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
    );
    await settle(tester);
  });

  /// Boots the real [AiAssistantApp] with a fully faked provider graph. The
  /// onboarding gate lands on the voice home when a valid host is stored, so
  /// the voice provider graph must be resolvable too.
  Widget app({
    FakeSettingsStore? store,
    required FakeProbe probe,
    required FakeChatStore chatStore,
    required FakeChatClient client,
  }) {
    final settingsStore =
        store ??
        FakeSettingsStore(stored: const BackendSettings(host: 'myhost'));
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(settingsStore),
        // The app home is the onboarding gate, which also reads the auth and
        // prefs stores before routing to the voice home.
        authCredentialsStoreProvider.overrideWithValue(
          FakeAuthCredentialsStore(
            stored: const AuthCredentials(apiKey: 'test-key'),
          ),
        ),
        appPrefsStoreProvider.overrideWithValue(FakePrefsStore()),
        backendProbeProvider.overrideWithValue(probe),
        chatStoreProvider.overrideWithValue(chatStore),
        voiceTurnSenderProvider.overrideWithValue(({
          required conversationId,
          required messages,
          required userText,
          systemPrompt,
          cancelToken,
          onReceived,
          onContent,
          onToolCallDelta,
        }) {
          return client.sendTurn(
            conversationId,
            history: const [],
            userText: userText,
            messages: messages,
            systemPrompt: systemPrompt,
            cancelToken: cancelToken,
            onReceived: onReceived,
            onContent: onContent,
            onToolCallDelta: onToolCallDelta,
          );
        }),
        filesStoreProvider.overrideWithValue(FakeFileStore()),
        // The voice home boots the real audio stack (record, just_audio,
        // secure storage, path_provider); none of that exists in widget
        // tests, so every voice service is faked.
        engineManagerProvider.overrideWithValue(FakeEngineManager()),
        micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
        audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
        audioSessionManagerProvider.overrideWithValue(
          FakeAudioSessionManager(),
        ),
        screenWakeLockProvider.overrideWithValue(NoopScreenWakeLock()),
        vadProcessorProvider.overrideWithValue(FakeVadProcessor()),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
        appTierStoreProvider.overrideWithValue(FakeAppTierStore()),
      ],
      child: const AiAssistantApp(),
    );
  }

  /// Bounded pump: the voice home keeps idle animations running (the speak
  /// button's breathing pulse + ring repeat forever), so `pumpAndSettle`
  /// would time out. Fixed-duration pumps settle providers and route
  /// transitions without waiting for an idle frame.
  Future<void> pumpBounded(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  group('full-app boot', () {
    testWidgets('app boots to VoiceScreen with valid settings', (tester) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(
        app(
          store: store,
          probe: FakeProbe(),
          chatStore: FakeChatStore(),
          client: FakeChatClient(),
        ),
      );
      await pumpBounded(tester);

      expect(find.text('Voice Assist'), findsOneWidget);
      expect(find.byType(SpeakButton), findsOneWidget);
      expect(find.text('PRESS AND HOLD TO TALK'), findsOneWidget);
      // The shared voice/text pill renders in voice home too.
      expect(find.byKey(const Key('voice-input-mode-toggle')), findsOneWidget);
      expect(find.text('Backend not configured'), findsNothing);
    });

    testWidgets('Settings screen opens from the bottom bar gear', (
      tester,
    ) async {
      final store = FakeSettingsStore(
        stored: const BackendSettings(host: 'myhost'),
      );
      await tester.pumpWidget(
        app(
          store: store,
          probe: FakeProbe(),
          chatStore: FakeChatStore(),
          client: FakeChatClient(),
        ),
      );
      await pumpBounded(tester);

      // The settings gear in the bottom bar opens the settings screen.
      await tester.tap(find.byKey(const Key('engine-bar-settings')));
      await pumpBounded(tester);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Backend host'), findsOneWidget);
      expect(find.text('MCP token (optional)'), findsOneWidget);
    });
  });
}
