import 'package:drift_flutter/drift_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../attachments/file_store.dart';
import '../memory/memory_store.dart';
import 'chat_store.dart';
import 'database.dart';

/// Provides the shared [AppDatabase] instance for the chat feature.
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase(driftDatabase(name: 'ai_assistant'));
  ref.onDispose(db.close);
  return db;
});

/// Provides the [ChatStore] used to persist conversations and messages.
final chatStoreProvider = Provider<ChatStore>(
  (ref) => DriftChatStore(ref.watch(databaseProvider)),
);

/// Provides the [FileStore] used to persist file attachment metadata.
final filesStoreProvider = Provider<FileStore>(
  (ref) => DriftFileStore(ref.watch(databaseProvider)),
);

/// Provides the [MemoryStore] used to persist and search memories.
final memoryStoreProvider = Provider<MemoryStore>(
  (ref) => DriftMemoryStore(ref.watch(databaseProvider)),
);
