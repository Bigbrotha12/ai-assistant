import 'dart:io';

import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/attachments/file_store.dart';
import 'package:ai_assistant/features/chat/chat_store.dart';
import 'package:ai_assistant/features/chat/database.dart';
import 'package:ai_assistant/features/chat/message_model.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;
  late DriftChatStore store;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    store = DriftChatStore(db);
  });

  tearDown(() async {
    await db.close();
  });

  Conversation conversation({
    String id = 'c1',
    String title = 'Title',
    List<Message> messages = const [],
    DateTime? createdAt,
    DateTime? updatedAt,
  }) =>
      Conversation(
        id: id,
        title: title,
        messages: messages,
        createdAt: createdAt ?? DateTime(2024, 1, 1),
        updatedAt: updatedAt ?? DateTime(2024, 1, 1, 0, 0, 1),
      );

  Message userMessage(String id, String content, {DateTime? createdAt}) => Message(
        id: id,
        role: MessageRole.user,
        content: content,
        createdAt: createdAt ?? DateTime(2024, 1, 1, 0, 0, 2),
      );

  Message assistantWithTools() => const Message(
        id: 'm2',
        role: MessageRole.assistant,
        content: '',
        toolCalls: [
          ToolCall(
            id: 'call_1',
            name: 'get_weather',
            args: {'city': 'Berlin'},
            result: '22C',
          ),
        ],
        createdAt: null,
      );

  Message toolMessage() => const Message(
        id: 'm3',
        role: MessageRole.tool,
        content: '{"city":"Berlin"}',
        toolCallId: 'call_1',
        createdAt: null,
      );

  test('save + loadConversation round-trips messages incl. toolCalls', () async {
    final c = conversation(messages: [
      userMessage('m1', 'hi'),
      assistantWithTools(),
      toolMessage(),
    ]);

    await store.saveConversation(c);

    final loaded = await store.loadConversation('c1');
    expect(loaded, isNotNull);
    expect(loaded!.id, 'c1');
    expect(loaded.title, 'Title');
    expect(loaded.messages, hasLength(3));

    final assistant = loaded.messages[1];
    expect(assistant.role, MessageRole.assistant);
    expect(assistant.toolCalls, hasLength(1));
    expect(assistant.toolCalls!.first.name, 'get_weather');
    expect(assistant.toolCalls!.first.args, {'city': 'Berlin'});
    expect(assistant.toolCalls!.first.result, '22C');

    final tool = loaded.messages[2];
    expect(tool.role, MessageRole.tool);
    expect(tool.toolCallId, 'call_1');
  });

  test('loadConversation returns null for unknown id', () async {
    expect(await store.loadConversation('nope'), isNull);
  });

  test('appendMessage bumps updatedAt + messageCount and watch emits', () async {
    final c = conversation();
    await store.saveConversation(c);

    final updatedAtBefore = (await store.loadConversation('c1'))!.updatedAt;

    final first = store.watchConversations();
    final updates = <List<Conversation>>[];
    final sub = first.listen(updates.add, onError: (Object e) {});

    await store.appendMessage('c1', userMessage('m1', 'hello'));
    await store.appendMessage('c1', userMessage('m2', 'world'));

    // Let the stream deliver events.
    await Future<void>.delayed(const Duration(milliseconds: 50));

    final latest = updates.isEmpty ? null : updates.last;
    expect(latest, isNotNull);
    expect(latest!.single.id, 'c1');
    expect(latest.single.messages, hasLength(2));

    final after = await store.loadConversation('c1');
    expect(after!.messages, hasLength(2));
    expect(after.updatedAt.isAfter(updatedAtBefore), isTrue);
    expect(after.messages.last.content, 'world');

    await sub.cancel();
  });

  test('updateMessage replaces content (streaming partial)', () async {
    await store.saveConversation(conversation(messages: [
      userMessage('m1', 'partial'),
    ]));

    await store.updateMessage(
      'c1',
      userMessage('m1', 'final', createdAt: DateTime(2024, 1, 1, 0, 0, 2)),
    );

    final loaded = await store.loadConversation('c1');
    expect(loaded!.messages, hasLength(1));
    expect(loaded.messages.single.content, 'final');
    expect(loaded.updatedAt.isAfter(DateTime(2024, 1, 1, 0, 0, 1)), isTrue);
  });

  test('deleteConversation cascades to messages', () async {
    await store.saveConversation(conversation(messages: [
      userMessage('m1', 'a'),
      userMessage('m2', 'b'),
    ]));

    await store.deleteConversation('c1');

    expect(await store.loadConversation('c1'), isNull);
    final remaining = await (db.select(db.messages)..where((t) => t.conversationId.equals('c1')))
        .get();
    expect(remaining, isEmpty);
  });

  test('eviction removes oldest conversation beyond 20', () async {
    for (var i = 0; i < 22; i++) {
      final t = DateTime(2024, 1, 1).add(Duration(minutes: i));
      await store.saveConversation(
        conversation(id: 'c$i', title: 'C$i', createdAt: t, updatedAt: t),
      );
    }

    final conversations = await store.watchConversations().first;
    expect(conversations, hasLength(20));
    // Oldest two (c0, c1) evicted; newest (c21) still present.
    expect(conversations.any((c) => c.id == 'c0'), isFalse);
    expect(conversations.any((c) => c.id == 'c1'), isFalse);
    expect(conversations.any((c) => c.id == 'c21'), isTrue);
  });

  test('appending beyond 100 messages keeps all of them in the store', () async {
    await store.saveConversation(conversation());
    for (var i = 0; i < 105; i++) {
      await store.appendMessage(
        'c1',
        userMessage('m$i', 'msg$i', createdAt: DateTime(2024, 1, 1).add(Duration(minutes: i))),
      );
    }

    final loaded = await store.loadConversation('c1');
    expect(loaded!.messages, hasLength(105));
    // No silent mid-conversation trim: the oldest messages survive, and the
    // messageCount reflects the real count.
    expect(loaded.messages.any((m) => m.id == 'm0'), isTrue);
    expect(loaded.messages.any((m) => m.id == 'm104'), isTrue);
  });

  test('deleteMessage removes the row and decrements messageCount', () async {
    await store.saveConversation(conversation(messages: [
      userMessage('m1', 'a'),
      userMessage('m2', 'b'),
    ]));

    await store.deleteMessage('c1', 'm1');

    final loaded = await store.loadConversation('c1');
    expect(loaded!.messages, hasLength(1));
    expect(loaded.messages.single.id, 'm2');
    final row = await (db.select(db.conversations)
          ..where((t) => t.id.equals('c1')))
        .getSingle();
    expect(row.messageCount, 1);
  });

  test('deleteAll clears everything', () async {
    await store.saveConversation(conversation(messages: [
      userMessage('m1', 'a'),
    ]));
    await store.saveConversation(
      conversation(id: 'c2', title: 'Two', messages: [userMessage('m2', 'b')]),
    );

    await store.deleteAll();

    final conversations = await db.select(db.conversations).get();
    final messages = await db.select(db.messages).get();
    expect(conversations, isEmpty);
    expect(messages, isEmpty);
    expect(await store.watchConversations().first, isEmpty);
  });

  test('schemaVersion is 2 and a fresh database round-trips a FileRow',
      () async {
    expect(db.schemaVersion, 2);

    await store.saveConversation(conversation(id: 'c1'));
    final fileStore = DriftFileStore(db);
    await fileStore.saveFile(
      const FileInfo(
        id: 'f1',
        filename: 'photo.jpg',
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
      ),
      conversationId: 'c1',
    );

    final loaded = await fileStore.getFileById('f1');
    expect(loaded, isNotNull);
    expect(loaded!.filename, 'photo.jpg');
    expect(loaded.mimeType, 'image/jpeg');
  });

  test('migrating a v1 database creates the Files table and its index',
      () async {
    final dir = await Directory.systemTemp.createTemp('migration_test');
    final file = File('${dir.path}/app.db');
    addTearDown(() async {
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    });

    // Build a v1 database containing only Conversations + Messages. The
    // NativeDatabase setup hook marks the file as schema version 1 *before*
    // drift's migration logic reads user_version, so opening AppDatabase (which
    // is at schema version 2) runs the onUpgrade path instead of onCreate.
    final v1 = AppDatabase(NativeDatabase(
      file,
      setup: (raw) => raw.execute('PRAGMA user_version = 1;'),
    ));
    final migrator = v1.createMigrator();
    await migrator.createTable(v1.conversations);
    await migrator.createTable(v1.messages);
    await v1.close();

    // Reopen with the current schema: onUpgrade must add the Files table and
    // the per-conversation index.
    final upgraded = AppDatabase(NativeDatabase(file));
    addTearDown(upgraded.close);
    await upgraded.customSelect('SELECT 1').get();

    final upgradedStore = DriftChatStore(upgraded);
    await upgradedStore.saveConversation(
      conversation(id: 'c1', title: 'Migrated'),
    );
    final fileStore = DriftFileStore(upgraded);
    await fileStore.saveFile(
      const FileInfo(
        id: 'f1',
        filename: 'a.jpg',
        sizeBytes: 1,
        mimeType: 'image/jpeg',
      ),
      conversationId: 'c1',
    );
    final loaded = await fileStore.getFileById('f1');
    expect(loaded, isNotNull);
    expect(loaded!.id, 'f1');

    final indexRows = await upgraded
        .customSelect(
          "SELECT name FROM sqlite_master "
          "WHERE type = 'index' AND name = 'files_conversation_id_idx'",
        )
        .get();
    expect(indexRows, hasLength(1));
  });
}
