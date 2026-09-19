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
  TextColumn get publicThreadId => text().nullable()();

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
@TableIndex(name: 'files_conversation_id_idx', columns: {#conversationId})
@DataClassName('FileRow')
class Files extends Table {
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
  Set<Column> get primaryKey => {id};
}

/// Index for the per-conversation file listing / cascade. The table grows with
/// every upload, so scanning without an index gets progressively slower.

/// A single deferred memory: free-form text with optional provenance and
/// date-weighted retrieval via the FTS5 index (`memories_fts`).
///
/// The `updated_at` index backs `listMemories` (ORDER BY updated_at DESC) and
/// `compact` (WHERE updated_at < cutoff); without it both scan the whole table.
@TableIndex(name: 'memories_updated_at_idx', columns: {#updatedAt})
@DataClassName('MemoryRow')
class Memories extends Table {
  TextColumn get id => text()(); // UUID PK
  TextColumn get content => text()(); // the memory text
  TextColumn get source =>
      text().nullable()(); // provenance (conversation id, 'manual')
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}

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
  int get schemaVersion => 6;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (m) async {
      await m.createAll();
      await _createMemoryFts(m);
    },
    onUpgrade: (m, from, to) async {
      if (from < 2) {
        await m.createTable(files);
        await m.createIndex(filesConversationIdIdx);
      }
      if (from < 3) {
        await m.alterTable(
          TableMigration(files, newColumns: [files.description]),
        );
      }
      if (from < 4) {
        await m.createTable(memories);
        await m.createIndex(memoriesUpdatedAtIdx);
        await _createMemoryFts(m);
      }
      if (from < 5) {
        await m.createIndex(messagesConversationIdIdx);
      }
      if (from < 6) {
        await m.addColumn(conversations, conversations.scopeKey);
        await m.addColumn(conversations, conversations.publicThreadId);
        await m.createTable(managedPendingTurns);
      }
      // v4: memories table + FTS5 full-text search (see DriftMemoryStore).
      // v5: index on messages.conversationId (per-conversation message
      // loads and watchConversations scan no longer table-scan).
    },
    beforeOpen: (details) async {
      // SQLite does NOT enable FK enforcement by default — without this
      // the ON DELETE CASCADE above silently never fires.
      await customStatement('PRAGMA foreign_keys = ON');
    },
  );

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
