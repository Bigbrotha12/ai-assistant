import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/data/status_tracker.dart'
    show networkErrorPhrases, pendingErrorPhrases;
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/vision/data/vision_client.dart';
import 'package:ai_assistant/features/vision/data/vision_provider.dart';

import '../../fakes.dart';
import '../plugins/data/managed_conversation_service_test.dart'
    show FakeAdapter, FakeScheduler, backgroundTaskJson, jsonResponse, testPoller, waitFor;

Conversation _existingConversation({List<Message> messages = const []}) =>
    Conversation(
      id: 'c1',
      title: 'existing',
      messages: messages,
      createdAt: DateTime(2024, 1, 1),
      updatedAt: DateTime(2024, 1, 1),
    );

/// Container wired for the managed cutover: store + scripted client shared
/// with a [FakeManagedChatAdapter] that records sends and drives persistence.
({
  ProviderContainer container,
  FakeChatStore store,
  FakeManagedChatAdapter adapter,
})
_container({
  FakeChatStore? store,
  FakeChatClient? client,
  FakeManagedChatAdapter? adapter,
  FakeFilesClient? filesService,
  FakeFileStore? fileStore,
  List<Override> extraOverrides = const [],
}) {
  final s = store ?? FakeChatStore();
  final c = client ?? FakeChatClient();
  final a = adapter ?? FakeManagedChatAdapter(store: s, script: c);
  final container = ProviderContainer(
    overrides: [
      chatStoreProvider.overrideWithValue(s),
      filesServiceProvider.overrideWithValue(filesService ?? FakeFilesClient()),
      filesStoreProvider.overrideWithValue(fileStore ?? FakeFileStore()),
      managedChatAdapterProvider.overrideWithValue(a),
      ...extraOverrides,
    ],
  );
  addTearDown(container.dispose);
  return (container: container, store: s, adapter: a);
}

void _keepAlive(ProviderContainer container, String id) {
  container.listen<AsyncValue<ConversationState>>(
    conversationProvider(id),
    (_, _) {},
  );
}

/// Drains the upload microtask pipeline (mirrors chat_providers_test).
Future<void> _settle() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

/// Scripted [VisionClient] for the describe-before-send test.
class _FakeVisionClient implements VisionClient {
  const _FakeVisionClient(this.description);

  final String description;

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async =>
      description;
}

/// Notifier override that skips the real build (VRAM gate / gateway probe /
/// voice settings) and hands [visionClientProvider] the scripted client.
class _FakeVisionNotifier extends VisionClientNotifier {
  _FakeVisionNotifier(this.client);

  final VisionClient client;

  @override
  Future<VisionClient> build() async => client;
}

