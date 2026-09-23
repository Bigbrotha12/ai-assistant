import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/context_trimmer.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/ui/active_conversation_provider.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_dto.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/staged_inference_adapters.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/screen_wake_lock.dart';
import 'package:ai_assistant/features/voice/data/stt_engine.dart';
import 'package:ai_assistant/features/voice/data/tts_engine.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';
import 'package:drift/native.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;
import '../plugins/data/managed_conversation_service_test.dart'
    show FakeLangChainClient;
import 'voice_test_fakes.dart';

/// Exercise the P2 single-writer contract for voice persistence:
///
/// Group 1 (scripted sender, negative single-writer): the controller NO LONGER
/// writes rows. A scripted sender with no scoped store leaves the store
/// untouched after a full turn — persistence is entirely service-owned.
/// Context continuity is asserted through the request the scripted sender
/// receives, built from a pre-seeded store.
///
/// Group 2 (real managed path): the production [voiceTurnSenderProvider] over
/// the staged adapters (in-memory Drift) — exactly one user + one assistant
/// row per turn, written by the service under the captured conversation id.
class _EngineAwareManager extends FakeEngineManager {
  _EngineAwareManager({this.stt, this.tts});

  final FakeSttEngine? stt;
  final FakeTtsEngine? tts;

  @override
  SttEngine? get sttEngine => stt;

  @override
  TtsEngine? get ttsEngine => tts;
}

