import 'dart:convert';

import 'package:drift/drift.dart';

import 'database.dart';
import 'message_model.dart';

/// Persistence contract for conversations and their messages.
abstract interface class ChatStore {
  /// Emits conversations ordered by most-recently-updated first.
  Stream<List<Conversation>> watchConversations();

  /// Returns a single conversation with its messages, or null when absent.
  Future<Conversation?> loadConversation(String id);

  /// Upserts the conversation row and all of its messages.
  Future<void> saveConversation(Conversation c);

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
  DriftChatStore(this._db);

  static const int maxConversations = 20;

  final AppDatabase _db;

  @override
  Stream<List<Conversation>> watchConversations() {
    final conversations = _db.select(_db.conversations)
      ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)]);
    return conversations.watch().asyncMap(
          (rows) => Future.wait(rows.map(_toConversation)),
        );
  }

  @override
  Future<Conversation?> loadConversation(String id) async {
    final row = await (_db.select(_db.conversations)
          ..where((t) => t.id.equals(id)))
        .getSingleOrNull();
    if (row == null) {
      return null;
    }
    return _toConversation(row);
  }

  @override
  Future<void> saveConversation(Conversation c) {
    return _db.transaction(() async {
      await _upsertConversation(c);
      for (final message in c.messages) {
        await _insertOrReplaceMessage(c.id, message);
      }
      await _enforceEviction();
    });
  }

  @override
  Future<void> appendMessage(String conversationId, Message m) {
    return _db.transaction(() async {
      await _insertOrReplaceMessage(conversationId, m);
      await _bumpConversation(conversationId, incrementCount: true);
      await _enforceEviction();
    });
  }

  @override
  Future<void> updateMessage(String conversationId, Message m) {
    return _db.transaction(() async {
      await _insertOrReplaceMessage(conversationId, m);
      await _bumpConversation(conversationId);
    });
  }

  @override
  Future<void> deleteMessage(String conversationId, String messageId) {
    return _db.transaction(() async {
      await (_db.delete(_db.messages)
            ..where((t) =>
                t.id.equals(messageId) &
                t.conversationId.equals(conversationId)))
          .go();
      final current = await (_db.select(_db.conversations)
            ..where((t) => t.id.equals(conversationId)))
          .getSingleOrNull();
      if (current != null && current.messageCount > 0) {
        await (_db.update(_db.conversations)
              ..where((t) => t.id.equals(conversationId)))
            .write(
          ConversationsCompanion(messageCount: Value(current.messageCount - 1)),
        );
      }
    });
  }

  @override
  Future<void> deleteConversation(String id) async {
    await (_db.delete(_db.conversations)..where((t) => t.id.equals(id))).go();
  }

  @override
  Future<void> deleteAll() async {
    await _db.transaction(() async {
      await _db.delete(_db.messages).go();
      await _db.delete(_db.conversations).go();
    });
  }

  Future<void> _upsertConversation(Conversation c) async {
    final row = ConversationRow(
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    );
    await _db.into(_db.conversations).insertOnConflictUpdate(row);
  }

  Future<void> _insertOrReplaceMessage(String conversationId, Message m) async {
    await _db.into(_db.messages).insertOnConflictUpdate(_messageToRow(conversationId, m));
  }

  Future<void> _bumpConversation(String conversationId, {bool incrementCount = false}) async {
    int? newCount;
    if (incrementCount) {
      final current = await (_db.select(_db.conversations)
            ..where((t) => t.id.equals(conversationId)))
          .getSingleOrNull();
      newCount = (current?.messageCount ?? 0) + 1;
    }
    await (_db.update(_db.conversations)..where((t) => t.id.equals(conversationId)))
        .write(ConversationsCompanion(
      updatedAt: Value(DateTime.now()),
      messageCount: newCount == null ? const Value.absent() : Value(newCount),
    ));
  }

  Future<Conversation> _toConversation(ConversationRow row) async {
    final messages = await (_db.select(_db.messages)
          ..where((t) => t.conversationId.equals(row.id))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
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
    final conversationIds = await (_db.selectOnly(_db.conversations)
          ..addColumns([_db.conversations.id]))
        .map((row) => row.read(_db.conversations.id))
        .get();
    final overflow = conversationIds.length - maxConversations;
    if (overflow <= 0) {
      return;
    }
    final idsToDelete = await (_db.select(_db.conversations)
          ..orderBy([(t) => OrderingTerm.desc(t.updatedAt)])
          ..limit(maxConversations, offset: maxConversations))
        .get();
    for (final row in idsToDelete.take(overflow)) {
      await deleteConversation(row.id);
    }
  }
}
