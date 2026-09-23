import 'dart:async';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/ui/chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_catalog_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../fakes.dart';

AuthCredentials _credentials(String owner, {String key = 'gateway-secret'}) =>
    AuthCredentials(
      apiKey: key,
      ownerId: owner,
      backendOrigin: 'http://example.com:17600',
    );

/// Auth store whose [load] blocks on [gate], holding plugin access in
/// `loading` until the test releases it.
class _GatedAuthCredentialsStore implements AuthCredentialsStore {
  _GatedAuthCredentialsStore(this.stored, this.gate);

  AuthCredentials? stored;
  final Completer<void> gate;

  @override
  Future<AuthCredentials?> load() async {
    await gate.future;
    return stored;
  }

  @override
  Future<void> save(AuthCredentials credentials) async {
    stored = credentials;
  }

  @override
  Future<void> clear() async {
    stored = null;
  }
}

ProviderContainer _container(AppDatabase db, {required AuthCredentialsStore authStore}) {
  final container = ProviderContainer(
    overrides: [
      authCredentialsStoreProvider.overrideWithValue(authStore),
      settingsStoreProvider.overrideWithValue(
        FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
      ),
      databaseProvider.overrideWithValue(db),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

Future<ProviderContainer> _readyContainer(AppDatabase db) async {
  final container = _container(
    db,
    authStore: FakeAuthCredentialsStore(stored: _credentials('a')),
  );
  await container.read(authCredentialsProvider.future);
  await container.read(settingsProvider.future);
  return container;
}

Conversation _conversation(String id, {List<Message> messages = const []}) =>
    Conversation(
      id: id,
      title: id,
      messages: messages,
      createdAt: DateTime(2024, 1, 1),
      updatedAt: DateTime(2024, 1, 1),
    );

Message _message(String id, String content) => Message(
  id: id,
  role: MessageRole.user,
  content: content,
  createdAt: DateTime(2024, 1, 1),
);

void main() {
  late AppDatabase db;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    addTearDown(() => db.close());
  });

  test(
    'while access is loading, chatStoreProvider gates to an empty sentinel '
    'store instead of throwing PluginReauthenticationRequired',
    () async {
      final gate = Completer<void>();
      final container = _container(
        db,
        authStore: _GatedAuthCredentialsStore(_credentials('a'), gate),
      );

      // Reading the store must not forward the scope provider's re-auth
      // throw into the history graph.
      final store = container.read(chatStoreProvider);
      expect(store, isA<DriftChatStore>());
      expect((store as DriftChatStore).scopeKey, pendingScopeKey);
      expect(container.read(pluginAccessProvider), PluginAccess.loading);
      // Nothing was ready yet, so the one-shot cleanup has not run.
      expect(container.exists(nullScopeCleanupProvider), isFalse);

      // History resolves to an empty list — no error surface at all.
      final sub = container.listen(conversationsProvider, (_, _) {});
      addTearDown(sub.close);
      await container.read(conversationsProvider.future);
      final rows = container.read(conversationsProvider);
      expect(rows.hasError, isFalse);
      expect(rows.value, isEmpty);
    },
  );

  test(
    'when access flips to ready, chatStoreProvider rebuilds into the store '
    'scoped to scope.storageId and kicks the one-shot cleanup',
    () async {
      final gate = Completer<void>();
      final container = _container(
        db,
        authStore: _GatedAuthCredentialsStore(_credentials('a'), gate),
      );

      final gated = container.read(chatStoreProvider) as DriftChatStore;
      expect(gated.scopeKey, pendingScopeKey);
      expect(container.exists(nullScopeCleanupProvider), isFalse);

      gate.complete();
      await container.read(authCredentialsProvider.future);
      await container.read(settingsProvider.future);

      expect(container.read(pluginAccessProvider), PluginAccess.ready);
      final scope = container.read(pluginAccountScopeProvider);
      final ready = container.read(chatStoreProvider) as DriftChatStore;
      expect(ready.scopeKey, scope.storageId);
      // The first ready build kicked the one-shot cleanup.
      expect(container.exists(nullScopeCleanupProvider), isTrue);
    },
  );

  test(
    'one-shot cleanup deletes null-scope legacy rows once, keeps scoped rows, '
    'does not re-fire on rebuild, and stays idempotent',
    () async {
      final container = await _readyContainer(db);
      final scope = container.read(pluginAccountScopeProvider);

      // Legacy rows from the old unscoped UI path (scope_key IS NULL), one
      // with a message that must cascade away with it.
      await DriftChatStore(db).saveConversation(
        _conversation('legacy', messages: [_message('m-legacy', 'old')]),
      );
      await DriftChatStore(db, scopeKey: scope.storageId).saveConversation(
        _conversation('kept', messages: [_message('m-kept', 'hi')]),
      );

      // Nothing has read the ready store yet → cleanup never started.
      expect(container.exists(nullScopeCleanupProvider), isFalse);

      // First ready read kicks the one-shot cleanup.
      final store = container.read(chatStoreProvider);
      expect((store as DriftChatStore).scopeKey, scope.storageId);
      await container.read(nullScopeCleanupProvider.future);

      final afterFirst = await db.select(db.conversations).get();
      expect(afterFirst.map((r) => r.id).toSet(), {'kept'});
      // Messages cascade via the conversations FK — none orphaned.
      final remainingMessages = await db.select(db.messages).get();
      expect(remainingMessages.map((m) => m.id).toList(), ['m-kept']);

      // A chatStoreProvider rebuild must not re-fire the cleanup: a
      // null-scope row inserted after the one-shot ran survives a rebuild.
      await DriftChatStore(db).saveConversation(_conversation('late-null'));
      container.invalidate(chatStoreProvider);
      container.read(chatStoreProvider);
      await Future<void>.delayed(Duration.zero);
      final late =
          await (db.select(db.conversations)..where(
                (t) => t.id.equals('late-null'),
              ))
              .get();
      expect(late, hasLength(1));

      // The named cleanup path stays idempotent when invoked again directly.
      await deleteNullScopeLegacyConversations(db);
      await deleteNullScopeLegacyConversations(db);
      final finalRows = await db.select(db.conversations).get();
      expect(finalRows.map((r) => r.id).toSet(), {'kept'});
    },
  );

  test(
    'a fresh save through the account-scoped store stamps '
    'scope_key = storageId (no new null-scope rows)',
    () async {
      final container = await _readyContainer(db);
      final store = container.read(chatStoreProvider);
      final scope = container.read(pluginAccountScopeProvider);

      await store.saveConversation(
        _conversation('fresh', messages: [_message('m1', 'hello')]),
      );

      final row =
          await (db.select(db.conversations)..where(
                (t) => t.id.equals('fresh'),
              ))
              .getSingle();
      expect(row.scopeKey, isNotNull);
      expect(row.scopeKey, scope.storageId);
    },
  );
}
