import 'package:drift_flutter/drift_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
