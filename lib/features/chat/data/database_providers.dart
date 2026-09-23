import 'package:drift_flutter/drift_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../attachments/data/file_store.dart';
import '../../memory/data/memory_store.dart';
import '../../plugins/data/plugin_catalog_providers.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import './chat_store.dart';
import './database.dart';

/// Provides the shared [AppDatabase] instance for the chat feature.
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase(driftDatabase(name: 'ai_assistant'));
  ref.onDispose(db.close);
  return db;
});

/// Sentinel scope key for the pre-scope gate: no real account scope can
/// produce it, so the gated store matches zero rows and the history UI
/// renders an empty list instead of surfacing `pluginAccountScopeProvider`'s
/// `PluginReauthenticationRequired`.
const String pendingScopeKey = '__pending__';

/// Deletes the conversations written by the old unscoped UI path
/// (`scope_key IS NULL`). Plan decision (docs/managed-ui-wiring-plan.md, P0 /
/// §5 decision 7): **delete, don't backfill — null-scope legacy rows** are
/// test data only. Messages go with them via the conversations FK
/// (`ON DELETE CASCADE`, enforced by `PRAGMA foreign_keys = ON` in
/// `database.dart`). Naturally idempotent: after the first run the predicate
/// matches nothing.
Future<void> deleteNullScopeLegacyConversations(AppDatabase db) async {
  await (db.delete(db.conversations)..where((t) => t.scopeKey.isNull())).go();
}

/// One-shot runner for [deleteNullScopeLegacyConversations]: a non-autoDispose
/// [FutureProvider] read (not watched) by [chatStoreProvider], so its DELETE
/// executes exactly once per container — first kicked on the build where the
/// account scope first becomes ready — and never again on later store
/// rebuilds (access flips, account switches, explicit invalidations). Its
/// completion also never rebuilds the store, because `ref.read` adds no
/// dependency. Tests await `.future` to observe the cleanup.
final nullScopeCleanupProvider = FutureProvider<void>((ref) {
  return deleteNullScopeLegacyConversations(ref.watch(databaseProvider));
});

/// Provides the [ChatStore] used to persist conversations and messages.
///
/// Scoped to the active account — the same `scope.storageId` tenant
/// `ManagedConversationRepository` writes (plan §5 decision 7), so the history
/// UI and the managed path share one store tenant. Non-autoDispose so a
/// conversation-family rebuild never disposes it.
///
/// Pre-scope gate: `pluginAccountScopeProvider` throws
/// `PluginReauthenticationRequired` while auth/settings are loading, errored,
/// or the scope is null. Instead of catching that throw ad hoc, the build
/// watches [pluginAccessProvider] and, while access is not
/// [PluginAccess.ready], yields an empty store scoped to [pendingScopeKey] —
/// `conversationsProvider`/`conversationProvider` render an empty history
/// instead of an error — then rebuilds into the real scoped store when access
/// flips to ready (its first ready build kicks `nullScopeCleanupProvider`).
final chatStoreProvider = Provider<ChatStore>((ref) {
  final db = ref.watch(databaseProvider);
  if (ref.watch(pluginAccessProvider) != PluginAccess.ready) {
    return DriftChatStore(db, scopeKey: pendingScopeKey);
  }
  // Access is ready ⇒ pluginAccountScopeProvider resolves without throwing.
  final scope = ref.watch(pluginAccountScopeProvider);
  ref.read(nullScopeCleanupProvider);
  return DriftChatStore(db, scopeKey: scope.storageId);
});

/// Provides the [FileStore] used to persist file attachment metadata.
final filesStoreProvider = Provider<FileStore>(
  (ref) => DriftFileStore(ref.watch(databaseProvider)),
);

/// Provides the [MemoryStore] used to persist and search memories.
final memoryStoreProvider = Provider<MemoryStore>(
  (ref) => DriftMemoryStore(ref.watch(databaseProvider)),
);
