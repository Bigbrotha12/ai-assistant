import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/data/file_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const scopeA = 'scope-a';
  late AppDatabase db;
  late DriftFileStore store;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    store = DriftFileStore(db, scopeKey: scopeA);
  });

  tearDown(() async {
    await db.close();
  });

  FileInfo file({
    String id = 'f1',
    String filename = 'photo.jpg',
    int sizeBytes = 1234,
    String mimeType = 'image/jpeg',
    DateTime? uploadedAt,
    DateTime? cachedAt,
    String? localPath,
  }) => FileInfo(
    id: id,
    filename: filename,
    sizeBytes: sizeBytes,
    mimeType: mimeType,
    uploadedAt: uploadedAt,
    cachedAt: cachedAt,
    localPath: localPath,
  );

  test('saveFile + getFileById round-trips all fields', () async {
    final info = file(
      localPath: 'f1.jpg',
      uploadedAt: DateTime(2024, 2, 1),
      cachedAt: DateTime(2024, 2, 2),
    );

    await store.saveFile(info);

    final loaded = await store.getFileById('f1');
    expect(loaded, isNotNull);
    expect(loaded!.id, 'f1');
    expect(loaded.filename, 'photo.jpg');
    expect(loaded.sizeBytes, 1234);
    expect(loaded.mimeType, 'image/jpeg');
    expect(loaded.localPath, 'f1.jpg');
    expect(loaded.uploadedAt, DateTime(2024, 2, 1));
    expect(loaded.cachedAt, DateTime(2024, 2, 2));
  });

  test('saveFile upserts on conflict', () async {
    await store.saveFile(file(filename: 'old.jpg'));
    await store.saveFile(file(filename: 'new.jpg', sizeBytes: 99));

    final loaded = await store.getFileById('f1');
    expect(loaded!.filename, 'new.jpg');
    expect(loaded.sizeBytes, 99);
  });

  test('getFileById returns null for unknown id', () async {
    expect(await store.getFileById('nope'), isNull);
  });

  Future<void> addConversation(String id, {String scopeKey = scopeA}) => db
      .into(db.conversations)
      .insertOnConflictUpdate(
        ConversationsCompanion.insert(
          id: id,
          createdAt: DateTime(2024, 1, 1),
          updatedAt: DateTime(2024, 1, 1),
          scopeKey: Value(scopeKey),
        ),
      );

  test(
    'listFilesForConversation returns only that conversation files',
    () async {
      await addConversation('c1');
      await addConversation('c2');
      await store.saveFile(
        file(id: 'f1', localPath: 'f1.jpg'),
        conversationId: 'c1',
      );
      await store.saveFile(
        file(id: 'f2', localPath: 'f2.jpg'),
        conversationId: 'c1',
      );
      await store.saveFile(
        file(id: 'f3', localPath: 'f3.jpg'),
        conversationId: 'c2',
      );

      final forC1 = await store.listFilesForConversation('c1');
      expect(forC1.map((f) => f.id).toSet(), {'f1', 'f2'});
    },
  );

  test('listAllFiles includes files with null conversationId', () async {
    await addConversation('c1');
    await store.saveFile(
      file(id: 'f1', localPath: 'f1.jpg'),
      conversationId: 'c1',
    );
    await store.saveFile(
      file(id: 'f2', localPath: 'f2.jpg'),
    ); // null conversationId

    final all = await store.listAllFiles();
    expect(all.map((f) => f.id).toSet(), {'f1', 'f2'});
  });

  test('deleteFile removes the row', () async {
    await store.saveFile(file());
    await store.deleteFile('f1');

    expect(await store.getFileById('f1'), isNull);
  });

  test('deleteAllForScope clears this account', () async {
    await store.saveFile(file(id: 'f1'));
    await store.saveFile(file(id: 'f2'));
    await store.deleteAllForScope(scopeA);

    expect(await store.listAllFiles(), isEmpty);
  });

  test('deleting a conversation cascades to its files', () async {
    await addConversation('c1');
    await store.saveFile(
      file(id: 'f1', localPath: 'f1.jpg'),
      conversationId: 'c1',
    );
    await store.saveFile(
      file(id: 'f2', localPath: 'f2.jpg'),
      conversationId: 'c1',
    );
    // A file in another conversation should survive the cascade.
    await addConversation('c2');
    await store.saveFile(
      file(id: 'f3', localPath: 'f3.jpg'),
      conversationId: 'c2',
    );

    await (db.delete(db.conversations)..where((t) => t.id.equals('c1'))).go();

    final remaining = await db.select(db.files).get();
    expect(remaining.map((r) => r.id).toSet(), {'f3'});
  });

  test('descriptionFor returns null for unknown id, and stored description for known id', () async {
    expect(await store.descriptionFor('missing'), isNull);

    await store.saveFile(file(id: 'f1'));
    await store.setDescription('f1', 'A photo of the beach');

    expect(await store.descriptionFor('f1'), 'A photo of the beach');
  });

  test('setDescription persists and is readable via descriptionFor', () async {
    await store.saveFile(file(id: 'f1'));
    await store.setDescription('f1', 'first');
    await store.setDescription('f1', 'second');

    expect(await store.descriptionFor('f1'), 'second');
  });

  test('two accounts isolate every file operation with the same id', () async {
    const scopeB = 'scope-b';
    final storeB = DriftFileStore(db, scopeKey: scopeB);
    await addConversation('c-a');
    await addConversation('c-b', scopeKey: scopeB);

    await store.saveFile(
      file(id: 'shared', filename: 'a.jpg'),
      conversationId: 'c-a',
    );
    await storeB.saveFile(
      file(id: 'shared', filename: 'b.jpg'),
      conversationId: 'c-b',
    );

    expect((await store.getFileById('shared'))!.filename, 'a.jpg');
    expect((await storeB.getFileById('shared'))!.filename, 'b.jpg');
    expect(
      (await store.listFilesForConversation('c-a')).map((f) => f.filename),
      ['a.jpg'],
    );
    expect(
      (await storeB.listFilesForConversation('c-b')).map((f) => f.filename),
      ['b.jpg'],
    );
    expect((await store.listAllFiles()).single.filename, 'a.jpg');
    expect((await storeB.listAllFiles()).single.filename, 'b.jpg');

    await store.setDescription('shared', 'account A');
    await storeB.setDescription('shared', 'account B');
    expect(await store.descriptionFor('shared'), 'account A');
    expect(await storeB.descriptionFor('shared'), 'account B');

    await store.saveFile(
      file(id: 'shared', filename: 'a-new.jpg'),
      conversationId: 'c-a',
    );
    expect((await store.getFileById('shared'))!.filename, 'a-new.jpg');
    expect((await storeB.getFileById('shared'))!.filename, 'b.jpg');

    await expectLater(
      store.saveFile(file(id: 'foreign'), conversationId: 'c-b'),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('scope mismatch'),
        ),
      ),
    );

    await store.deleteFile('shared');
    expect(await store.getFileById('shared'), isNull);
    expect((await storeB.getFileById('shared'))!.filename, 'b.jpg');

    await store.saveFile(file(id: 'again'));
    await store.deleteAllForScope(scopeA);
    expect(await store.listAllFiles(), isEmpty);
    expect((await storeB.getFileById('shared'))!.filename, 'b.jpg');
    await expectLater(
      storeB.deleteAllForScope(scopeA),
      throwsA(isA<StateError>()),
    );
  });
}
