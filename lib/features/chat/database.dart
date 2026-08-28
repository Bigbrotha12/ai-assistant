import 'package:drift/drift.dart';

part 'database.g.dart';

@DataClassName('ConversationRow')
class Conversations extends Table {
  TextColumn get id => text()();
  TextColumn get title => text().withDefault(const Constant(''))();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  IntColumn get messageCount => integer().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('MessageRow')
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
  TextColumn get conversationId => text()
      .nullable()
      .references(Conversations, #id, onDelete: KeyAction.cascade)();
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

@DriftDatabase(tables: [Conversations, Messages, Files])
class AppDatabase extends _$AppDatabase {
  AppDatabase(super.e);

  @override
  int get schemaVersion => 3;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            await m.createTable(files);
            await m.createIndex(filesConversationIdIdx);
          }
          if (from < 3) {
            await m.alterTable(TableMigration(files, newColumns: [files.description]));
          }
          // Phase 5: memories+FTS5 deferred to v4 (no consumer feature yet).
        },
        beforeOpen: (details) async {
          // SQLite does NOT enable FK enforcement by default — without this
          // the ON DELETE CASCADE above silently never fires.
          await customStatement('PRAGMA foreign_keys = ON');
        },
      );
}
