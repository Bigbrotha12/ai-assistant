import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_file/open_file.dart';

import '../data/files_providers.dart';
import '../data/files_service.dart';
import '../../chat/data/database_providers.dart';
import '../data/file_utils.dart';

/// A tap-to-open file reference rendered inside an assistant message.
///
/// Opening never uses url_launcher: the file is fetched through
/// [FilesClient.fetchFile], cached locally via [FileCache], and handed to
/// `open_file` — preserving the SSRF guard established in Phase 2 (internal
/// `http://host:17603/...` URLs are never launched externally).
class FileAttachmentChip extends ConsumerStatefulWidget {
  const FileAttachmentChip({
    super.key,
    required this.fileId,
    required this.filename,
    this.openFile,
  });

  /// Server-assigned file id.
  final String fileId;

  /// Display name; falls back to [fileId] when no filename context exists.
  final String filename;

  /// Injectable file opener so tests avoid real platform channels. Defaults to
  /// `open_file`'s cross-platform opener.
  final Future<void> Function(String path)? openFile;

  @override
  ConsumerState<FileAttachmentChip> createState() =>
      _FileAttachmentChipState();
}

enum _ChipPhase { idle, downloading, ready, error }

class _FileAttachmentChipState extends ConsumerState<FileAttachmentChip> {
  _ChipPhase _phase = _ChipPhase.idle;

  /// Size of the local file, shown in the ready state.
  int? _sizeBytes;

  String _error = '';

  /// The real MIME type of the file, resolved from the local [FileStore] when
  /// available. Bot-generated chips only carry a bare file id as the display
  /// name, so the filename alone cannot determine the type; the store (which
  /// records uploads with their real mime) can. Falls back to the filename.
  String? _resolvedMime;

  Future<String?> _resolveMime() async {
    try {
      final info = await ref.read(filesStoreProvider).getFileById(widget.fileId);
      if (info != null && info.mimeType.isNotEmpty) return info.mimeType;
    } catch (_) {
      // The store is best-effort metadata; fall through to the filename.
    }
    return null;
  }

  Future<void> _downloadAndOpen() async {
    if (_phase == _ChipPhase.downloading) return;
    setState(() {
      _phase = _ChipPhase.downloading;
      _error = '';
    });

    // NoOpFilesClient (no files secret configured) fails fast with a clear
    // message instead of surfacing a generic download error.
    if (ref.read(filesServiceProvider) is NoOpFilesClient) {
      if (!mounted) return;
      setState(() {
        _phase = _ChipPhase.error;
        _error = 'Files service not configured';
      });
      return;
    }

    final cache = ref.read(fileCacheProvider);
    try {
      // Resolve the real type up front so a freshly-downloaded file is cached
      // with its real extension (e.g. `.jpg`) instead of `.bin` — the OS open
      // handlers rely on that extension to pick an activity/UTI.
      final mime =
          _resolvedMime ??= (await _resolveMime()) ?? mimeForFilename(widget.filename);
      String path;
      final cached = await cache.getCached(widget.fileId);
      if (cached != null) {
        path = cached.localPath!;
        _sizeBytes = cached.sizeBytes;
      } else {
        final bytes = await ref
            .read(filesServiceProvider)
            .fetchFile(widget.fileId);
        path = await cache.cacheFile(
          widget.fileId,
          cache.extensionForMime(mime),
          bytes,
        );
        _sizeBytes = bytes.length;
      }
      if (!mounted) return;
      setState(() => _phase = _ChipPhase.ready);
      await _openPath(path);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _ChipPhase.error;
        _error = 'Failed to download';
      });
    }
  }

  Future<void> _openPath(String path) async {
    try {
      final open = widget.openFile;
      if (open != null) {
        await open(path);
      } else {
        // No explicit type: the OS derives it from the cached file's real
        // extension, matching the file-browser flow in files_screen.dart. An
        // explicit `application/octet-stream` type here would match no
        // activity/UTI and the file could never be opened.
        await OpenFile.open(path);
      }
    } catch (_) {
      // Best-effort: an open failure must not flip the chip into an error
      // state; the file is already cached and can be reopened with another tap.
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ActionChip(
          avatar: _avatar(scheme),
          label: Row(
            mainAxisSize: MainAxisSize.min,
            children: _labelChildren(scheme),
          ),
          labelStyle: TextStyle(fontSize: 13, color: scheme.onSurface),
          backgroundColor: scheme.surfaceContainerHigh,
          side: BorderSide(color: scheme.outlineVariant),
          visualDensity: VisualDensity.compact,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          onPressed: _phase == _ChipPhase.downloading ? null : _downloadAndOpen,
        ),
      ),
    );
  }

  Widget _avatar(ColorScheme scheme) => switch (_phase) {
        _ChipPhase.idle =>
          Icon(Icons.attach_file, size: 16, color: scheme.primary),
        _ChipPhase.downloading => const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        _ChipPhase.ready =>
          Icon(Icons.description, size: 16, color: scheme.primary),
        _ChipPhase.error =>
          Icon(Icons.error_outline, size: 16, color: scheme.error),
      };

  List<Widget> _labelChildren(ColorScheme scheme) => switch (_phase) {
        _ChipPhase.idle ||
        _ChipPhase.downloading ||
        _ChipPhase.ready => [
            Flexible(
              child: Text(
                widget.filename,
                overflow: TextOverflow.ellipsis,
              ),
            ),
if (_phase == _ChipPhase.ready && _sizeBytes != null) ...[
              const SizedBox(width: 6),
              Text(
                formatBytes(_sizeBytes!),
                style: TextStyle(
                  fontSize: 11,
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        _ChipPhase.error => [
            Flexible(
              child: Text(
                _error.isEmpty ? 'Failed to download' : _error,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              'Retry',
              style: TextStyle(fontSize: 12, color: scheme.primary),
            ),
          ],
      };
}