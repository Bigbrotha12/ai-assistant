import 'dart:convert';

import 'package:dio/dio.dart' show CancelToken;
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/chat_store.dart';
import '../../chat/data/database.dart';
import '../../chat/data/database_providers.dart';
import '../../chat/data/message_model.dart';
import 'plugin_http.dart';

/// Account-scoped persistence for managed conversations: the local Drift
/// history (via scoped [DriftChatStore] instances), the raw public session-id
/// mapping, and the pending-turn row that makes a send retryable without a
/// second inference.
class ManagedConversationRepository {
  ManagedConversationRepository(this.db);

  final AppDatabase db;
  final _epochs = <String, int>{};
  final _tokens = <String, Set<CancelToken>>{};

  /// Per-conversation in-flight dispatch token, keyed by
  /// `scope.storageId|conversationId`. Lets [abandonTurn] cancel exactly one
  /// turn's stream WITHOUT an epoch bump (a scope-wide cancel would make the
  /// abandon's own guarded write throw and leave the pending row wedged).
  final _dispatchTokens = <String, CancelToken>{};
  Future<void> _queue = Future.value();

  static String _dispatchKey(AuthAccountScope scope, String conversationId) =>
      '${scope.storageId}|$conversationId';

  /// Monotonic per-scope epoch: bumped by [cancelScope] / [clearScope]. Any
  /// access captured before the bump throws 'cancelled', which is how a late
  /// stream completion after logout loses its write.
  int epoch(AuthAccountScope scope) => _epochs[scope.storageId] ?? 0;

  CancelToken register(AuthAccountScope scope) {
    final token = CancelToken();
    _tokens.putIfAbsent(scope.storageId, () => {}).add(token);
    return token;
  }

  void unregister(AuthAccountScope scope, CancelToken token) {
    _tokens[scope.storageId]?.remove(token);
  }

  /// Registers the in-flight dispatch token for [conversationId] so
  /// [takeDispatch] can cancel exactly this turn's stream on abandon. The
  /// token is ALSO in the scope-wide set, so [cancelScope] still cancels it
  /// on logout. Any previous dispatch for the same conversation is cancelled
  /// (one pending turn per conversation).
  CancelToken registerDispatch(AuthAccountScope scope, String conversationId) {
    final token = register(scope);
    final key = _dispatchKey(scope, conversationId);
    final previous = _dispatchTokens.remove(key);
    if (previous != null) {
      _tokens[scope.storageId]?.remove(previous);
      previous.cancel();
    }
    _dispatchTokens[key] = token;
    return token;
  }

  /// Cancels and removes the conversation's in-flight dispatch token (if
  /// any), returning it. Does NOT bump the epoch — abandon must stay able to
  /// write under the current one.
  CancelToken? takeDispatch(AuthAccountScope scope, String conversationId) {
    final token = _dispatchTokens.remove(_dispatchKey(scope, conversationId));
    if (token == null) return null;
    _tokens[scope.storageId]?.remove(token);
    token.cancel();
    return token;
  }

  /// Identity-guarded remove: only drops the map entry when it still points
  /// at [token] (a nested re-establish may have registered a newer one).
  void clearDispatch(
    AuthAccountScope scope,
    String conversationId,
    CancelToken token,
  ) {
    final key = _dispatchKey(scope, conversationId);
    if (identical(_dispatchTokens[key], token)) {
      _dispatchTokens.remove(key);
    }
  }

  /// Cancels in-flight sends for [scope] and invalidates all queued local
  /// writes (they will throw). Does not delete data by itself.
  void cancelScope(AuthAccountScope scope) {
    _epochs[scope.storageId] = epoch(scope) + 1;
    for (final token in _tokens.remove(scope.storageId) ?? <CancelToken>{}) {
      token.cancel();
    }
    final prefix = '${scope.storageId}|';
    _dispatchTokens.removeWhere((key, _) => key.startsWith(prefix));
  }

