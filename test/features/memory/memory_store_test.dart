import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/memory/data/memory_model.dart';
import 'package:ai_assistant/features/memory/data/memory_store.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;
  late DriftMemoryStore store;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    store = DriftMemoryStore(db);
  });

  tearDown(() async {
    await db.close();
  });

  Memory memory({
    String id = 'm1',
    String content = 'hello world',
    String? source,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) =>
      Memory(
        id: id,
        content: content,
        source: source,
        createdAt: createdAt ?? DateTime(2024, 1, 1),
        updatedAt: updatedAt ?? DateTime(2024, 1, 1, 0, 0, 1),
      );

  test('saveMemory + getMemory round-trips all fields', () async {
    await store.saveMemory(
      memory(
        content: 'The quick brown fox',
        source: 'conversation-123',
        createdAt: DateTime(2024, 2, 1),
        updatedAt: DateTime(2024, 2, 2),
      ),
    );

    final loaded = await store.getMemory('m1');
    expect(loaded, isNotNull);
    expect(loaded!.id, 'm1');
    expect(loaded.content, 'The quick brown fox');
    expect(loaded.source, 'conversation-123');
    expect(loaded.createdAt, DateTime(2024, 2, 1));
    expect(loaded.updatedAt, DateTime(2024, 2, 2));
  });

  test('getMemory returns null for unknown id', () async {
    expect(await store.getMemory('nope'), isNull);
  });

  test('saveMemory upserts on conflict', () async {
    await store.saveMemory(memory(content: 'old text'));
    await store.saveMemory(
      memory(content: 'new text', updatedAt: DateTime(2024, 3, 1)),
    );

    final loaded = await store.getMemory('m1');
    expect(loaded!.content, 'new text');
    expect(loaded.updatedAt, DateTime(2024, 3, 1));
  });

  test('saveMemory preserves createdAt on conflict', () async {
    await store.saveMemory(
      memory(
        content: 'first',
        createdAt: DateTime(2024, 1, 1),
        updatedAt: DateTime(2024, 1, 1),
      ),
    );
    await store.saveMemory(
      memory(
        content: 'second',
        createdAt: DateTime(2024, 6, 1),
        updatedAt: DateTime(2024, 6, 1),
      ),
    );

    final loaded = await store.getMemory('m1');
    expect(loaded!.createdAt, DateTime(2024, 1, 1));
    expect(loaded.content, 'second');
    expect(loaded.updatedAt, DateTime(2024, 6, 1));
  });

  test('copyWith(source: null) clears the source', () {
    final m = memory(source: 'conversation-1');
    expect(m.copyWith(source: null).source, isNull);
    expect(m.copyWith(content: 'x').source, 'conversation-1');
    expect(m.copyWith().source, 'conversation-1');
  });

  test('listMemories returns most-recently-updated first', () async {
    await store.saveMemory(
      memory(id: 'old', updatedAt: DateTime(2023, 1, 1)),
    );
    await store.saveMemory(
      memory(id: 'new', updatedAt: DateTime(2024, 1, 1)),
    );
    await store.saveMemory(
      memory(id: 'middle', updatedAt: DateTime(2023, 6, 1)),
    );

    final all = await store.listMemories();
    expect(all.map((m) => m.id).toList(), ['new', 'middle', 'old']);

    final limited = await store.listMemories(limit: 2);
    expect(limited.map((m) => m.id).toList(), ['new', 'middle']);
  });

  test('searchMemories finds matching content', () async {
    await store.saveMemory(memory(id: 'm1', content: 'The quick brown fox'));
    await store.saveMemory(memory(id: 'm2', content: 'A lazy dog sleeps'));

    final results = await store.searchMemories('fox');
    expect(results.map((m) => m.id).toList(), ['m1']);

    final dog = await store.searchMemories('dog');
    expect(dog.map((m) => m.id).toList(), ['m2']);
  });

  test('searchMemories returns empty for an empty query', () async {
    await store.saveMemory(memory(content: 'anything'));

    expect(await store.searchMemories(''), isEmpty);
    expect(await store.searchMemories('   '), isEmpty);
  });

  test('searchMemories matches both terms of a multi-term query', () async {
    await store.saveMemory(memory(id: 'm1', content: 'alpha beta gamma'));
    await store.saveMemory(memory(id: 'm2', content: 'alpha only'));
    await store.saveMemory(memory(id: 'm3', content: 'beta only'));

    final results = await store.searchMemories('alpha beta');
    expect(results.map((m) => m.id).toSet(), {'m1'});
  });

  test('searchMemories is case-insensitive', () async {
    await store.saveMemory(memory(id: 'm1', content: 'Hello World'));

    final results = await store.searchMemories('hello');
    expect(results.map((m) => m.id).toList(), ['m1']);
  });

  test('searchMemories finds accented words (unicode tokenizer)', () async {
    await store.saveMemory(memory(id: 'm1', content: 'Café au lait'));

    // unicode61 tokenizes both sides to 'cafe' (diacritics removed); the old
    // ASCII-only \w+ tokenizer produced the term 'caf' here, matching nothing.
    final results = await store.searchMemories('café');
    expect(results.map((m) => m.id).toList(), ['m1']);
  });

  test('searchMemories finds CJK words (unicode tokenizer)', () async {
    await store.saveMemory(memory(id: 'm1', content: '你好'));
    await store.saveMemory(memory(id: 'm2', content: 'hello'));

    final results = await store.searchMemories('你好');
    expect(results.map((m) => m.id).toList(), ['m1']);
  });

  test('searchMemories with a non-positive limit returns nothing', () async {
    await store.saveMemory(memory(content: 'fox hunt'));

    expect(await store.searchMemories('fox', limit: 0), isEmpty);
    expect(await store.searchMemories('fox', limit: -1), isEmpty);
  });

  test('date-weighted retrieval ranks recent memories first', () async {
    await store.saveMemory(
      memory(
        id: 'stale',
        content: 'shared keyword',
        updatedAt: DateTime.now().subtract(const Duration(days: 400)),
      ),
    );
    await store.saveMemory(
      memory(
        id: 'fresh',
        content: 'shared keyword',
        updatedAt: DateTime.now(),
      ),
    );

    final results = await store.searchMemories('shared');
    expect(results.map((m) => m.id).toList(), ['fresh', 'stale']);
  });

  test('recency penalty is capped: stale exact match outranks fresh weak match',
      () async {
    // Filler rows keep the matched terms rare (low document frequency), making
    // the bm25 gap between a short exact match and a long padded one large
    // enough to beat a 30-day cap but smaller than an unbounded ~400-day
    // penalty.
    for (var i = 0; i < 4; i++) {
      await store.saveMemory(memory(id: 'filler$i', content: 'unrelated entry'));
    }
    await store.saveMemory(
      memory(
        id: 'exact',
        content: 'concurrent threads',
        updatedAt: DateTime.now().subtract(const Duration(days: 400)),
      ),
    );
    await store.saveMemory(
      memory(
        id: 'fresh',
        content: 'concurrent threads'
            ' padded padding extra words padding padding padding'
            ' padding padding padding padding padding padding padding'
            ' padding padding padding padding padding padding padding'
            ' padding padding padding padding padding padding padding'
            ' padding padding padding padding padding padding padding',
        updatedAt: DateTime.now(),
      ),
    );

    final results = await store.searchMemories('concurrent threads');
    expect(results.map((m) => m.id).toList(), ['exact', 'fresh']);
  });

  test('searchMemories reflects upserted content, not stale', () async {
    await store.saveMemory(memory(id: 'm1', content: 'old content fox'));
    await store.saveMemory(memory(id: 'm1', content: 'brand new content'));

    final results = await store.searchMemories('new');
    expect(results.map((m) => m.id).toList(), ['m1']);
    expect(await store.searchMemories('fox'), isEmpty);
  });

  test('compact removes memories older than the threshold', () async {
    await store.saveMemory(
      memory(
        id: 'old',
        content: 'old entry',
        updatedAt: DateTime.now().subtract(const Duration(days: 365 * 2)),
      ),
    );
    await store.saveMemory(
      memory(
        id: 'recent',
        content: 'recent entry',
        updatedAt: DateTime.now(),
      ),
    );

    final deleted = await store.compact(olderThan: const Duration(days: 365));

    expect(deleted, 1);
    expect(await store.getMemory('old'), isNull);
    expect(await store.getMemory('recent'), isNotNull);
  });

  test('compact removes compacted-away memories from search results', () async {
    await store.saveMemory(
      memory(
        id: 'old',
        content: 'fox hunt',
        updatedAt: DateTime.now().subtract(const Duration(days: 400)),
      ),
    );
    await store.saveMemory(
      memory(
        id: 'recent',
        content: 'fox runs',
        updatedAt: DateTime.now(),
      ),
    );

    await store.compact(olderThan: const Duration(days: 365));

    final results = await store.searchMemories('fox');
    expect(results.map((m) => m.id).toList(), ['recent']);
  });

  test('compact with a non-positive threshold deletes nothing', () async {
    await store.saveMemory(memory(id: 'm1', content: 'keep me'));

    expect(await store.compact(olderThan: Duration.zero), 0);
    expect(await store.compact(olderThan: const Duration(days: -1)), 0);
    expect(await store.countMemories(), 1);
  });

  test('deleteMemory removes the row', () async {
    await store.saveMemory(memory(id: 'm1', content: 'fox hunt'));
    await store.deleteMemory('m1');

    expect(await store.getMemory('m1'), isNull);
    expect(await store.searchMemories('fox'), isEmpty);
  });

  test('deleteAllMemories clears everything', () async {
    await store.saveMemory(memory(id: 'm1', content: 'fox hunt'));
    await store.saveMemory(memory(id: 'm2', content: 'dog walk'));

    await store.deleteAllMemories();

    expect(await store.countMemories(), 0);
    expect(await store.listMemories(), isEmpty);
    expect(await store.searchMemories('fox'), isEmpty);
    expect(await store.searchMemories('dog'), isEmpty);
  });

  test('countMemories reflects stored rows', () async {
    expect(await store.countMemories(), 0);
    await store.saveMemory(memory(id: 'm1'));
    await store.saveMemory(memory(id: 'm2'));
    expect(await store.countMemories(), 2);
  });
}