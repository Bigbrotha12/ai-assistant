import 'dart:convert';

import 'package:drift/drift.dart';

import './database.dart';
import './message_model.dart';

/// Persistence contract for conversations and their messages.
abstract interface class ChatStore {
  /// Emits conversations ordered by most-recently-updated first.
  Stream<List<Conversation>> watchConversations();

  /// Returns a single conversation with its messages, or null when absent.
  Future<Conversation?> loadConversation(String id);

  /// Upserts the conversation row and all of its messages.
  Future<void> saveConversation(Conversation c);

  /// Ensures the conversation row exists (creating it with [title] when
  /// absent — never overwriting an existing row's data) and appends
  /// [firstMessage]. Unlike [saveConversation] this is not a full-message-list
  /// overwrite, so concurrent first-turn writers on the same conversation id
  /// (chat + voice surfaces) can never clobber each other's messages.
  Future<void> ensureConversation(
    String id, {
    required String title,
    required Message firstMessage,
  });

  /// Inserts a message and bumps the conversation's updatedAt + messageCount.
  Future<void> appendMessage(String conversationId, Message m);

  /// Upserts a message row (streaming partials) and bumps updatedAt.
  Future<void> updateMessage(String conversationId, Message m);

  /// Deletes a single message within a conversation and decrements its
  /// messageCount when positive (e.g. removing a failed assistant placeholder
  /// before a retry).
  Future<void> deleteMessage(String conversationId, String messageId);

  /// Deletes a conversation; messages are removed via FK cascade.
  Future<void> deleteConversation(String id);

  /// Removes every conversation and message.
  Future<void> deleteAll();
}

/// Drift-backed [ChatStore].
class DriftChatStore implements ChatStore {
  DriftChatStore(this._db, {this.scopeKey});

  final String? scopeKey;

  Expression<bool> _scope(Conversations t) =>
      scopeKey == null ? t.scopeKey.isNull() : t.scopeKey.equals(scopeKey!);

  Future<void> _checkOwnership(String id) async {
    final row = await (_db.select(
      _db.conversations,
    )..where((t) => t.id.equals(id))).getSingleOrNull();
    if (row != null && row.scopeKey != scopeKey) {
      throw StateError('Conversation scope mismatch');
    }
  }

  static const int maxConversations = 20;

  final AppDatabase _db;

