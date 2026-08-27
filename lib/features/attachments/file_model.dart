import 'package:dio/dio.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
// ignore: unnecessary_import
import 'package:json_annotation/json_annotation.dart';

import 'file_utils.dart';

part 'file_model.freezed.dart';
part 'file_model.g.dart';

/// Lifecycle of a queued upload.
enum UploadStatus { pending, uploading, done, failed }

/// A file the user picked for upload. [path] is the local filesystem path
/// (e.g. `XFile.path`), never a `file://` URI.
class AttachmentDraft {
  const AttachmentDraft({
    required this.path,
    required this.filename,
    required this.sizeBytes,
    required this.mimeType,
  });

  final String path;
  final String filename;
  final int sizeBytes;
  final String mimeType;
}

/// Server- or cache-backed metadata for a single file.
///
/// [localPath] is the on-disk path under the cache root (absolute when read
/// back from [FileCache.getCached], relative when persisted). There is no
/// `serverUrl` field: the download URL is computed from the configured host at
/// runtime so it can never go stale when the host changes.
@freezed
abstract class FileInfo with _$FileInfo {
  // ignore: invalid_annotation_target
  @JsonSerializable(explicitToJson: true)
  const factory FileInfo({
    required String id,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    DateTime? uploadedAt,
    DateTime? cachedAt,
    String? localPath,
  }) = _FileInfo;

  factory FileInfo.fromJson(Map<String, dynamic> json) => _$FileInfoFromJson(json);
}

/// Immutable snapshot of an upload's state, attached to a chat message so the
/// UI can render per-message upload progress.
class UploadJobStatus {
  const UploadJobStatus({
    required this.jobId,
    required this.status,
    required this.progress,
    this.error,
    this.serverFileId,
    this.uri,
  });

  final String jobId;
  final UploadStatus status;
  final double progress;
  final String? error;
  final String? serverFileId;

  /// Local path of the uploaded file (the [AttachmentDraft.path] the job was
  /// enqueued with). Lets the UI map a draft back to its job's status.
  final String? uri;

  UploadJobStatus copyWith({
    String? jobId,
    UploadStatus? status,
    double? progress,
    String? error,
    String? serverFileId,
    String? uri,
  }) =>
      UploadJobStatus(
        jobId: jobId ?? this.jobId,
        status: status ?? this.status,
        progress: progress ?? this.progress,
        error: error ?? this.error,
        serverFileId: serverFileId ?? this.serverFileId,
        uri: uri ?? this.uri,
      );

  @override
  bool operator ==(Object other) =>
      other is UploadJobStatus &&
      other.jobId == jobId &&
      other.status == status &&
      other.progress == progress &&
      other.error == error &&
      other.serverFileId == serverFileId &&
      other.uri == uri;

  @override
  int get hashCode => Object.hash(jobId, status, progress, error, serverFileId, uri);
}

/// Mutable, transient state for a single queued upload. Not serialized.
class UploadJob {
  UploadJob({
    required this.id,
    required this.uri,
    required this.filename,
    required this.sizeBytes,
    required this.mimeType,
    this.status = UploadStatus.pending,
    this.progress = 0,
    this.error,
    this.serverFileId,
    this.cancelToken,
  });

  final String id;
  final String uri;
  final String filename;
  final int sizeBytes;
  final String mimeType;
  UploadStatus status;
  double progress;
  String? error;
  String? serverFileId;
  CancelToken? cancelToken;
}

String _extensionFor(String? mimeType) =>
    mimeType == null ? '' : (knownExtensionForMime(mimeType) ?? '');

/// Sanitizes a client-supplied filename before upload: strips path separators,
/// null bytes and control characters, collapses spaces to underscores, caps
/// the length at 128 characters, and appends a MIME-derived extension when the
/// name has none. Cosmetic only — the server is the source of truth.
String sanitizeFilename(String name, {String? mimeType}) {
  var out = name.trim();
  out = out.replaceAll(RegExp(r'[/\\]+'), '_');
  out = out.replaceAll('\u0000', '');
  out = out.replaceAll(RegExp(r'[\x00-\x1F\x7F]'), '');
  out = out.replaceAll(' ', '_');
  final ext = _extensionFor(mimeType);
  if (out.isEmpty) {
    return ext.isEmpty ? 'file' : 'file$ext';
  }
  if (ext.isNotEmpty && !out.toLowerCase().endsWith(ext)) {
    if (out.length + ext.length > 128) {
      out = out.substring(0, 128 - ext.length);
    }
    return '$out$ext';
  }
  if (out.length > 128) {
    out = out.substring(0, 128);
  }
  return out;
}