/// Scripted-sender container: controller talks to the scripted [FakeChatClient]
/// through [voiceTurnSenderProvider]; the store is a plain [FakeChatStore]
/// that the controller never writes to.
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
        return chatClient.sendTurn(
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

PluginModelDto _model(String id) => PluginModelDto.fromJson({
  'id': id,
  'object': 'model',
  'created': 0,
  'owned_by': 'test',
  'defaultModel': '$id/upstream',
  'tokenLimit': 4096,
  'visionCapable': false,
  'supportsStreaming': true,
  'parameters': <String, dynamic>{},
});

/// Real managed-path container: the production [voiceTurnSenderProvider]
/// routes through a staged adapter built over an in-memory Drift DB, and
/// [chatStoreProvider] is overridden with the SAME scoped
/// [DriftChatStore(db, scopeKey: scope.storageId)] tenant the service writes,
/// so post-turn reads unify with service-owned rows.
class _ManagedHarness {
  _ManagedHarness(this.container, this.db, this.store, this.adapters);

  final ProviderContainer container;
  final AppDatabase db;
  final DriftChatStore store;
  final StagedInferenceAdapters adapters;
}

_ManagedHarness _managedContainer({
  required FakeLangChainClient client,
  FakeSttEngine? stt,
  FakeTtsEngine? tts,
}) {
  final db = AppDatabase(NativeDatabase.memory());
  final repo = ManagedConversationRepository(db);
  final storage = InMemorySecureStorage();
  final plugins = PluginCredentialsStore(storage: storage);
  final auth = SecureAuthCredentialsStore(storage: storage);
  final scope = AuthAccountScope.fromIdentity(
    backendOrigin: 'https://gateway.test',
    ownerId: 'alice',
  )!;
  final lifecycle = AccountLifecycle();
  final adapters = createStagedInferenceAdapters(
    client: client,
    repository: repo,
    scope: scope,
    trimmer: const ContextTrimmer(),
    currentScope: () => scope,
    authStore: auth,
    pluginStore: plugins,
    loadModels: ({required gatewayKey, cancelToken}) async => [_model('text')],
    lifecycle: lifecycle,
  );
  final store = DriftChatStore(db, scopeKey: scope.storageId);
  final container = ProviderContainer(
    overrides: [
      engineManagerProvider.overrideWithValue(
        _EngineAwareManager(stt: stt, tts: tts),
      ),
      micCaptureServiceProvider.overrideWithValue(FakeMicCaptureService()),
      audioPlaybackServiceProvider.overrideWithValue(FakeAudioPlayback()),
      audioSessionManagerProvider.overrideWithValue(FakeAudioSessionManager()),
      screenWakeLockProvider.overrideWithValue(NoopScreenWakeLock()),
      stagedInferenceAdaptersProvider.overrideWithValue(adapters),
      chatStoreProvider.overrideWithValue(store),
    ],
  );
  // Seed the account + plugin configuration so resolveManagedSelection
  // succeeds: gateway key, selected model, model credentials.
  auth.save(
    const AuthCredentials(
      apiKey: 'gateway-test',
      backendOrigin: 'https://gateway.test',
      ownerId: 'alice',
    ),
  );
  plugins.setSelectedModel(scope, 'text');
  plugins.setCredentials(scope, 'text', {'apiKey': 'text-test'});
  addTearDown(() async {
    container.dispose();
    adapters.dispose();
    lifecycle.dispose();
    await db.close();
  });
  return _ManagedHarness(container, db, store, adapters);
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

  group('scripted sender — negative single-writer', () {
    test(
      'text-mode turn streams full context, skips TTS, writes NO rows',
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

        // Single-writer: the controller writes NOTHING — no row is created.
        expect(await store.loadConversation(conversationId), isNull);
      },
    );

    test(
      'second turn includes pre-seeded context; the controller adds no rows',
      () async {
        final chat = FakeChatClient(
          results: const [
            ChatResult(content: 'B', toolCalls: [], finishReason: 'stop'),
          ],
        );
        final store = FakeChatStore();
        // Pre-seed the first turn's rows the way the managed service would have
        // written them (user + assistant), so context continuity is observable.
        store.saveConversation(
          Conversation(
            id: 'conv-1',
            title: 'first',
            messages: const [
              Message(
                id: 'u1',
                role: MessageRole.user,
                content: 'first',
                createdAt: null,
              ),
              Message(
                id: 'a1',
                role: MessageRole.assistant,
                content: 'A',
                createdAt: null,
              ),
            ],
            createdAt: DateTime(2026),
            updatedAt: DateTime(2026),
          ),
        );
        final container = _container(chatClient: chat, store: store);
        final controller = container.read(voiceControllerProvider);
        final conversationId = container.read(activeConversationIdProvider)!;
        container.read(activeConversationIdProvider.notifier).set('conv-1');

        await controller.startConversation();
        await controller.sendText('second', speakReply: false);
        await settle();

        // Turn 2's request carries the seeded user + assistant rows + the new
        // user message.
        expect(chat.calls, hasLength(1));
        expect(chat.calls.single.map((m) => m.role).toList(), [
          'user',
          'assistant',
          'user',
        ]);
        expect(chat.calls.single[2].content, 'second');

        // The controller added nothing to the store.
        final conv = await store.loadConversation(conversationId);
        expect(conv, isNull);
        final seeded = await store.loadConversation('conv-1');
        expect(seeded!.messages, hasLength(2));
      },
    );

    test(
      'voice turn (STT flush) sends exactly one user message, writes nothing',
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

        // Exactly one user message dispatched; nothing persisted by the
        // controller.
        expect(chat.calls, hasLength(1));
        expect(chat.calls.single.single.content, 'hello world');
        expect(await store.loadConversation(conversationId), isNull);
      },
    );

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
  });

  group('managed path — service-owned exactly-once writes', () {
    test('voice turn persists exactly one user + one assistant row', () async {
      final client = FakeLangChainClient(
        (request) async => ManagedTurnResult(
          sessionId: 's1',
          state: 'seeded',
          result: const ChatResult(
            content: 'Hello',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
      final harness = _managedContainer(client: client);
      final container = harness.container;
      final controller = container.read(voiceControllerProvider);
      final conversationId = container.read(activeConversationIdProvider)!;

      await controller.startConversation();
      await controller.sendText('hello', speakReply: false);
      await settle();

      // The service admitted the user row and completed with the assistant
      // row — exactly once each.
      final conv = await harness.store.loadConversation(conversationId);
      expect(conv, isNotNull);
      expect(conv!.messages.map((m) => m.role).toList(), [
        MessageRole.user,
        MessageRole.assistant,
      ]);
      expect(conv.messages[0].content, 'hello');
      expect(conv.messages[1].content, 'Hello');
    });

    test(
      'second managed turn appends exactly one user + one assistant',
      () async {
        final client = FakeLangChainClient(
          (request) async => ManagedTurnResult(
            sessionId: 's1',
            state: 'seeded',
            result: ChatResult(
              content:
                  request.toJson()['messages'].toString().contains('second')
                  ? 'B'
                  : 'A',
              toolCalls: [],
              finishReason: 'stop',
            ),
          ),
        );
        final harness = _managedContainer(client: client);
        final container = harness.container;
        final controller = container.read(voiceControllerProvider);
        final conversationId = container.read(activeConversationIdProvider)!;

        await controller.startConversation();
        await controller.sendText('first', speakReply: false);
        await settle();
        await controller.sendText('second', speakReply: false);
        await settle();

        // Turn 1 request: fresh conversation, just the user message.
        expect(client.requests, isNotEmpty);
        final conv = await harness.store.loadConversation(conversationId);
        expect(conv!.messages, hasLength(4));
        expect(conv.messages.map((m) => m.role).toList(), [
          MessageRole.user,
          MessageRole.assistant,
          MessageRole.user,
          MessageRole.assistant,
        ]);
        expect(conv.messages.map((m) => m.content).toList(), [
          'first',
          'A',
          'second',
          'B',
        ]);
      },
    );

    test('mid-turn conversation switch still persists to the turn\'s '
        'conversation', () async {
      final client = FakeLangChainClient(
        (request) async => ManagedTurnResult(
          sessionId: 's1',
          state: 'seeded',
          result: const ChatResult(
            content: 'Reply',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ),
      );
      final harness = _managedContainer(client: client);
      final container = harness.container;
      final controller = container.read(voiceControllerProvider);
      final turnConversationId = container.read(activeConversationIdProvider)!;

      await controller.startConversation();
      // Turn starts: onUserMessage captures the conversation id synchronously.
      final send = controller.sendText('hello', speakReply: false);
      await pumpEventQueue();

      // Switch the active conversation mid-stream to a brand-new id (no row).
      container
          .read(activeConversationIdProvider.notifier)
          .set('switched-away');
      await send;
      await settle();

      // The reply followed the user message into the ORIGINAL conversation.
      final original = await harness.store.loadConversation(turnConversationId);
      expect(original, isNotNull);
      expect(original!.messages.map((m) => m.role).toList(), [
        MessageRole.user,
        MessageRole.assistant,
      ]);
      expect(original.messages[0].content, 'hello');
      expect(original.messages[1].content, 'Reply');
      expect(await harness.store.loadConversation('switched-away'), isNull);
    });
  });
}
