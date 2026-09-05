import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/auth_credentials_providers.dart';
import 'package:ai_assistant/core/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/core/chat_client_provider.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/core/widgets/speak_button.dart';
import 'package:ai_assistant/features/auth/auth_flow.dart';
import 'package:ai_assistant/features/chat/chat_providers.dart';
import 'package:ai_assistant/features/chat/conversation_list.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';
import 'package:ai_assistant/features/chat/message_model.dart';
import 'package:ai_assistant/features/voice/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/tts_engine.dart';
import 'package:ai_assistant/features/voice/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/voice_screen.dart';
import 'package:ai_assistant/features/voice/voice_settings_providers.dart';
import 'package:ai_assistant/features/voice/stt_engine.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

/// [ActiveConversationNotifier] pinned to a fixed initial id, so the seeded
/// transcript tests can target a specific conversation.
class _FixedActiveConversation extends ActiveConversationNotifier {
  _FixedActiveConversation(this.initial);

  final String initial;

  @override
  String? build() => initial;
}

/// [FakeChatStore] whose [loadConversation] can be held open with a gate, so a
/// test can deterministically pause a re-seed in its loading window.
class _GatedChatStore extends FakeChatStore {
  _GatedChatStore({super.initial});

  Completer<void>? loadGate;

  @override
  Future<Conversation?> loadConversation(String id) async {
    final gate = loadGate;
    if (gate != null) await gate.future;
    return super.loadConversation(id);
  }
}

