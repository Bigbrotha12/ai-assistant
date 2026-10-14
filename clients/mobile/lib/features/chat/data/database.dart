import 'package:drift/drift.dart';

part 'database.g.dart';

@DataClassName('ConversationRow')
class Conversations extends Table {
  TextColumn get id => text()();
  TextColumn get title => text().withDefault(const Constant(''))();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  IntColumn get messageCount => integer().withDefault(const Constant(0))();
  TextColumn get scopeKey => text().nullable()();
  TextColumn get sessionId => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('MessageRow')
@TableIndex(name: 'messages_conversation_id_idx', columns: {#conversationId})
class Messages extends Table {
  TextColumn get id => text()();
  TextColumn get conversationId =>
      text().references(Conversations, #id, onDelete: KeyAction.cascade)();
  TextColumn get role => text()(); // 'user' | 'assistant' | 'tool'
  TextColumn get content => text().withDefault(const Constant(''))();
  TextColumn get toolCalls => text().nullable()(); // JSON, assistant only
  TextColumn get toolCallId => text().nullable()(); // tool-role linkage
  DateTimeColumn get createdAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Metadata for a file attachment.
///
/// `conversationId` is nullable because files can exist outside a
/// conversation (the file browser lists files across all conversations).
/// The local `id` is the server-assigned id; `serverFileId` stores the same
/// value for future-proofing (see `DriftFileStore` mapping notes).
@TableIndex(
  name: 'files_scope_key_conversation_id_idx',
  columns: {#scopeKey, #conversationId},
)
@DataClassName('FileRow')
class Files extends Table {
  TextColumn get scopeKey => text()();
  TextColumn get id => text()();
  TextColumn get conversationId => text().nullable().references(
    Conversations,
    #id,
    onDelete: KeyAction.cascade,
  )();
  TextColumn get serverFileId => text()();
  TextColumn get localPath => text()();
  TextColumn get filename => text()();
  IntColumn get sizeBytes => integer()();
  TextColumn get mimeType => text()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  TextColumn get description => text().nullable()();

  @override
  Set<Column> get primaryKey => {scopeKey, id};
}

/// A single deferred memory: free-form text with optional provenance and
/// date-weighted retrieval via the FTS5 index (`memories_fts`).
///
/// The `(scope_key, updated_at)` index backs scoped list/compaction queries;
/// without it both scan the whole table.
@TableIndex(
  name: 'memories_scope_key_updated_at_idx',
  columns: {#scopeKey, #updatedAt},
)
@DataClassName('MemoryRow')
class Memories extends Table {
  TextColumn get scopeKey => text()();
  TextColumn get id => text()();
  TextColumn get content => text()(); // the memory text
  TextColumn get source =>
      text().nullable()(); // provenance (conversation id, 'manual')
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {scopeKey, id};
}

@TableIndex(name: 'managed_pending_turns_scope_key_idx', columns: {#scopeKey})
@DataClassName('ManagedPendingTurnRow')
class ManagedPendingTurns extends Table {
  // No FK to conversations: a FIRST send persists the pending turn before the
  // local conversation row exists (the row is only written after the server
  // replies, and a logout/clear must be able to drop the row independently).
  TextColumn get conversationId => text()();
  TextColumn get scopeKey => text()();
  TextColumn get messageId => text()();
  TextColumn get envelope => text()();
  BoolColumn get reconcileOnly =>
      boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {conversationId, scopeKey};
}

@DriftDatabase(
  tables: [Conversations, Messages, Files, Memories, ManagedPendingTurns],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase(super.e);

  @override
  int get schemaVersion => 9;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (m) async {
      await m.createAll();
      await _createMemoryFts(m);
    },
    onUpgrade: (m, from, to) async {
      if (from < 2) {
        await m.createTable(files);
        await m.createIndex(filesScopeKeyConversationIdIdx);
      }
      if (from == 2) {
        await m.alterTable(
          TableMigration(files, newColumns: [files.description]),
        );
      }
      if (from < 4) {
        await m.createTable(memories);
        await m.createIndex(memoriesScopeKeyUpdatedAtIdx);
        await _createMemoryFts(m);
      }
      if (from < 5) {
        await m.createIndex(messagesConversationIdIdx);
      }
      if (from < 6) {
        await m.addColumn(conversations, conversations.scopeKey);
        await m.addColumn(conversations, conversations.sessionId);
        await m.createTable(managedPendingTurns);
      }
      if (from < 7) {
        // v6 installs physically carry the legacy public_thread_id column; the
        // data it holds is the live conversationId → session_id mapping. Rename
        // in place ONLY from exactly v6 (those are the only DBs with the old
        // name — stores that upgraded from < 6 already created session_id via
        // the block above, so the rename must not run for them).
        if (from == 6) {
          await m.database.customStatement(
            'ALTER TABLE conversations RENAME COLUMN public_thread_id TO session_id',
          );
        }
      }
      if (from < 8) {
        await m.createIndex(managedPendingTurnsScopeKeyIdx);
      }
      if (from >= 2 && from < 9) {
        await _rebuildScopedFiles(m);
      }
      if (from >= 4 && from < 9) {
        await _rebuildScopedMemories(m);
      }

      // v4: memories table + FTS5 full-text search (see DriftMemoryStore).
      // v5: index on messages.conversationId (per-conversation message
      // loads and watchConversations scan no longer table-scan).
      // v6: scopeKey + session_id on conversations and managed_pending_turns.
      // v7: legacy public_thread_id renamed to session_id in place.
      // v8: pending-turn scope index.
      // v9: account-scoped composite-key files and memories.
    },
    beforeOpen: (details) async {
      // SQLite does NOT enable FK enforcement by default — without this
      // the ON DELETE CASCADE above silently never fires.
      await customStatement('PRAGMA foreign_keys = ON');
    },
  );

  Future<void> _rebuildScopedFiles(Migrator m) async {
    final db = m.database;
    const replacement = 'files__f8_scoped';
    await db.customStatement('DROP TABLE IF EXISTS $replacement');
    await db.customStatement('''
      CREATE TABLE $replacement (
        scope_key TEXT NOT NULL,
        id TEXT NOT NULL,
        conversation_id TEXT
          REFERENCES conversations (id) ON DELETE CASCADE,
        server_file_id TEXT NOT NULL,
        local_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        description TEXT,
        PRIMARY KEY (scope_key, id)
      )
    ''');

    // F8 legacy policy: DELETE, DO NOT BACKFILL. Only a file whose existing
    // conversation has a non-null scope is unambiguous. Null links, null-scope
    // parents, and orphan links are deliberately excluded and therefore lost.
    await db.customStatement('''
      INSERT INTO $replacement (
        scope_key, id, conversation_id, server_file_id, local_path, filename,
        size_bytes, mime_type, created_at, updated_at, description
      )
      SELECT c.scope_key, f.id, f.conversation_id, f.server_file_id,
             f.local_path, f.filename, f.size_bytes, f.mime_type,
             f.created_at, f.updated_at, f.description
      FROM files AS f
      INNER JOIN conversations AS c ON c.id = f.conversation_id
      WHERE c.scope_key IS NOT NULL
    ''');
    await db.customStatement('DROP TABLE files');
    await db.customStatement('ALTER TABLE $replacement RENAME TO files');
    await m.createIndex(filesScopeKeyConversationIdIdx);
  }

  Future<void> _rebuildScopedMemories(Migrator m) async {
    final db = m.database;
    await db.customStatement('DROP TRIGGER IF EXISTS memories_ai');
    await db.customStatement('DROP TRIGGER IF EXISTS memories_ad');
    await db.customStatement('DROP TRIGGER IF EXISTS memories_au');
    await db.customStatement('DROP TABLE IF EXISTS memories_fts');

    // F8 legacy policy: DELETE, DO NOT BACKFILL. Memory.source is free-form
    // provenance, not a trustworthy conversation link, so every legacy memory
    // is deleted. Recreating FTS from an empty table prevents deleted content
    // from surviving in the external-content index.
    await db.customStatement('DROP TABLE memories');
    await m.createTable(memories);
    await m.createIndex(memoriesScopeKeyUpdatedAtIdx);
    await _createMemoryFts(m);
  }

  /// Creates the external-content FTS5 index (`memories_fts`) over the
  /// `memories` table plus the triggers that keep it in sync.
  ///
  /// FTS sync invariant: `memories` must be created first, then `memories_fts`,
  /// then the triggers — in that order, and before any row is written. A row
  /// inserted while the FTS table or triggers are missing (or written via raw
  /// SQL that bypasses the triggers) leaves `memories` ahead of the index, and
  /// a later FTS `'delete'` command raises SQLITE_CORRUPT.
  ///
  /// Created via raw SQL (rather than a `.drift` file) because drift-file
  /// statements cannot reference tables declared in Dart, which rules out both
  /// the `content='memories'` back-reference and the date-weighted MATCH query.
  /// Idempotent so both onCreate and onUpgrade can run it.
  static Future<void> _createMemoryFts(Migrator m) async {
    final db = m.database;
    await db.customStatement(
      'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING '
      "fts5(content, content='memories', content_rowid='rowid')",
    );
    await db.customStatement('''
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    ''');
    await db.customStatement('''
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    ''');
    await db.customStatement('''
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    ''');
  }
}