  @override
  Stream<List<Conversation>> watchConversations() {
    final conversations = _db.select(_db.conversations)
      ..where(_scope)
      ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)]);
    return conversations.watch().asyncMap(
      (rows) => Future.wait(rows.map(_toConversation)),
    );
  }

  @override
  Future<Conversation?> loadConversation(String id) async {
    final row = await (_db.select(
      _db.conversations,
    )..where((t) => t.id.equals(id))).getSingleOrNull();
    if (row == null || row.scopeKey != scopeKey) {
      return null;
    }
    return _toConversation(row);
  }

  @override
  Future<void> saveConversation(Conversation c) {
    return _db.transaction(() async {
      await _checkOwnership(c.id);
      await _upsertConversation(c);
      for (final message in c.messages) {
        await _insertOrReplaceMessage(c.id, message);
      }
      await _enforceEviction();
    });
  }

  @override
  Future<void> ensureConversation(
    String id, {
    required String title,
    required Message firstMessage,
  }) {
    return _db.transaction(() async {
      // Create the row only when absent (INSERT OR IGNORE): a concurrent
      // first-turn writer may have created it between the caller's
      // loadConversation and here, and its data must never be overwritten.
      await _checkOwnership(id);
      final now = DateTime.now();
      await _db
          .into(_db.conversations)
          .insert(
            ConversationRow(
              id: id,
              title: title,
              createdAt: now,
              updatedAt: now,
              messageCount: 0,
              scopeKey: scopeKey,
            ),
            mode: InsertMode.insertOrIgnore,
          );
      await _insertOrReplaceMessage(id, firstMessage);
      await _bumpConversation(id, incrementCount: true);
      await _enforceEviction();
    });
  }

  @override
  Future<void> appendMessage(String conversationId, Message m) {
    return _db.transaction(() async {
      await _checkOwnership(conversationId);
      await _insertOrReplaceMessage(conversationId, m);
      await _bumpConversation(conversationId, incrementCount: true);
      await _enforceEviction();
    });
  }

  @override
  Future<void> updateMessage(String conversationId, Message m) {
    return _db.transaction(() async {
      await _checkOwnership(conversationId);
      await _insertOrReplaceMessage(conversationId, m);
      await _bumpConversation(conversationId);
    });
  }

  @override
  Future<void> deleteMessage(String conversationId, String messageId) {
    return _db.transaction(() async {
      await _checkOwnership(conversationId);
      await (_db.delete(_db.messages)..where(
            (t) =>
                t.id.equals(messageId) &
                t.conversationId.equals(conversationId),
          ))
          .go();
      final current = await (_db.select(
        _db.conversations,
      )..where((t) => t.id.equals(conversationId))).getSingleOrNull();
      if (current != null && current.messageCount > 0) {
        await (_db.update(
          _db.conversations,
        )..where((t) => t.id.equals(conversationId))).write(
          ConversationsCompanion(messageCount: Value(current.messageCount - 1)),
        );
      }
    });
  }

  @override
  Future<void> deleteConversation(String id) async {
    await (_db.delete(
      _db.conversations,
    )..where((t) => t.id.equals(id) & _scope(t))).go();
  }

  @override
  Future<void> deleteAll() async {
    await _db.transaction(() async {
      await (_db.delete(_db.conversations)..where(_scope)).go();
    });
  }

  Future<void> _upsertConversation(Conversation c) async {
    final row = ConversationRow(
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      scopeKey: scopeKey,
    );
    await _db.into(_db.conversations).insertOnConflictUpdate(row);
  }

  Future<void> _insertOrReplaceMessage(String conversationId, Message m) async {
    await _db
        .into(_db.messages)
        .insertOnConflictUpdate(_messageToRow(conversationId, m));
  }

  Future<void> _bumpConversation(
    String conversationId, {
    bool incrementCount = false,
  }) async {
    int? newCount;
    if (incrementCount) {
      final current = await (_db.select(
        _db.conversations,
      )..where((t) => t.id.equals(conversationId))).getSingleOrNull();
      newCount = (current?.messageCount ?? 0) + 1;
    }
    await (_db.update(
      _db.conversations,
    )..where((t) => t.id.equals(conversationId))).write(
      ConversationsCompanion(
        updatedAt: Value(DateTime.now()),
        messageCount: newCount == null ? const Value.absent() : Value(newCount),
      ),
    );
  }

  Future<Conversation> _toConversation(ConversationRow row) async {
    final messages =
        await (_db.select(_db.messages)
              ..where((t) => t.conversationId.equals(row.id))
              // Order by the implicit monotonic rowid: drift stores DateTime as
              // unix-seconds integers (no store_date_time_values_as_text), so two
              // messages appended within the same second tie on createdAt and a
              // random-id tiebreaker would let the assistant reply sort BEFORE
              // its user message. rowid preserves exact append order.
              ..orderBy([(t) => OrderingTerm.asc(t.rowId)]))
            .get();
    return Conversation(
      id: row.id,
      title: row.title,
      messages: messages.map(_messageFromRow).toList(),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  MessageRow _messageToRow(String conversationId, Message m) => MessageRow(
    id: m.id,
    conversationId: conversationId,
    role: m.role.name,
    content: m.content,
    toolCalls: m.toolCalls == null
        ? null
        : jsonEncode(m.toolCalls!.map((c) => c.toJson()).toList()),
    toolCallId: m.toolCallId,
    createdAt: m.createdAt ?? DateTime.now(),
  );

  Message _messageFromRow(MessageRow row) {
    List<ToolCall>? toolCalls;
    final raw = row.toolCalls;
    if (raw != null && raw.isNotEmpty) {
      final decoded = jsonDecode(raw) as List<dynamic>;
      toolCalls = decoded
          .map((e) => ToolCall.fromJson(e as Map<String, dynamic>))
          .toList();
    }
    return Message(
      id: row.id,
      role: MessageRole.values.byName(row.role),
      content: row.content,
      toolCalls: toolCalls,
      toolCallId: row.toolCallId,
      createdAt: row.createdAt,
    );
  }

  Future<void> _enforceEviction() async {
    await _evictOldestConversations();
  }

  Future<void> _evictOldestConversations() async {
    final conversationIds =
        await (_db.selectOnly(_db.conversations)
              ..addColumns([_db.conversations.id])
              ..where(_scope(_db.conversations)))
            .map((row) => row.read(_db.conversations.id))
            .get();
    final overflow = conversationIds.length - maxConversations;
    if (overflow <= 0) {
      return;
    }
    final idsToDelete =
        await (_db.select(_db.conversations)
              ..where(_scope)
              ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
              ..limit(maxConversations, offset: maxConversations))
            .get();
    for (final row in idsToDelete.take(overflow)) {
      await deleteConversation(row.id);
    }
  }
}
