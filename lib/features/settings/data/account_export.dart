import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/app_data_dir.dart';
import '../../chat/data/message_model.dart';

/// Result of a successful export: the document that was written and the path
/// it was written to.
class AccountExportResult {
  const AccountExportResult({required this.document, required this.path});

  final Map<String, Object?> document;
  final String path;
}

/// Builds the M12 account-export document: `{exportedAt, backendOrigin,
/// userId?, conversations}` — every field derived from local store schema
/// (no invented server fields). Conversations serialize through
/// `Conversation.toJson` (explicitToJson), so messages carry their toolCalls
/// in the same nested shape the store persists.
Map<String, Object?> buildAccountExportDocument({
  required List<Conversation> conversations,
  required String backendOrigin,
  String? userId,
  DateTime? exportedAt,
}) {
  return <String, Object?>{
    'exportedAt': (exportedAt ?? DateTime.now()).toIso8601String(),
    'backendOrigin': backendOrigin,
    if (userId != null && userId.isNotEmpty) 'userId': userId,
    'conversations': [for (final c in conversations) c.toJson()],
  };
}

/// Pretty-prints [document] as a readable JSON document (2-space indent).
String encodeAccountExport(Map<String, Object?> document) =>
    const JsonEncoder.withIndent('  ').convert(document);

/// Default writer: timestamped file under `<appDataDir>/exports/` — `data/app`
/// on a local dev build, the platform documents directory otherwise (see
/// [AppDataDir]). The app has no share_plus in its dependency set — `open_file`
/// + `path_provider` are the share/file-open capabilities that already exist,
/// so the export is saved and then opened with the platform opener by the
/// caller.
Future<String> writeAccountExportToDocuments(String encoded) async {
  final base = await AppDataDir.resolve();
  final dir = Directory('${base.path}/exports');
  await dir.create(recursive: true);
  final stamp = _timestampFor(DateTime.now());
  final file = File('${dir.path}/ai-assistant-export_$stamp.json');
  await file.writeAsString(encoded, flush: true);
  return file.path;
}

String _timestampFor(DateTime t) {
  String two(int v) => v.toString().padLeft(2, '0');
  return '${t.year}${two(t.month)}${two(t.day)}_'
      '${two(t.hour)}${two(t.minute)}${two(t.second)}';
}

/// Client-side conversation export (M12). The writer seam is injectable so
/// tests can capture the encoded document without touching the filesystem.
class AccountExporter {
  AccountExporter({required this.writeEncoded});

  /// Persists [encoded] and returns its path.
  final Future<String> Function(String encoded) writeEncoded;

  Future<AccountExportResult> export({
    required List<Conversation> conversations,
    required String backendOrigin,
    String? userId,
    DateTime? exportedAt,
  }) async {
    final document = buildAccountExportDocument(
      conversations: conversations,
      backendOrigin: backendOrigin,
      userId: userId,
      exportedAt: exportedAt,
    );
    final path = await writeEncoded(encodeAccountExport(document));
    return AccountExportResult(document: document, path: path);
  }
}

/// App-scoped exporter (documents-dir writer).
final accountExporterProvider = Provider<AccountExporter>(
  (ref) => AccountExporter(writeEncoded: writeAccountExportToDocuments),
);
