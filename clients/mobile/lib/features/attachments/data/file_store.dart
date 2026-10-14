import 'package:drift/drift.dart';

import '../../chat/data/database.dart';
import './file_model.dart';

/// Persistence contract for file attachment metadata.
abstract interface class FileStore {
  /// Upserts a file, optionally linking it to a conversation.
  Future<void> saveFile(FileInfo info, {String? conversationId});

  /// Returns a single file by id, or null when absent.
  Future<FileInfo?> getFileById(String id);

  /// Returns every file belonging to a conversation.
  Future<List<FileInfo>> listFilesForConversation(String conversationId);

  /// Returns every file across all conversations (including files with a
  /// null conversationId), for the file browser.
  Future<List<FileInfo>> listAllFiles();

  /// Deletes a single file row.
  Future<void> deleteFile(String id);

  /// Removes every file row owned by [scopeKey].
  Future<void> deleteAllForScope(String scopeKey);

  /// Returns the stored description for [fileId], or null when absent.
  Future<String?> descriptionFor(String fileId);

  /// Persists [description] for [fileId], replacing any existing value.
  Future<void> setDescription(String fileId, String description);
}

/// Drift-backed [FileStore].
class DriftFileStore implements FileStore {
  DriftFileStore(this._db, {required this.scopeKey});

  final AppDatabase _db;
  final String scopeKey;

  Expression<bool> _scope(Files t) => t.scopeKey.equals(scopeKey);

  Future<void> _checkConversationOwnership(String? conversationId) async {
    if (conversationId == null) return;
    final row = await (_db.select(
      _db.conversations,
    )..where((t) => t.id.equals(conversationId))).getSingleOrNull();
    if (row == null || row.scopeKey != scopeKey) {
      throw StateError('Conversation scope mismatch');
    }
  }

  void _checkScope(String targetScope) {
    if (targetScope != scopeKey) {
      throw StateError('File store scope mismatch');
    }
  }

  @override
  Future<void> saveFile(FileInfo info, {String? conversationId}) async {
    await _checkConversationOwnership(conversationId);
    await _db
        .into(_db.files)
        .insertOnConflictUpdate(_toRow(info, conversationId));
  }

  @override
  Future<FileInfo?> getFileById(String id) async {
    final row = await (_db.select(
      _db.files,
    )..where((t) => t.id.equals(id) & _scope(t))).getSingleOrNull();
    return row == null ? null : _fromRow(row);
  }

  @override
  Future<List<FileInfo>> listFilesForConversation(String conversationId) async {
    final rows = await (_db.select(
      _db.files,
    )..where((t) => t.conversationId.equals(conversationId) & _scope(t))).get();
    return rows.map(_fromRow).toList();
  }

  @override
  Future<List<FileInfo>> listAllFiles() async {
    final rows = await (_db.select(_db.files)..where(_scope)).get();
    return rows.map(_fromRow).toList();
  }

  @override
  Future<void> deleteFile(String id) async {
    await (_db.delete(
      _db.files,
    )..where((t) => t.id.equals(id) & _scope(t))).go();
  }

  @override
  Future<void> deleteAllForScope(String targetScope) async {
    _checkScope(targetScope);
    await (_db.delete(_db.files)..where(_scope)).go();
  }

  @override
  Future<String?> descriptionFor(String fileId) async {
    final row = await (_db.select(
      _db.files,
    )..where((t) => t.id.equals(fileId) & _scope(t))).getSingleOrNull();
    return row?.description;
  }

  @override
  Future<void> setDescription(String fileId, String description) async {
    await (_db.update(_db.files)..where((t) => t.id.equals(fileId) & _scope(t)))
        .write(FilesCompanion(description: Value(description)));
  }

  /// Mapping decision (per plan fix M15):
  ///
  /// `FileInfo.id` IS the server-assigned id. The `serverFileId` column stores
  /// the same value purely for future-proofing (in case a local-only id is
  /// ever introduced), so the local primary key remains the server id. The
  /// `localPath` column stores the relative cache path (possibly null when the
  /// file has not been downloaded). `createdAt` maps to `uploadedAt` and
  /// `updatedAt` maps to `cachedAt` — upload time is when the row is created;
  /// cache time is when its local copy was last written.
  FileRow _toRow(FileInfo info, String? conversationId) => FileRow(
    scopeKey: scopeKey,
    id: info.id,
    conversationId: conversationId,
    serverFileId: info.id,
    localPath: info.localPath ?? '',
    filename: info.filename,
    sizeBytes: info.sizeBytes,
    mimeType: info.mimeType,
    createdAt: info.uploadedAt ?? DateTime.now(),
    updatedAt: info.cachedAt ?? DateTime.now(),
  );

  FileInfo _fromRow(FileRow row) => FileInfo(
    id: row.id,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    uploadedAt: row.createdAt,
    cachedAt: row.updatedAt,
    localPath: row.localPath.isEmpty ? null : row.localPath,
  );
}
