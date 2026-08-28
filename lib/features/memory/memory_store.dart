import 'package:drift/drift.dart';

import '../chat/database.dart';
import 'memory_model.dart';

/// Persistence and full-text search contract for deferred memories.
abstract interface class MemoryStore {
  /// Upserts a memory: on id conflict, content/source/updatedAt are replaced
  /// but createdAt is preserved (it is immutable once set).
  Future<void> saveMemory(Memory memory);

  /// Returns a single memory by id, or null when absent.
  Future<Memory?> getMemory(String id);

  /// Returns up to [limit] memories, most-recently-updated first.
  Future<List<Memory>> listMemories({int limit = 50});

  /// Full-text search over memory content, date-weighted so fresh memories
  /// rank ahead of stale ones at equal match quality. Returns at most [limit]
  /// matches.
  Future<List<Memory>> searchMemories(String query, {int limit = 20});

  /// Deletes a single memory row.
  Future<void> deleteMemory(String id);

  /// Removes every memory row.
  Future<void> deleteAllMemories();

  /// Compaction query: deletes memories whose [Memory.updatedAt] is older than
  /// `now - olderThan` and returns the number of rows removed. An
  /// [olderThan] of zero or less deletes nothing.
  Future<int> compact({required Duration olderThan});

  /// Returns the total number of stored memories.
  Future<int> countMemories();
}

/// Drift-backed [MemoryStore].
class DriftMemoryStore implements MemoryStore {
  DriftMemoryStore(this._db);

  final AppDatabase _db;

  /// Scale factor for the days-since-updated recency term in the FTS5 search
  /// ranking.
  ///
  /// Ranking is `bm25(memories_fts) + capped_age_in_days * [recencyWeight]`
  /// (ascending). bm25 (match quality) dominates; the recency term only breaks
  /// ties, so fresh memories edge out stale ones at equal match quality. The
  /// age is clamped to `[0, 30]` days — an unbounded penalty would let
  /// old-but-perfect matches be pushed out by younger poor matches, and future
  /// timestamps would otherwise subtract from the score.
  static const double recencyWeight = 0.01;

  @override
  Future<void> saveMemory(Memory memory) async {
    final row = _toRow(memory);
    // DoUpdate only writes content/source/updatedAt, leaving the original
    // createdAt (and id) untouched on conflict.
    await _db.into(_db.memories).insert(
          row,
          onConflict: DoUpdate(
            (_) => MemoriesCompanion(
              content: row.content,
              source: row.source,
              updatedAt: row.updatedAt,
            ),
          ),
        );
  }

  @override
  Future<Memory?> getMemory(String id) async {
    final row = await (_db.select(_db.memories)..where((t) => t.id.equals(id)))
        .getSingleOrNull();
    return row == null ? null : _fromRow(row);
  }

  @override
  Future<List<Memory>> listMemories({int limit = 50}) async {
    final rows = await (_db.select(_db.memories)
          ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
          ..limit(limit))
        .get();
    return rows.map(_fromRow).toList();
  }

  @override
  Future<List<Memory>> searchMemories(String query, {int limit = 20}) async {
    if (limit <= 0) {
      return const [];
    }
    // Unicode-aware tokenization: FTS5's default unicode61 tokenizer indexes
    // letters in any script, so an ASCII-only \w+ would silently miss accented
    // words ("café" -> "caf") and yield zero terms for CJK text.
    final terms = RegExp(r'[\p{L}\p{N}_]+', unicode: true)
        .allMatches(query.trim())
        .map((m) => m.group(0)!)
        .toList();
    // FTS5 MATCH throws on an empty expression, so bail out early.
    if (terms.isEmpty) {
      return const [];
    }
    // Quote each term as a phrase so user text like "hello world" becomes a
    // forgiving `"hello" AND "world"` conjunction instead of invalid FTS5.
    final ftsQuery = terms.map((t) => '"$t"').join(' AND ');
    final rows = await _db
        .customSelect(
          // bm25 (match quality) dominates; the recency penalty is capped at
          // 30 days and floored at 0 (see recencyWeight). drift stores
          // DateTime as unix epoch seconds, so the age is
          // `unixepoch() - m.updated_at` (unixepoch() needs SQLite >= 3.38,
          // bundled via sqlite3_flutter_libs).
          'SELECT m.id, m.content, m.source, m.created_at, m.updated_at '
          'FROM memories AS m '
          'JOIN memories_fts ON memories_fts.rowid = m.rowid '
          'WHERE memories_fts MATCH ?1 '
          'ORDER BY (bm25(memories_fts) '
          ' + MAX(MIN((unixepoch() - m.updated_at) / 86400.0, 30.0), 0.0) '
          ' * ?2) ASC '
          'LIMIT ?3',
          variables: [
            Variable<String>(ftsQuery),
            Variable<double>(recencyWeight),
            Variable<int>(limit),
          ],
        )
        .get();
    final memories = <Memory>[];
    for (final row in rows) {
      memories.add(_fromRow(await _db.memories.mapFromRow(row)));
    }
    return memories;
  }

  @override
  Future<void> deleteMemory(String id) async {
    await (_db.delete(_db.memories)..where((t) => t.id.equals(id))).go();
  }

  @override
  Future<void> deleteAllMemories() async {
    await _db.delete(_db.memories).go();
  }

  @override
  Future<int> compact({required Duration olderThan}) async {
    if (olderThan <= Duration.zero) {
      return 0;
    }
    final cutoff = DateTime.now().subtract(olderThan);
    return (_db.delete(_db.memories)
          ..where((t) => t.updatedAt.isSmallerThanValue(cutoff)))
        .go();
  }

  @override
  Future<int> countMemories() async {
    final row = await (_db.selectOnly(_db.memories)
          ..addColumns([_db.memories.id.count()]))
        .getSingle();
    return row.read(_db.memories.id.count()) ?? 0;
  }

  MemoriesCompanion _toRow(Memory memory) => MemoriesCompanion(
        id: Value(memory.id),
        content: Value(memory.content),
        source: Value(memory.source),
        createdAt: Value(memory.createdAt),
        updatedAt: Value(memory.updatedAt),
      );

  Memory _fromRow(MemoryRow row) => Memory(
        id: row.id,
        content: row.content,
        source: row.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      );
}