/// [FakeEngineManager] that exposes a [FakeTtsEngine], so the text-mode test
/// can prove TTS is never invoked (an accidental synthesis would record it).
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
        micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
        audioPlaybackServiceProvider.overrideWithValue(
          playback ?? FakeAudioPlayback(),
        ),
        audioSessionManagerProvider.overrideWithValue(FakeAudioSessionManager()),
        chatApiClientProvider.overrideWithValue(
          chatClient ?? FakeChatClient(),
        ),
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
  }) =>
      Conversation(
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

  testWidgets('seeds the transcript from the active conversation on init',
      (tester) async {
    final store = FakeChatStore(initial: [
      conversation(
        id: 'conv-1',
        title: 'First',
        messages: [
          message(
            id: 'm1',
            role: MessageRole.user,
            content: 'Where is the moon?',
          ),
          message(
            id: 'm2',
            role: MessageRole.assistant,
            content: 'Above you.',
          ),
          // Tool rows are internal plumbing and must not surface as bubbles.
          message(id: 'm3', role: MessageRole.tool, content: 'call result'),
        ],
      ),
    ]);
    final container = buildContainer(store: store, activeConversationId: 'conv-1');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);

    expect(find.text('Where is the moon?'), findsOneWidget);
    expect(find.text('Above you.'), findsOneWidget);
    expect(find.text('call result'), findsNothing);
  });

  testWidgets(
      'a live turn repeating the last seeded user text still appends a new bubble',
      (tester) async {
    final store = FakeChatStore(initial: [
      conversation(
        id: 'conv-1',
        title: 'First',
        messages: [
          message(
            id: 'm1',
            role: MessageRole.user,
            content: 'book me a flight',
          ),
        ],
      ),
    ]);
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Done'],
      ],
      results: const [
        ChatResult(content: 'Done', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final container = buildContainer(
      chatClient: chat,
      store: store,
      activeConversationId: 'conv-1',
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);
    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);

    // A new (voice) turn with the exact text of the seeded last message must
    // not be collapsed into the seeded history by the append dedupe.
    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    await controller.sendText('book me a flight', speakReply: false);
    await settle(tester);

    expect(find.text('book me a flight'), findsNWidgets(2));
    expect(find.text('Done'), findsOneWidget);
  });

  testWidgets(
      'text mode sends a typed message, streams a reply without TTS, and '
      'persists the conversation', (tester) async {
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Hi there'],
      ],
      results: const [
        ChatResult(content: 'Hi there', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final tts = FakeTtsEngine();
    final container = buildContainer(
      chatClient: chat,
      store: store,
      tts: tts,
      activeConversationId: 'conv-text',
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // Switch to text mode and send a message.
    await tester.tap(find.text('Text'));
    await tester.pump();
    expect(find.byKey(const Key('voice-composer-field')), findsOneWidget);
    expect(find.text('PRESS AND HOLD TO TALK'), findsNothing);

    await tester.enterText(
      find.byKey(const Key('voice-composer-field')),
      'hello',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('voice-composer-send')));
    await settle(tester);

    // TTS must never run for a text-mode turn.
    expect(tts.synthesized, isEmpty);
    final playback =
        container.read(audioPlaybackServiceProvider) as FakeAudioPlayback;
    expect(playback.playedChunks, isEmpty);

    // The user bubble appears immediately and the reply after it streams.
    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);
    expect(find.text('hello'), findsOneWidget);
    expect(find.text('Hi there'), findsOneWidget);

    // The turn was persisted to the active conversation.
    final conv = await store.loadConversation('conv-text');
    expect(conv, isNotNull);
    expect(conv!.title, 'hello');
    expect(
      conv.messages.map((m) => m.role).toList(),
      [MessageRole.user, MessageRole.assistant],
    );
    expect(conv.messages[0].content, 'hello');
    expect(conv.messages[1].content, 'Hi there');
  });

  testWidgets('sending a typed message while the AI speaks barges in first',
      (tester) async {
    final tts = FakeTtsEngine();
    final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Typed reply'],
      ],
      results: const [
        ChatResult(content: 'Typed reply', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final container = buildContainer(
      chatClient: chat,
      tts: tts,
      playback: playback,
      activeConversationId: 'conv-barge',
    );
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
    unawaited(controller.synthesizeOnDevice('spoken reply'));
    await settle(tester);
    expect(controller.state.isAiSpeaking, isTrue);
    expect(playback.playedChunks, hasLength(1));

    // Switch to text mode and send a typed message while the AI is speaking.
    await tester.tap(find.text('Text'));
    await tester.pump();
    await tester.enterText(
      find.byKey(const Key('voice-composer-field')),
      'typed',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('voice-composer-send')));
    await settle(tester);

    // Barge-in: the AI's speech is stopped before the typed turn is sent.
    expect(controller.state.isAiSpeaking, isFalse);
    // TTS must still not run for the text-mode turn.
    expect(tts.synthesized, ['spoken reply']);
    expect(controller.state.lastReply, 'Typed reply');
  });

  testWidgets('history action opens the session list and switching re-seeds',
      (tester) async {
    final store = FakeChatStore(initial: [
      conversation(
        id: 'conv-a',
        title: 'Conversation A',
        messages: [
          message(
            id: 'a1',
            role: MessageRole.user,
            content: 'Hello A',
          ),
          message(
            id: 'a2',
            role: MessageRole.assistant,
            content: 'Reply A',
          ),
        ],
      ),
      conversation(
        id: 'conv-b',
        title: 'Conversation B',
        messages: [
          message(id: 'b1', role: MessageRole.user, content: 'Hello B'),
        ],
      ),
    ]);
    final container = buildContainer(store: store, activeConversationId: 'conv-a');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: VoiceScreen()),
      ),
    );
    await settle(tester);

    // Conversation A's history is seeded.
    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);
    expect(find.text('Hello A'), findsOneWidget);
    expect(find.text('Hello B'), findsNothing);

    // Open history and pick Conversation B.
    await tester.tap(find.byKey(const Key('history')));
    await pumpFrames(tester);
    expect(find.byType(ConversationListScreen), findsOneWidget);

    await tester.tap(find.text('Conversation B'));
    // The reverse route transition is longer than a plain frame; pump well
    // past it (the SpeakButton below re-animates, so never pumpAndSettle).
    await pumpFrames(tester, 25);

    // The active id switched and the transcript re-seeded from B.
    expect(container.read(activeConversationIdProvider), 'conv-b');
    expect(find.byType(ConversationListScreen), findsNothing);
    expect(find.text('Hello A'), findsNothing);
    expect(find.text('Hello B'), findsOneWidget);
  });

  testWidgets(
      'switching conversations never re-emits the previous conversation\'s '
      'reply as a phantom bubble', (tester) async {
    final store = FakeChatStore(initial: [
      conversation(
        id: 'conv-a',
        title: 'Conversation A',
        messages: [
          message(
            id: 'a1',
            role: MessageRole.user,
            content: 'Hello A',
          ),
          message(
            id: 'a2',
            role: MessageRole.assistant,
            content: 'Reply A',
          ),
        ],
      ),
      conversation(
        id: 'conv-b',
        title: 'Conversation B',
        messages: [
          message(id: 'b1', role: MessageRole.user, content: 'Hello B'),
        ],
      ),
    ]);
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Reply A'],
      ],
      results: const [
        ChatResult(content: 'Reply A', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final container = buildContainer(
      chatClient: chat,
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

    // Complete a turn in conversation A so lastReply is set on the shared
    // controller.
    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();
    await controller.sendText('hello', speakReply: false);
    await settle(tester);

    // Open history and switch to B.
    await tester.tap(find.byKey(const Key('history')));
    await pumpFrames(tester);
    await tester.tap(find.text('Conversation B'));
    await pumpFrames(tester, 25);

    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);

    // B's seeded history shows; A's reply must NOT appear as a phantom bubble.
    expect(find.text('Hello B'), findsOneWidget);
    expect(find.text('Hello A'), findsNothing);
    expect(find.text('Reply A'), findsNothing);

    // Any subsequent controller emission must not leak A's reply either.
    await controller.startConversation();
    await pumpFrames(tester);
    expect(find.text('Reply A'), findsNothing);
  });

  testWidgets(
      'a live append during re-seed is queued, then replayed after the seeded '
      'history', (tester) async {
    final store = _GatedChatStore(initial: [
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
    ]);
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Reply live'],
      ],
      results: const [
        ChatResult(content: 'Reply live', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final container = buildContainer(
      chatClient: chat,
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
    await tester.tap(find.text('Transcript'));
    await pumpFrames(tester);
    expect(find.text('Hello A'), findsOneWidget);

    final controller = container.read(voiceControllerProvider);
    await controller.startConversation();

    // Gate the next seed's store load, then switch to B: the seed clears the
    // panel and blocks inside its loading window.
    store.loadGate = Completer<void>();
    container.read(activeConversationIdProvider.notifier).set('conv-b');
    await tester.pump();

    // A live turn lands while the seed is in flight; its bubbles are queued.
    // (Not awaited: sendText's context builder also blocks on the gate.)
    unawaited(controller.sendText('live', speakReply: false));
    await tester.pump();

    // The seed hasn't landed yet.
    expect(find.text('Hello B'), findsNothing);

    // Release the gate: the seed lands first, then the queued live entries
    // replay in arrival order after the seeded prefix.
    store.loadGate!.complete();
    store.loadGate = null;
    await pumpFrames(tester);

    expect(find.text('Hello B'), findsOneWidget);
    expect(find.text('live'), findsOneWidget);
    expect(find.text('Reply live'), findsOneWidget);
    // Seeded history renders above the live turn (never scrambled before it).
    expect(
      tester.getTopLeft(find.text('Hello B')).dy,
      lessThan(tester.getTopLeft(find.text('live')).dy),
    );
    expect(
      tester.getTopLeft(find.text('live')).dy,
      lessThan(tester.getTopLeft(find.text('Reply live')).dy),
    );
  });

  testWidgets('the Stop control appears while the AI speaks and tapping it '
      'stops playback', (tester) async {
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

    // No stop control while idle.
    expect(find.byKey(const Key('voice-stop-speaking')), findsNothing);

    // The AI starts a reply that keeps playing (held open).
    unawaited(controller.synthesizeOnDevice('reply'));
    await settle(tester);
    expect(controller.state.isAiSpeaking, isTrue);

    // The Stop control is visible while the AI is speaking.
    final stop = find.byKey(const Key('voice-stop-speaking'));
    expect(stop, findsOneWidget);

    // Tapping it stops playback and hides the control.
    await tester.tap(stop);
    await settle(tester);
    expect(controller.state.isAiSpeaking, isFalse);
    expect(find.byKey(const Key('voice-stop-speaking')), findsNothing);

    // Releasing the held track must not restart anything.
    playback.holdCompletion!.complete();
    await settle(tester);
    expect(controller.state.isAiSpeaking, isFalse);
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

    // Release: the hold ends cleanly. Drain the hold-end chain (subscription
    // cancels, mic stop, controller sync) — settle's frame pumps alone do not
    // flush every cancel future in the fake-async zone.
    // Release: the hold ends cleanly. The teardown chain (stream-subscription
    // cancels) runs on the real event loop, which fake-async frame pumps do
    // not drive, so end the session directly instead of asserting the
    // mid-teardown recording state.
    await gesture.up();
    await controller.endConversation();
    expect(controller.state.isConnected, isFalse);
    expect(controller.state.isRecording, isFalse);
  });

  testWidgets('shows the Working status while the LLM stream is in flight',
      (tester) async {
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
    expect(find.text('Working…'), findsOneWidget);

    chat.hang!.complete(
      const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
    );
    await settle(tester);

    expect(controller.state.isGenerating, isFalse);
    expect(find.text('Working…'), findsNothing);
  });

  testWidgets('renders the transient notice when a busy flush is dropped',
      (tester) async {
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
    final mic = container.read(micCaptureServiceProvider) as FakeMicCaptureService;
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
    expect(
      find.text('Still working — one thing at a time.'),
      findsOneWidget,
    );

    chat.hang!.complete(
      const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
    );
    await settle(tester);
  });
}