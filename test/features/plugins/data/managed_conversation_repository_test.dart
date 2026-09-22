import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;
  late ManagedConversationRepository repo;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    repo = ManagedConversationRepository(db);
  });

  tearDown(() async => db.close());

  AuthAccountScope scope(String id) => AuthAccountScope.fromIdentity(
    backendOrigin: 'https://gw.test',
    ownerId: id,
  )!;

  Future<Conversation> seedConversation(
    AuthAccountScope scope,
    String id, [
    String thread = '',
  ]) async {
    final conversation = Conversation(
      id: id,
      title: 'T',
      createdAt: DateTime(2024),
      updatedAt: DateTime(2024),
      messages: const [
        Message(id: 'm1', role: MessageRole.user, content: 'hi'),
      ],
    );
    await repo.access(scope, repo.epoch(scope), () {}, (store) async {
      await store.saveConversation(conversation);
    });
    if (thread.isNotEmpty) await repo.mapSession(id, thread);
    return conversation;
  }

  test('save/load round-trip is scoped; other accounts see nothing', () async {
    final a = scope('owner-a');
    await seedConversation(a, 'c1', 'pub-1');
    final store = await repo.access(a, repo.epoch(a), () {}, (s) async {
      final c = await s.loadConversation('c1');
      expect(c, isNotNull);
      return c!;
    });
    expect(store.messages.single.content, 'hi');
    expect(await db.select(db.conversations).get(), hasLength(1));
    expect(
      db.select(db.conversations).watchSingleOrNull().map((r) => r),
      emitsInOrder([isNotNull]),
    );

    final b = scope('owner-b');
    final storeB = await repo.access(b, repo.epoch(b), () {}, (s) async {
      final c = await s.loadConversation('c1');
      return c;
    });
    expect(storeB, isNull);
  });

  test(
    'pending turn is keyed per (conversation, scope) and clearable',
    () async {
      final a = scope('owner-a');
      await seedConversation(a, 'c1');
      await repo.savePending('c1', a, 'msg-1', {'model': 'openrouter'});
      expect((await repo.pending(a, 'c1'))!.messageId, 'msg-1');
      expect((await repo.pending(scope('owner-b'), 'c1')), isNull);
      await repo.clearPending(scope('owner-b'), 'c1');
      expect((await repo.pending(a, 'c1')), isNotNull);
      await repo.clearPending(a, 'c1');
      expect((await repo.pending(a, 'c1')), isNull);
    },
  );

  test('clearScope bumps epoch and drops data for that scope only', () async {
    final a = scope('owner-a');
    final b = scope('owner-b');
    await seedConversation(a, 'c-a');
    await seedConversation(b, 'c-b');
    final before = repo.epoch(a);
    await repo.clearScope(a);
    expect(repo.epoch(a), greaterThan(before));
    final listB = await repo.access(b, repo.epoch(b), () {}, (s) async {
      return s.watchConversations().first;
    });
    expect(listB, hasLength(1));
    expect(listB.single.id, 'c-b');
    final listA = await repo.access(a, repo.epoch(a), () {}, (s) async {
      return s.watchConversations().first;
    });
    expect(listA, isEmpty);
  });

  test(
    'late work after cancelScope raises cancelled and writes nothing',
    () async {
      final a = scope('owner-a');
      await seedConversation(a, 'c1');
      final epoch = repo.epoch(a);
      final first = repo.access(a, epoch, () {}, (store) async {
        await store.appendMessage(
          'c1',
          const Message(id: 'm2', role: MessageRole.assistant, content: 'ok'),
        );
      });
      repo.cancelScope(a);
      await expectLater(first, throwsA(isA<Exception>()));
      final rows = await db.select(db.messages).get();
      expect(rows, hasLength(1));
    },
  );

  test('an access captured before clearScope throws cancelled and writes '
      'nothing', () async {
    final a = scope('owner-a');
    await seedConversation(a, 'c1');
    final epoch = repo.epoch(a);
    final write = repo.access(a, epoch, () {}, (store) async {
      await store.appendMessage(
        'c1',
        const Message(id: 'm2', role: MessageRole.assistant, content: 'ok'),
      );
    });
    await repo.clearScope(a);
    await expectLater(write, throwsA(isA<Exception>()));
    final rows = await db.select(db.messages).get();
    expect(rows, isEmpty);
  });

  test('clearPending compare-and-deletes so an earlier turn can never clear a '
      'newer pending row', () async {
    final a = scope('owner-a');
    await seedConversation(a, 'c1');
    await repo.savePending('c1', a, 'msg-first', {'model': 'openrouter'});
    // The next send replaces the row under the same (conversation, scope) key.
    await repo.savePending('c1', a, 'msg-second', {'model': 'openrouter'});
    // The stale first turn completes late: messageId no longer matches, so the
    // newer, live pending row survives.
    await repo.clearPending(a, 'c1', messageId: 'msg-first');
    expect((await repo.pending(a, 'c1'))!.messageId, 'msg-second');
    await repo.clearPending(a, 'c1', messageId: 'msg-second');
    expect(await repo.pending(a, 'c1'), isNull);
  });

  test('clearScope purges pending rows for the scope but not another scope', () async {
    final a = scope('owner-a');
    final b = scope('owner-b');
    await seedConversation(a, 'c-a');
    await seedConversation(b, 'c-b');
    await repo.savePending('c-a', a, 'msg-a', {'model': 'openrouter'});
    await repo.savePending('c-b', b, 'msg-b', {'model': 'openrouter'});
    await repo.clearScope(a);
    expect(await repo.pending(a, 'c-a'), isNull);
    expect(await repo.pending(b, 'c-b'), isNotNull);
  });
}