  /// Serializes one scope-checked store operation on the shared DB.
  Future<T> access<T>(
    AuthAccountScope scope,
    int epoch,
    void Function() check,
    Future<T> Function(DriftChatStore store) work,
  ) {
    void guard() {
      check();
      if (this.epoch(scope) != epoch) {
        throw const PluginClientException('cancelled');
      }
    }

    final result = _queue.then(
      (_) => db.transaction(() async {
        guard();
        // Await the work before the final guard: a synchronous guard would
        // validate the epoch after the write was merely *initiated*, letting a
        // clear that raced the in-flight operation still see the write land.
        final value = await work(DriftChatStore(db, scopeKey: scope.storageId));
        guard();
        return value;
      }),
    );
    _queue = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// Epoch-bumped delete of the scope's conversations (messages cascade via
  /// FK) plus its pending rows — the logout integrator's clear hook.
  Future<void> clearScope(AuthAccountScope scope) {
    final next = epoch(scope) + 1;
    _epochs[scope.storageId] = next;
    final prefix = '${scope.storageId}|';
    _dispatchTokens.removeWhere((key, _) => key.startsWith(prefix));
    return access(scope, next, () {}, (store) async {
      await (db.delete(
        db.managedPendingTurns,
      )..where((t) => t.scopeKey.equals(scope.storageId))).go();
      await store.deleteAll();
    });
  }

  Future<ManagedPendingTurnRow?> pending(AuthAccountScope scope, String id) =>
      (db.select(db.managedPendingTurns)..where(
            (t) =>
                t.conversationId.equals(id) &
                t.scopeKey.equals(scope.storageId),
          ))
          .getSingleOrNull();

  /// Every pending-turn row for [scope] across all conversations. Used by the
  /// foreground re-watch (plan P3) to enumerate still-pending background jobs.
  Future<List<ManagedPendingTurnRow>> pendingRows(AuthAccountScope scope) =>
      (db.select(db.managedPendingTurns)..where(
            (t) => t.scopeKey.equals(scope.storageId),
          ))
          .get();

  Future<void> savePending(
    String id,
    AuthAccountScope scope,
    String messageId,
    Map<String, dynamic> envelope, {
    bool reconcileOnly = false,
  }) => db
      .into(db.managedPendingTurns)
      .insert(
        ManagedPendingTurnsCompanion.insert(
          conversationId: id,
          scopeKey: scope.storageId,
          messageId: messageId,
          envelope: jsonEncode(envelope),
          reconcileOnly: Value(reconcileOnly),
        ),
        mode: InsertMode.insertOrReplace,
      );

  /// Compare-and-delete of a pending turn. When [messageId] is given only the
  /// row still owned by that exact turn is removed, so a completion for an
  /// earlier turn can never delete a newer pending row (clear used to match
  /// scope + conversation only).
  Future<void> clearPending(
    AuthAccountScope scope,
    String id, {
    String? messageId,
  }) {
    final query = db.delete(db.managedPendingTurns)..where(
      (t) => t.conversationId.equals(id) & t.scopeKey.equals(scope.storageId),
    );
    if (messageId != null) {
      query.where((t) => t.messageId.equals(messageId));
    }
    return query.go();
  }

  Future<String?> mappedSession(String conversationId) async {
    final row = await (db.select(
      db.conversations,
    )..where((t) => t.id.equals(conversationId))).getSingleOrNull();
    return row?.sessionId;
  }

  Future<void> mapSession(String conversationId, String sessionId) =>
      (db.update(db.conversations)..where((t) => t.id.equals(conversationId)))
          .write(ConversationsCompanion(sessionId: Value(sessionId)));

  /// Drops a stale public session-id mapping (server-side session gone) so the
  /// next send mints a fresh session. Local history is untouched.
  Future<void> clearSessionMapping(String conversationId) =>
      (db.update(db.conversations)..where((t) => t.id.equals(conversationId)))
          .write(ConversationsCompanion(sessionId: const Value(null)));

  /// Swaps the conversation's local history for the server's messages under a
  /// transaction, bumps updatedAt, and clears pending state. Called only after
  /// a successful [LangChainClient.loadSession]; rethrow surfaces reseed 409s.
  /// [expectedMessageId] narrows the pending delete to the turn being
  /// reconciled so a concurrent newer turn is never cleared.
  Future<void> replaceHistory(
    AuthAccountScope scope,
    DriftChatStore store,
    Conversation previous,
    String sessionId,
    List<Message> messages, {
    String? expectedMessageId,
  }) async {
    await (db.delete(
      db.messages,
    )..where((t) => t.conversationId.equals(previous.id))).go();
    await store.saveConversation(
      previous.copyWith(updatedAt: DateTime.now(), messages: List.of(messages)),
    );
    await mapSession(previous.id, sessionId);
    await clearPending(scope, previous.id, messageId: expectedMessageId);
  }
}

/// App-scoped [ManagedConversationRepository] over the shared database. Kept at
/// the account-lifecycle level (not per staged adapter) so logout can drop the
/// scope's local conversations even when no adapter instance is alive.
final managedConversationRepositoryProvider =
    Provider<ManagedConversationRepository>((ref) {
      return ManagedConversationRepository(ref.watch(databaseProvider));
    });
