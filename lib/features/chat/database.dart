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

@DriftDatabase(tables: [Conversations, Messages])
class AppDatabase extends _$AppDatabase {
  AppDatabase(super.e);

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          // Phase 5: memories table + FTS5 land here.
        },
        beforeOpen: (details) async {
          // SQLite does NOT enable FK enforcement by default — without this
          // the ON DELETE CASCADE above silently never fires.
          await customStatement('PRAGMA foreign_keys = ON');
        },
      );
}
