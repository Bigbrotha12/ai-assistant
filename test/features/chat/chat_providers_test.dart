import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';

import '../../fakes.dart';

ProviderContainer _container({
  FakeChatStore? store,
  FakeChatClient? client,
  FakeFilesClient? filesService,
  FakeFileStore? fileStore,
}) {
  final container = ProviderContainer(
    overrides: [
      chatStoreProvider.overrideWithValue(store ?? FakeChatStore()),
      chatApiClientProvider.overrideWithValue(client ?? FakeChatClient()),
      filesServiceProvider.overrideWithValue(filesService ?? FakeFilesClient()),
      filesStoreProvider.overrideWithValue(fileStore ?? FakeFileStore()),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

/// Keeps the autoDispose [conversationProvider] alive across awaits. The
/// subscription is torn down when the container is disposed.
void _keepAlive(ProviderContainer container, String id) {
  container.listen<AsyncValue<ConversationState>>(
    conversationProvider(id),
    (_, _) {},
  );
}

/// Drains the upload microtask pipeline. The fake client resolves without
/// timers, so a couple of event-loop turns suffice for uploads to reach their
/// terminal state and for ref-append / FileInfo persistence to complete.
Future<void> _settle() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

Conversation _existingConversation({List<Message> messages = const []}) =>
    Conversation(
      id: 'c1',
      title: 'existing',
      messages: messages,
      createdAt: DateTime(2024, 1, 1),
      updatedAt: DateTime(2024, 1, 1),
    );

void main() {
  group('conversationProvider', () {
    test('initial build loads messages from store', () async {
      final store = FakeChatStore(initial: [
        _existingConversation(messages: [
          const Message(
            id: 'u1',
            role: MessageRole.user,
            content: 'hello',
            createdAt: null,
          ),
          const Message(
            id: 'a1',
            role: MessageRole.assistant,
            content: 'hi there',
            createdAt: null,
          ),
        ]),
      ]);
      final container = _container(store: store);
      _keepAlive(container, 'c1');

      final state = await container.read(conversationProvider('c1').future);

      expect(state.isDbReady, isTrue);
      expect(state.isStreaming, isFalse);
      expect(state.messages, hasLength(2));
      expect(state.messages.first.content, 'hello');
      expect(state.messages.last.content, 'hi there');
    });

    test('sendMessage streams content, persists, and toggles isStreaming',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'Hello there', toolCalls: [], finishReason: 'stop'),
        ],
        streamDeltas: const [
          ['Hello', ' there'],
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi');

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull);
      expect(state.pendingUserMessageId, isNull);
      expect(state.messages, hasLength(2));
      expect(state.messages[0].content, 'Hi');
      expect(state.messages.last.content, 'Hello there');

      final persisted = await store.loadConversation('c1');
      expect(persisted!.messages, hasLength(2));
      expect(persisted.messages.last.content, 'Hello there');
      expect(client.lastSystemPrompt, kSystemPrompt);
      expect(client.lastTools, isNotEmpty);
    });

    test('tool-call loop executes tool, feeds result back, then stops',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: [
          const ChatResult(
            content: '',
            toolCalls: [
              ToolCall(id: 'call_1', name: 'voices', args: {}),
            ],
            finishReason: 'tool_calls',
          ),
          const ChatResult(content: 'Done', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Call the tool');

      expect(client.callCount, 2);

      // First call: only the user message (the assistant placeholder is a UI
      // artifact, not part of the request history).
      expect(client.calls[0].map((m) => m.role).toList(), ['user']);

      // Second call must include the assistant tool_calls + tool result from
      // the first round.
      final second = client.calls[1];
      final roles = second.map((m) => m.role).toList();
      expect(roles, ['user', 'assistant', 'tool']);
      expect(second[1].toolCalls, isNotEmpty);
      final toolMsg = second.firstWhere((m) => m.role == 'tool');
      expect(toolMsg.toolCallId, 'call_1');
      expect(toolMsg.content, contains('voices tool'));

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull);
      expect(
        state.messages.where((m) => m.role == MessageRole.tool),
        hasLength(1),
      );
      expect(state.messages.last.content, 'Done');
    });

    test('tool loop capped after 5 iterations', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: [
          for (var i = 0; i < 5; i++)
            ChatResult(
              content: '',
              toolCalls: [
                ToolCall(id: 'call_$i', name: 'voices', args: {}),
              ],
              finishReason: 'tool_calls',
            ),
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Loop');

      expect(client.callCount, 5);
      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.messages.last.content, 'Reached the tool-call limit');
    });

    test('error path keeps partial content and sets failedMessageId', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        error: const ChatNetworkError('boom'),
        results: const [
          ChatResult(content: 'partial ', toolCalls: [], finishReason: 'stop'),
        ],
        streamDeltas: const [
          ['partial '],
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi');

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, 'boom');
      expect(state.failedMessageId, isNotNull);
      expect(state.pendingUserMessageId, isNull);
      // Partial content retained.
      expect(state.messages.last.content, 'partial ');

      final persisted = await store.loadConversation('c1');
      expect(persisted!.messages.last.content, 'partial ');
    });

    test('retry removes failed placeholder and re-sends', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'Recovered', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      // First send errors.
      client.error = const ChatNetworkError('boom');
      await notifier.sendMessage('Hi');
      final failedId =
          container.read(conversationProvider('c1')).value!.failedMessageId;
      expect(failedId, isNotNull);

      // Now succeed on retry.
      client.error = null;
      await notifier.retry();

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.error, isNull);
      expect(state.failedMessageId, isNull);
      expect(state.isStreaming, isFalse);
      // The failed placeholder is gone; a fresh assistant message replaced it.
      expect(
        state.messages.where((m) => m.id == failedId),
        isEmpty,
      );
      expect(state.messages.last.content, 'Recovered');
      expect(state.messages.first.content, 'Hi');

      // The failed placeholder must also be gone from the store: after retry
      // drift contains [user, successfulAssistant], not
      // [user, failedAssistant(partial), successfulAssistant].
      final persisted = await store.loadConversation('c1');
      expect(persisted!.messages.where((m) => m.id == failedId), isEmpty);
      expect(persisted.messages.last.content, 'Recovered');
      expect(persisted.messages, hasLength(2));
    });

    test('stop cancels and clears streaming', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(streamDeltas: const [
        ['partial '],
      ]);
      final hang = Completer<ChatResult>();
      client.hang = hang;
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final send = notifier.sendMessage('Hi');
      await Future<void>.delayed(Duration.zero);

      // Still streaming while hung.
      expect(
        container.read(conversationProvider('c1')).value!.isStreaming,
        isTrue,
      );

      await notifier.stop();
      hang.complete(
        const ChatResult(content: 'partial ', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull); // stop is not an error
      expect(state.failedMessageId, isNull);
      // Partial content retained.
      expect(state.messages.last.content, 'partial ');
    });

    test('stop suppresses a cancellation error and keeps flushed partial',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'partial ', toolCalls: [], finishReason: 'stop'),
        ],
        streamDeltas: const [
          ['partial '],
        ],
      );
      final hang = Completer<ChatResult>();
      client.hang = hang;
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final send = notifier.sendMessage('Hi');
      // Let the coalescing throttle flush the streamed partial into state.
      await Future<void>.delayed(const Duration(milliseconds: 120));

      await notifier.stop();
      // The cancellation surfaces as a ChatNetworkError afterwards.
      hang.completeError(const ChatNetworkError('cancelled'));
      await send;

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.error, isNull);
      expect(state.failedMessageId, isNull);
      expect(state.messages.last.content, 'partial ');
    });

    test('stale cancellation from a stopped turn is not attributed to a newer turn',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final hangA = Completer<ChatResult>();
      client.hang = hangA;
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      // Turn A starts and hangs.
      final sendA = notifier.sendMessage('first');
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(conversationProvider('c1')).value!.isStreaming,
        isTrue,
      );

      // User stops turn A; streaming clears so turn B can start.
      await notifier.stop();

      // Turn B runs to completion without any cancellation.
      client.hang = null;
      await notifier.sendMessage('second');

      // Turn A's cancellation error surfaces late, after turn B has finished.
      hangA.completeError(const ChatNetworkError('cancelled'));
      await sendA;

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      // The stale cancellation must not surface as an error banner for turn B.
      expect(state.error, isNull);
      expect(state.failedMessageId, isNull);
      expect(state.messages.last.content, 'ok');
    });

    test('clear resets messages in memory', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);
      await notifier.sendMessage('Hi');

      await notifier.clear();

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.messages, isEmpty);
      // Rows remain in the store (deletion is explicit elsewhere).
      expect(await store.loadConversation('c1'), isNotNull);
    });

    test('disposing mid-stream does not throw', () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient();
      final hang = Completer<ChatResult>();
      client.hang = hang;
      final container = ProviderContainer(
        overrides: [
          chatStoreProvider.overrideWithValue(store),
          chatApiClientProvider.overrideWithValue(client),
          filesServiceProvider.overrideWithValue(FakeFilesClient()),
          filesStoreProvider.overrideWithValue(FakeFileStore()),
        ],
      );
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final send = notifier.sendMessage('Hi');
      await Future<void>.delayed(Duration.zero);

      container.dispose();
      hang.complete(
        const ChatResult(content: 'x', toolCalls: [], finishReason: 'stop'),
      );

      expect(send, completes);
    });

    test('new conversation is titled from the first user message', () async {
      final store = FakeChatStore();
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final container = _container(store: store, client: client);
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('This is my first message here');

      final conv = await store.loadConversation('c1');
      expect(conv, isNotNull);
      expect(conv!.title, 'This is my first message here');
      expect(conv.messages, hasLength(2));
    });

    test('sendMessage enqueues attachments after the turn and tracks progress',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'Here you go', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final upload = Completer<FileInfo>();
      final files = FakeFilesClient(uploadCompleter: upload);
      final fileStore = FakeFileStore();
      final container = _container(
        store: store,
        client: client,
        filesService: files,
        fileStore: fileStore,
      );
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Check this', attachments: const [
        AttachmentDraft(
          path: '/tmp/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 100,
          mimeType: 'image/jpeg',
        ),
      ]);

      // The turn completed before the upload resolved.
      var state = container.read(conversationProvider('c1')).value!;
      expect(state.isStreaming, isFalse);
      expect(state.messages.last.content, 'Here you go');
      expect(files.uploadCalls, hasLength(1));
      expect(files.uploadCalls.single.path, '/tmp/a.jpg');

      // The upload is in-flight: status shows uploading, no ref appended yet.
      final jobId = state.attachmentUploads.keys.single;
      expect(state.attachmentUploads[jobId]!.status, UploadStatus.uploading);
      expect(state.messages.first.content, 'Check this');

      // Completing the upload appends the file ref and persists FileInfo.
      upload.complete(FileInfo(
        id: 'fid-123',
        filename: 'a.jpg',
        sizeBytes: 100,
        mimeType: 'image/jpeg',
        uploadedAt: DateTime(2024, 1, 1),
      ));
      await _settle();

      state = container.read(conversationProvider('c1')).value!;
      final done = state.attachmentUploads[jobId]!;
      expect(done.status, UploadStatus.done);
      expect(done.serverFileId, 'fid-123');
      expect(state.messages.first.content, 'Check this [file:fid-123]');

      final persisted = await store.loadConversation('c1');
      expect(persisted!.messages.first.content, 'Check this [file:fid-123]');

      expect(fileStore.saved, hasLength(1));
      expect(fileStore.saved.single.id, 'fid-123');
      expect(fileStore.saved.single.uploadedAt, isNotNull);
    });

    test('multiple completed uploads append file refs and persist FileInfo',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final files = FakeFilesClient();
      final fileStore = FakeFileStore();
      final container = _container(
        store: store,
        client: client,
        filesService: files,
        fileStore: fileStore,
      );
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Two files', attachments: const [
        AttachmentDraft(
          path: '/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
        AttachmentDraft(
          path: '/b.png',
          filename: 'b.png',
          sizeBytes: 2,
          mimeType: 'image/png',
        ),
      ]);
      await _settle();

      final state = container.read(conversationProvider('c1')).value!;
      final uploads = state.attachmentUploads;
      expect(uploads, hasLength(2));
      expect(
        uploads.values.map((u) => u.status).toSet(),
        {UploadStatus.done},
      );
      expect(
        uploads.values.map((u) => u.serverFileId).toSet(),
        {'server-1', 'server-2'},
      );

      final userContent = state.messages.first.content;
      expect(userContent.startsWith('Two files'), isTrue);
      expect(userContent, contains('[file:server-1]'));
      expect(userContent, contains('[file:server-2]'));

      expect(fileStore.saved, hasLength(2));
    });

    test('failed uploads surface a failed status with error and no file ref',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final files = FakeFilesClient(
        uploadError: const FilesServerError('upload boom'),
      );
      final fileStore = FakeFileStore();
      final container = _container(
        store: store,
        client: client,
        filesService: files,
        fileStore: fileStore,
      );
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Send file', attachments: const [
        AttachmentDraft(
          path: '/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
      ]);
      await _settle();

      final state = container.read(conversationProvider('c1')).value!;
      final status = state.attachmentUploads.values.single;
      expect(status.status, UploadStatus.failed);
      expect(status.error, 'upload boom');
      expect(status.serverFileId, isNull);

      // No ref appended; nothing persisted.
      expect(state.messages.first.content, 'Send file');
      expect(fileStore.saved, isEmpty);
    });

    test('sendMessage without attachments leaves attachmentUploads empty',
        () async {
      final store = FakeChatStore(initial: [_existingConversation()]);
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final files = FakeFilesClient();
      final container = _container(
        store: store,
        client: client,
        filesService: files,
      );
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      await notifier.sendMessage('Hi');

      final state = container.read(conversationProvider('c1')).value!;
      expect(state.attachmentUploads, isEmpty);
      expect(files.uploadCalls, isEmpty);
      expect(state.messages.last.content, 'ok');
    });

    test(
        'a failed turn does not enqueue attachments so a retry uploads '
        'exactly once', () async {
      final store = FakeChatStore(initial: [_existingConversation()])
        ..failUpdateMessage = true;
      final client = FakeChatClient(
        results: const [
          ChatResult(content: 'ok', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final files = FakeFilesClient();
      final fileStore = FakeFileStore();
      final container = _container(
        store: store,
        client: client,
        filesService: files,
        fileStore: fileStore,
      );
      _keepAlive(container, 'c1');
      final notifier = container.read(conversationProvider('c1').notifier);
      await container.read(conversationProvider('c1').future);

      final attachments = const [
        AttachmentDraft(
          path: '/a.jpg',
          filename: 'a.jpg',
          sizeBytes: 1,
          mimeType: 'image/jpeg',
        ),
      ];

      // The turn throws (unexpected store failure mid-stream); the attachments
      // must NOT be enqueued so the UI's retained selection is re-sent once.
      await expectLater(
        notifier.sendMessage('Send file', attachments: attachments),
        throwsA(isA<StateError>()),
      );
      await _settle();
      expect(files.uploadCalls, isEmpty);

      // The user presses Send again after the failure; uploads start exactly
      // once — no duplicate server uploads or duplicated refs.
      store.failUpdateMessage = false;
      await notifier.sendMessage('Send file', attachments: attachments);
      await _settle();

      expect(files.uploadCalls, hasLength(1));
      final state = container.read(conversationProvider('c1')).value!;
      final uploads = state.attachmentUploads.values.toList();
      expect(uploads, hasLength(1));
      expect(uploads.single.status, UploadStatus.done);
      // Exactly one [file:<id>] ref appended to the second user message.
      final userMessages =
          state.messages.where((m) => m.role == MessageRole.user).toList();
      expect(userMessages, hasLength(2));
      expect(userMessages.first.content, 'Send file');
      expect(userMessages.last.content, 'Send file [file:server-1]');
    });
  });

  group('conversationsProvider', () {
    test('emits loaded conversations', () async {
      final store = FakeChatStore(initial: [
        _existingConversation(messages: const [
          Message(id: 'u1', role: MessageRole.user, content: 'a', createdAt: null),
        ]),
        Conversation(
          id: 'c2',
          title: 'Second',
          messages: const [
            Message(
              id: 'u2',
              role: MessageRole.user,
              content: 'b',
              createdAt: null,
            ),
          ],
          createdAt: DateTime(2024, 1, 2),
          updatedAt: DateTime(2024, 1, 2),
        ),
      ]);
      final container = _container(store: store);
      _keepAlive(container, 'c1');

      final sub = container.listen(conversationsProvider, (_, _) {});
      await container.read(conversationsProvider.future);

      final value = container.read(conversationsProvider).value!;
      expect(value, hasLength(2));
      expect(value.first.id, 'c2'); // most recently updated first

      sub.close();
    });
  });
}