void main() {
  group('ConversationNotifier managed cutover (P1a)', () {
    test(
        'a send admits exactly one user row and sendTurn history excludes the '
        'trailing user message', () async {
      final store = FakeChatStore(initial: [
        _existingConversation(messages: const [
          Message(
            id: 'u0',
            role: MessageRole.user,
            content: 'earlier',
            createdAt: null,
          ),
          Message(
            id: 'a0',
            role: MessageRole.assistant,
            content: 'earlier reply',
            createdAt: null,
          ),
        ]),
      ]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'Reply', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi');

      expect(adapter.sends, hasLength(1));
      final send = adapter.sends.single;
      expect(send.userText, 'Hi');
      expect(send.history.map((m) => m.content), ['earlier', 'earlier reply']);
      expect(
        send.history.where(
          (m) => m.role == MessageRole.user && m.content == 'Hi',
        ),
        isEmpty,
      );

      final conv = await wired.store.loadConversation('c1');
      expect(
        conv!.messages.where(
          (m) => m.role == MessageRole.user && m.content == 'Hi',
        ),
        hasLength(1),
      );
      expect(conv.messages, hasLength(4));
      expect(conv.messages.last.content, 'Reply');
    });

    test(
        'onContent coalesces into the in-memory placeholder while the turn is '
        'still streaming', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(
            content: 'Hello world',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ],
        streamDeltas: const [
          ['Hello', ' world'],
        ],
      );
      final hang = Completer<ChatResult>();
      client.hang = hang;
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final send = notifier.sendMessage('Hi');
      // Deltas have arrived but the 80ms coalescing throttle has not flushed.
      await Future<void>.delayed(Duration.zero);
      var state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isTrue);
      expect(state.messages.last.role, MessageRole.assistant);
      expect(state.messages.last.content, '');
      // Service-owned writes: no assistant row mid-stream.
      final mid = await wired.store.loadConversation('c1');
      expect(mid!.messages, hasLength(1));
      expect(mid.messages.single.role, MessageRole.user);

      // Throttle flush lands in state while the turn is still streaming.
      await Future<void>.delayed(const Duration(milliseconds: 120));
      state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isTrue);
      expect(state.messages.last.content, 'Hello world');

      hang.complete(
        const ChatResult(
          content: 'Hello world',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull);
      final conv = await wired.store.loadConversation('c1');
      expect(conv!.messages, hasLength(2));
      expect(conv.messages.last.content, 'Hello world');
      expect(adapter.sends, hasLength(1));
    });

    test(
        'alreadyCompleted reconciles server history without duplicating the '
        'admitted user row', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final scripted = FakeManagedChatAdapter(store: store, script: client)
        ..alreadyCompleted = true
        ..serverHistory = const [
          Message(
            id: 's1',
            role: MessageRole.user,
            content: 'Hi',
            createdAt: null,
          ),
          Message(
            id: 's2',
            role: MessageRole.assistant,
            content: 'Server reply',
            createdAt: null,
          ),
        ];
      final wired = _container(
        store: store,
        client: client,
        adapter: scripted,
      );
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi');

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull);
      expect(state.failedMessageId, isNull);
      expect(state.messages, hasLength(2));
      expect(state.messages.last.content, 'Server reply');
      // The service already reconciled inside sendTurn (mirrored by the fake
      // writing serverHistory to the store); the notifier must NOT run a
      // second loadSession + replaceHistory round-trip (M5).
      expect(scripted.reconcileCalls, 0);
      // alreadyCompleted skips admission/persist in the fake — reconcile
      // replaces the store with the scripted server history (no extra rows).
      expect(scripted.sends, hasLength(1));
      final conv = await wired.store.loadConversation('c1');
      expect(conv!.messages, hasLength(2));
      expect(
        conv.messages.where((m) => m.role == MessageRole.user),
        hasLength(1),
      );
      expect(conv.messages.last.content, 'Server reply');
    });

    test(
        'an admission failure surfaces as state.error without throwing and '
        'without admitting a user row', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final scripted = FakeManagedChatAdapter(store: store, script: client)
        ..admissionError = const ManagedTurnError('network_error');
      final wired = _container(
        store: store,
        client: client,
        adapter: scripted,
      );
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await expectLater(notifier.sendMessage('Hi'), completes);

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, anyOf(networkErrorPhrases));
      expect(state.failedMessageId, isNotNull);
      expect(state.pendingUserMessageId, isNull);
      expect(scripted.sends, hasLength(1));
      // Pre-admission throw: nothing was written to the store.
      final conv = await wired.store.loadConversation('c1');
      expect(conv!.messages, isEmpty);
    });

    test(
        'a hanging turn leaves only the user row in the store mid-stream and '
        'the full pair after completion', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'done', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final hang = Completer<ChatResult>();
      client.hang = hang;
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final send = notifier.sendMessage('Hi');
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(conversationProvider('c1')).value!.isStreaming,
        isTrue,
      );

      final mid = await wired.store.loadConversation('c1');
      expect(mid!.messages, hasLength(1));
      expect(mid.messages.single.role, MessageRole.user);
      expect(mid.messages.single.content, 'Hi');

      hang.complete(
        const ChatResult(content: 'done', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.messages, hasLength(2));
      expect(state.messages.last.content, 'done');
      final done = await wired.store.loadConversation('c1');
      expect(done!.messages, hasLength(2));
      expect(done.messages.first.role, MessageRole.user);
      expect(done.messages.last.role, MessageRole.assistant);
      expect(done.messages.last.content, 'done');
      expect(adapter.sends, hasLength(1));
    });
  });

  group('service-minted user id (P1b)', () {
    const attachmentDraft = AttachmentDraft(
      path: '/tmp/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 100,
      mimeType: 'image/jpeg',
    );

    test(
        'a completed upload appends [file:] to the SERVICE-minted user row — '
        'exactly one store row, every user-role update uses the service id',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'Here you go', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final files = FakeFilesClient();
      final fileStore = FakeFileStore();
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
        filesService: files,
        fileStore: fileStore,
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Check this', attachments: const [
        attachmentDraft,
      ]);
      await _settle();

      final admitted = adapter.lastAdmittedUserMessageId;
      expect(admitted, isNotNull);
      final conv = await wired.store.loadConversation('c1');
      final userRows = conv!.messages
          .where((m) => m.role == MessageRole.user)
          .where((m) => m.content.startsWith('Check this'))
          .toList();
      expect(userRows, hasLength(1),
          reason: 'the optimistic in-memory UUID must never insert a second '
              'user row — the ref lands on the service-admitted row');
      final row = userRows.single;
      expect(row.id, admitted);
      expect(row.content, 'Check this [file:server-1]');

      // Every user-role store write went through the service id (the
      // optimistic id is never persisted).
      final userUpdates = wired.store.updatedMessages
          .where((m) => m.role == MessageRole.user)
          .toList();
      expect(userUpdates, isNotEmpty,
          reason: 'the completed upload persists the [file:] ref');
      for (final m in userUpdates) {
        expect(m.id, admitted);
      }
      expect(fileStore.saved, hasLength(1));
      expect(fileStore.saved.single.id, 'server-1');
    });

    test(
        'a post-admission dispatch failure still uploads onto the admitted '
        'row — no optimistic-id duplicate, error surfaces without throwing',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient()
        ..error = const PluginClientException('network_error');
      final files = FakeFilesClient();
      final fileStore = FakeFileStore();
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
        filesService: files,
        fileStore: fileStore,
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      // A *chat* error does not throw out of sendMessage: the message was
      // persisted, so attachments still enqueue (retained-selection retry
      // contract is about unexpected throws only).
      await notifier.sendMessage('Hi there', attachments: const [
        attachmentDraft,
      ]);
      await _settle();

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, anyOf(networkErrorPhrases));

      final admitted = adapter.lastAdmittedUserMessageId;
      expect(admitted, isNotNull,
          reason: 'the failed dispatch was post-admission');
      final conv = await wired.store.loadConversation('c1');
      final userRows = conv!.messages
          .where((m) => m.role == MessageRole.user)
          .where((m) => m.content.startsWith('Hi there'))
          .toList();
      expect(userRows, hasLength(1),
          reason: 'updateMessage(optimisticId) would insert a duplicate — '
              'the catch-path adoption must re-key first');
      expect(userRows.single.id, admitted);
      expect(userRows.single.content, 'Hi there [file:server-1]');
      expect(
        state.messages.where((m) => m.role == MessageRole.user),
        hasLength(1),
      );
      for (final m in wired.store.updatedMessages
          .where((m) => m.role == MessageRole.user)) {
        expect(m.id, admitted);
      }
    });

    test(
        'a PRE-admission rejection (pending_turn_exists) does not enqueue '
        'attachments — the optimistic-id fallback would insert a phantom '
        'duplicate user row', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final files = FakeFilesClient();
      final fileStore = FakeFileStore();
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client)
          ..admissionError = const PluginClientException('pending_turn_exists'),
        filesService: files,
        fileStore: fileStore,
      );
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi there', attachments: const [
        attachmentDraft,
      ]);
      await _settle();

      expect(files.uploadCalls, isEmpty,
          reason: 'admission never ran — an upload keyed to the optimistic id '
              'would insertOnConflictUpdate a phantom user row');
      final conv = await wired.store.loadConversation('c1');
      expect(
        conv!.messages.where(
          (m) => m.role == MessageRole.user && m.content.startsWith('Hi there'),
        ),
        isEmpty,
        reason: 'no phantom user row may land in the store');
      final state = container.read(conversationProvider('c1')).value!;
      expect(state.error, isNotNull);
    });

    test(
        'vision descriptions are injected into the admitted text BEFORE '
        'dispatch (describe-before-send) and no post-send user-role '
        'updateMessage is written', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      // Hold the upload in-flight so the only potential user-row write after
      // admission would be a (wrong) describe persistence — there must be none.
      final holdUpload = Completer<FileInfo>();
      final files = FakeFilesClient(uploadCompleter: holdUpload);
      final fileStore = FakeFileStore();
      final tempDir = Directory.systemTemp.createTempSync('p1b-vision');
      addTearDown(() => tempDir.deleteSync(recursive: true));
      final image = File('${tempDir.path}/photo.png')
        ..writeAsBytesSync([1, 2, 3]);

      const description = 'a red bicycle beside a brick wall';
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(store: store, script: client),
        filesService: files,
        fileStore: fileStore,
        extraOverrides: [
          visionEnabledProvider.overrideWithValue(true),
          visionClientProvider.overrideWith(
            () => _FakeVisionNotifier(const _FakeVisionClient(description)),
          ),
        ],
      );
      final container = wired.container;
      final adapter = wired.adapter;
      _keepAlive(container, 'c1');
      // Prime the AsyncNotifier so _describeDrafts sees AsyncData (a cold
      // AsyncLoading would fall back to NoOpVisionClient and fail open).
      await container.read(visionClientProvider.future);
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Look at this', attachments: [
        AttachmentDraft(
          path: image.path,
          filename: 'photo.png',
          sizeBytes: 3,
          mimeType: 'image/png',
        ),
      ]);

      // Describe ran BEFORE sendTurn: the admitted userText is expanded.
      expect(adapter.sends, hasLength(1));
      expect(adapter.sends.single.userText, contains(description));

      final admitted = adapter.lastAdmittedUserMessageId;
      expect(admitted, isNotNull);
      final conv = await wired.store.loadConversation('c1');
      final userRow = conv!.messages.firstWhere(
        (m) => m.role == MessageRole.user,
      );
      expect(userRow.id, admitted);
      expect(userRow.content, contains(description));

      // The upload is held: the only store update is the service's own
      // assistant write. Vision never persists the description as a
      // post-send user-row update.
      expect(
        wired.store.updatedMessages.where((m) => m.role == MessageRole.user),
        isEmpty,
        reason: 'descriptions live in the in-memory text that admission '
            'persists as userText — no post-send user updateMessage');
      expect(files.uploadCalls, hasLength(1),
          reason: 'attachments still enqueue after the turn');
    });
  });

  group('P3 background jobs (chip + open-conversation watch)', () {
    final scope = AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gw.test',
      ownerId: 'owner-a',
    )!;

    test(
        'submitBackgroundJob marks a pending chip; the poll-completed reply '
        'auto-renders via the store watch without a manual reload', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final clock = FakeScheduler();
      final ledgerAdapter = FakeAdapter((request) {
        if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
          final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
          return jsonResponse({
            ...backgroundTaskJson(
              status: 'succeeded',
              messageId: byKey,
              taskId: 'task-1',
            ),
            'steps': [
              {
                'stage': 'reply',
                'action': 'assistant_message',
                'result': 'bg reply',
              },
            ],
          });
        }
        throw StateError('unexpected ledger path ${request.uri.path}');
      });
      final poller = testPoller(scope, ledgerAdapter, clock);
      addTearDown(poller.dispose);
      final wired = _container(
        store: store,
        client: client,
        adapter: FakeManagedChatAdapter(
          store: store,
          script: client,
          poller: poller,
        ),
      );
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.submitBackgroundJob('Hi');

      var state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isTrue);
      expect(state.isStreaming, isFalse);
      expect(state.messages.last.role, MessageRole.user);
      expect(state.messages.last.content, 'Hi');

      // Foreground lifecycle arms the poller; the terminal poll appends the
      // reply to the store.
      poller.setForeground(true);
      await clock.advance(const Duration(seconds: 1));

      await waitFor(() async {
        final cur = container.read(conversationProvider('c1')).value;
        return cur != null && !cur.hasPendingJob;
      });
      state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isFalse);
      expect(state.jobError, isNull);
      expect(state.messages.last.role, MessageRole.assistant);
      expect(state.messages.last.content, 'bg reply');
      expect(state.messages, hasLength(2));
    });

    test(
        'retryBackgroundJob replays the pending job; cancelBackgroundJob '
        'clears the chip and the pending row', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final clock = FakeScheduler();
      final ledgerAdapter = FakeAdapter((request) {
        if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
          final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
          return jsonResponse(backgroundTaskJson(
            status: 'queued',
            messageId: byKey,
            taskId: 'task-1',
          ));
        }
        throw StateError('unexpected ledger path ${request.uri.path}');
      });
      final poller = testPoller(scope, ledgerAdapter, clock);
      addTearDown(poller.dispose);
      final fake = FakeManagedChatAdapter(
        store: store,
        script: client,
        poller: poller,
      );
      final wired = _container(store: store, client: client, adapter: fake);
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.submitBackgroundJob('Hi');
      expect(
        container.read(conversationProvider('c1')).value!.hasPendingJob,
        isTrue,
      );
      expect(fake.backgroundSubmits, hasLength(1));

      // A still-pending job (queued, never foregrounded) replays via retryTurn
      // with the same messageId and re-watches.
      await notifier.retryBackgroundJob();
      expect(fake.retries, ['c1']);
      expect(fake.retryMessageIds, hasLength(1));
      expect(
        container.read(conversationProvider('c1')).value!.hasPendingJob,
        isTrue,
      );

      // Cancel clears the pending row and drops the chip.
      await notifier.cancelBackgroundJob();
      expect(fake.abandons, hasLength(1));
      final state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isFalse);
      expect(state.jobError, isNull);
    });

    test(
        'a text send while a background job is pending does NOT abandon the '
        'job — the chip stays, the reply still appends on completion', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final clock = FakeScheduler();
      final ledgerAdapter = FakeAdapter((request) {
        if (request.uri.path.startsWith('/ledger/tasks/by-key/')) {
          final byKey = Uri.decodeComponent(request.uri.pathSegments.last);
          return jsonResponse({
            ...backgroundTaskJson(
              status: 'succeeded',
              messageId: byKey,
              taskId: 'task-1',
            ),
            'steps': [
              {
                'stage': 'reply',
                'action': 'assistant_message',
                'result': 'bg reply',
              },
            ],
          });
        }
        throw StateError('unexpected ledger path ${request.uri.path}');
      });
      final poller = testPoller(scope, ledgerAdapter, clock);
      addTearDown(poller.dispose);
      final fake = FakeManagedChatAdapter(
        store: store,
        script: client,
        poller: poller,
      );
      final wired = _container(store: store, client: client, adapter: fake);
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      // Submit the background job; the chip comes up.
      await notifier.submitBackgroundJob('Hi');
      expect(
        container.read(conversationProvider('c1')).value!.hasPendingJob,
        isTrue,
      );

      // A text send while the job is pending surfaces pending_turn_exists: the
      // escape-hatch abandon must NOT destroy the running job (no abandon
      // recorded), the chip stays, and the error tells the user to wait rather
      // than claiming the reply was stopped.
      await notifier.sendMessage('interrupt text');
      expect(fake.abandons, isEmpty,
          reason: 'abandoning would clear the running job and lose its reply');
      var state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isTrue);
      expect(
        state.error,
        'A background job is still running — wait for it to finish.',
      );
      expect(
        state.messages.where((m) => m.content == 'interrupt text'),
        isEmpty,
        reason: 'the never-admitted optimistic text row is dropped',
      );

      // The job still completes: its reply is appended and the chip clears.
      poller.setForeground(true);
      await clock.advance(const Duration(seconds: 1));
      await waitFor(() async {
        final cur = container.read(conversationProvider('c1')).value;
        return cur != null && !cur.hasPendingJob;
      });
      state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isFalse);
      expect(state.jobError, isNull);
      expect(state.error, isNull);
      expect(state.messages.last.role, MessageRole.assistant);
      expect(state.messages.last.content, 'bg reply');
    });

    test(
        'a background submit rejected with pending_turn_exists keeps the chip '
        '(a job is genuinely pending) and drops the never-admitted optimistic '
        'row', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final fake = FakeManagedChatAdapter(
        store: store,
        script: client,
        poller: testPoller(
          scope,
          FakeAdapter((request) => jsonResponse(backgroundTaskJson(
                status: 'queued',
                messageId: 'job-1',
                taskId: 'task-1',
              ))),
          FakeScheduler(),
        ),
      );
      addTearDown(fake.poller.dispose);
      final wired = _container(store: store, client: client, adapter: fake);
      final container = wired.container;
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      // A background job is running, but the chip is off (the submit went
      // through the ADAPTER, e.g. a stale rebuilt notifier or a rewatch gap).
      await fake.submitBackground('c1', history: const [], userText: 'job');
      expect(
        container.read(conversationProvider('c1')).value!.hasPendingJob,
        isFalse,
      );

      // A second background submit is rejected; the chip must come up (the
      // pending envelope is a genuine background job) and the phantom
      // optimistic row must be dropped.
      await notifier.submitBackgroundJob('second');
      final state = container.read(conversationProvider('c1')).value!;
      expect(state.hasPendingJob, isTrue);
      expect(state.error, anyOf(pendingErrorPhrases));
      expect(
        state.messages.where((m) => m.content == 'second'),
        isEmpty,
        reason: 'the never-admitted optimistic row must not pollute history',
      );
    });
  });
}
