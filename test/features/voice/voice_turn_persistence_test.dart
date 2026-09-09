import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/screen_wake_lock.dart';
import 'package:ai_assistant/features/voice/data/stt_engine.dart';
import 'package:ai_assistant/features/voice/data/tts_engine.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

/// Exercises the REAL persistence + context wiring: the test drives the
/// [VoiceController] built by [VoiceControllerNotifier] (with fake
/// services substituted), so [onUserMessage] / [onTranscript] /
/// [contextBuilder] run the notifier's actual `_persistUserMessage` /
/// `_persistAssistantReply` / `_buildRequestMessages` instead of a hand-rolled
/// copy.
class _EngineAwareManager extends FakeEngineManager {
  _EngineAwareManager({this.stt, this.tts});

  final FakeSttEngine? stt;
  final FakeTtsEngine? tts;

  @override
  SttEngine? get sttEngine => stt;

  @override
  TtsEngine? get ttsEngine => tts;
}

ProviderContainer _container({
  required FakeChatClient chatClient,
  FakeChatStore? store,
  FakeSttEngine? stt,
  FakeTtsEngine? tts,
}) {
  final container = ProviderContainer(
    overrides: [
      engineManagerProvider.overrideWithValue(
        _EngineAwareManager(stt: stt, tts: tts),
      ),
      micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
      audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
      audioSessionManagerProvider.overrideWithValue(FakeAudioSessionManager()),
      screenWakeLockProvider.overrideWithValue(NoopScreenWakeLock()),
      chatApiClientProvider.overrideWithValue(chatClient),
      chatStoreProvider.overrideWithValue(store ?? FakeChatStore()),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

/// Drains the real notifier's fire-and-forget persistence tail. The fake store
/// resolves without timers, so a handful of event-loop turns suffice.
Future<void> settle() async {
  for (var i = 0; i < 10; i++) {
    await pumpEventQueue();
  }
}

void main() {
  // The real EngineManager base constructor resolves the model directory via
  // path_provider, which needs the Flutter binding (and a mock channel — plain
  // tests have no plugin implementation) even for non-widget tests.
  TestWidgetsFlutterBinding.ensureInitialized();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => '/tmp',
      );

  test('text-mode turn streams full context, skips TTS, persists both sides',
      () async {
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Hello'],
      ],
      results: const [
        ChatResult(content: 'Hello', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final tts = FakeTtsEngine();
    final container = _container(chatClient: chat, store: store, tts: tts);
    final playback =
        container.read(audioPlaybackServiceProvider) as FakeAudioPlayback;
    final controller = container.read(voiceControllerProvider);
    final conversationId = container.read(activeConversationIdProvider)!;
    final deviceEmissions = <String>[];
    controller.stateStream.listen((s) {
      final text = s.onDeviceTranscript;
      if (text != null) deviceEmissions.add(text);
    });

    await controller.startConversation();
    await controller.sendText('hello', speakReply: false);
    await settle();

    // The full message list (history + new user message) is sent.
    expect(chat.calls, hasLength(1));
    expect(chat.calls.single.map((m) => m.role).toList(), ['user']);
    expect(chat.calls.single.single.content, 'hello');

    // speakReply: false must skip on-device TTS entirely.
    expect(tts.synthesized, isEmpty);
    expect(playback.playedChunks, isEmpty);

    // The user's utterance surfaced via the on-device transcript slot.
    expect(deviceEmissions, ['hello']);
    expect(controller.state.lastReply, 'Hello');

    // User + assistant messages persisted (row created on the first turn).
    final conv = await store.loadConversation(conversationId);
    expect(conv, isNotNull);
    expect(conv!.title, 'hello');
    expect(
      conv.messages.map((m) => m.role).toList(),
      [MessageRole.user, MessageRole.assistant],
    );
    expect(conv.messages[0].content, 'hello');
    expect(conv.messages[1].content, 'Hello');
  });

  test('second turn includes the first turn in the request (context continuity)',
      () async {
    final chat = FakeChatClient(
      streamDeltas: const [
        ['A'],
        ['B'],
      ],
      results: const [
        ChatResult(content: 'A', toolCalls: [], finishReason: 'stop'),
        ChatResult(content: 'B', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final container = _container(chatClient: chat, store: store);
    final controller = container.read(voiceControllerProvider);
    final conversationId = container.read(activeConversationIdProvider)!;

    await controller.startConversation();
    await controller.sendText('first', speakReply: false);
    await settle();
    await controller.sendText('second', speakReply: false);
    await settle();

    expect(chat.calls, hasLength(2));
    // Turn 1: fresh conversation, so just the user message.
    expect(chat.calls[0].map((m) => m.role).toList(), ['user']);
    expect(chat.calls[0].single.content, 'first');
    // Turn 2: the first turn's user + assistant messages precede the new one
    // (whether the new user message was already persisted into the history or
    // appended at request-build time — the request must contain it exactly
    // once).
    expect(
      chat.calls[1].map((m) => m.role).toList(),
      ['user', 'assistant', 'user'],
    );
    expect(chat.calls[1][0].content, 'first');
    expect(chat.calls[1][1].content, 'A');
    expect(chat.calls[1][2].content, 'second');

    final conv = await store.loadConversation(conversationId);
    expect(conv!.messages, hasLength(4));
  });

  test('first-turn row creation titles the conversation from the user text',
      () async {
    final chat = FakeChatClient(
      results: const [
        ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final container = _container(chatClient: chat, store: store);
    final controller = container.read(voiceControllerProvider);
    final conversationId = container.read(activeConversationIdProvider)!;

    await controller.startConversation();
    await controller.sendText('First message here', speakReply: false);
    await settle();

    final conv = await store.loadConversation(conversationId);
    expect(conv, isNotNull);
    expect(conv!.title, 'First message here');
    expect(conv.messages, hasLength(2));
  });

  test('voice turn (STT flush) persists the user message exactly once',
      () async {
    final chat = FakeChatClient(
      results: const [
        ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final stt = FakeSttEngine(transcript: 'hello world');
    final tts = FakeTtsEngine();
    final container = _container(
      chatClient: chat,
      store: store,
      stt: stt,
      tts: tts,
    );
    final mic =
        container.read(micCaptureServiceProvider) as FakeMicCaptureService;
    final controller = container.read(voiceControllerProvider);
    final conversationId = container.read(activeConversationIdProvider)!;

    await controller.startConversation();
    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();
    await controller.flushTranscriptionBuffer();
    await settle();

    // The utterance travels flush → sendText, but persistence goes through
    // onUserMessage ONLY: exactly one user row, no duplicates.
    final conv = await store.loadConversation(conversationId);
    expect(conv, isNotNull);
    expect(
      conv!.messages.where((m) => m.role == MessageRole.user),
      hasLength(1),
    );
    expect(conv.messages.first.content, 'hello world');
  });

  test('mid-turn conversation switch still persists the reply to the '
      'turn\'s conversation', () async {
    final chat = FakeChatClient(
      streamDeltas: const [
        ['Reply'],
      ],
      results: const [
        ChatResult(content: 'Reply', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final container = _container(chatClient: chat, store: store);
    final controller = container.read(voiceControllerProvider);
    final turnConversationId = container.read(activeConversationIdProvider)!;

    await controller.startConversation();
    // Turn starts: onUserMessage captures the conversation id synchronously.
    final send = controller.sendText('hello', speakReply: false);
    await pumpEventQueue();

    // Switch the active conversation mid-stream to a brand-new id (no row).
    container.read(activeConversationIdProvider.notifier).set('switched-away');
    await send;
    await settle();

    // The reply followed the user message into the ORIGINAL conversation, not
    // the switched-to one — and no FK throw silently drops it.
    final original = await store.loadConversation(turnConversationId);
    expect(original, isNotNull);
    expect(
      original!.messages.map((m) => m.role).toList(),
      [MessageRole.user, MessageRole.assistant],
    );
    expect(original.messages[0].content, 'hello');
    expect(original.messages[1].content, 'Reply');
    expect(await store.loadConversation('switched-away'), isNull);
  });

  test('speakReply defaults to true and still synthesizes + plays', () async {
    final chat = FakeChatClient(
      results: const [
        ChatResult(content: 'hi there', toolCalls: [], finishReason: 'stop'),
      ],
    );
    final store = FakeChatStore();
    final tts = FakeTtsEngine();
    final container = _container(chatClient: chat, store: store, tts: tts);
    final playback =
        container.read(audioPlaybackServiceProvider) as FakeAudioPlayback;
    final controller = container.read(voiceControllerProvider);

    await controller.startConversation();
    await controller.sendText('hello');
    await settle();

    expect(tts.synthesized, ['hi there']);
    expect(playback.playedChunks, isNotEmpty);
    expect(controller.state.lastReply, 'hi there');
  });
}