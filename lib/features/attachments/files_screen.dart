import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_file/open_file.dart';

import '../../core/config.dart';
import '../../core/files_providers.dart';
import '../../core/files_service.dart';
import '../../core/settings_providers.dart';
import '../chat/database_providers.dart';
import 'file_model.dart';
import 'file_utils.dart';

/// Full-screen file browser (plan §3.12): a 2-column, virtualized grid of
/// every file known to the files service, enriched with local cache state.
///
/// Pushed from Settings via `Navigator.push(MaterialPageRoute(...))`. The
/// server list is the source of truth; local store rows and on-disk cache
/// entries only add `cachedAt`/`localPath` metadata. Internal URLs are never
/// handed to `url_launcher` (SSRF guard) — files are fetched through
/// [FilesClient] and opened with the `open_file` package.
class FilesScreen extends ConsumerStatefulWidget {
  const FilesScreen({super.key});

  @override
  ConsumerState<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends ConsumerState<FilesScreen> {
  bool _loading = true;
  bool _notConfigured = false;
  Object? _error;
  List<FileInfo> _files = const [];

  @override
  void initState() {
    super.initState();
    _initialLoad();
  }

  /// Initial (or full-screen retry) load: shows the centered spinner while
  /// fetching, then either the grid or an error/empty/not-configured state.
  Future<void> _initialLoad() async {
    setState(() {
      _loading = true;
      _error = null;
      _notConfigured = false;
    });
    await _refresh();
    if (!mounted) return;
    setState(() => _loading = false);
  }

  /// Reloads the file list without toggling the full-screen loader, so
  /// pull-to-refresh and post-action refreshes keep the grid visible.
  Future<void> _refresh() async {
    final service = ref.read(filesServiceProvider);
    if (service is NoOpFilesClient) {
      setState(() {
        _notConfigured = true;
        _error = null;
        _files = const [];
      });
      return;
    }
    try {
      final files = await _loadMerged(service);
      if (!mounted) return;
      setState(() {
        _files = files;
        _error = null;
        _notConfigured = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    }
  }

  /// Merges the server list (source of truth) with local metadata: the
  /// store's `cachedAt`/`localPath`, and — preferentially — the authoritative
  /// on-disk cache state (which verifies existence and TTL). Entries are
  /// ordered newest-first by upload (falling back to cache) date.
  Future<List<FileInfo>> _loadMerged(FilesClient service) async {
    final serverFiles = await service.listFiles();

    List<FileInfo> storeFiles = const [];
    try {
      storeFiles = await ref.read(filesStoreProvider).listAllFiles();
    } catch (_) {
      // Local metadata is best-effort; the server list still renders.
    }
    final storeById = {for (final f in storeFiles) f.id: f};
    final cache = ref.read(fileCacheProvider);
    // One directory listing for every server file instead of an N+1
    // `getCached` scan per id (each of which would re-list the cache dir).
    Map<String, FileInfo> cachedById;
    try {
      cachedById = await cache.getAllCached();
    } catch (_) {
      // A cache lookup must never fail the whole listing.
      cachedById = const {};
    }

    final merged = <FileInfo>[];
    for (final server in serverFiles) {
      final fromStore = storeById[server.id];
      final cached = cachedById[server.id];
      merged.add(server.copyWith(
        uploadedAt: server.uploadedAt ?? fromStore?.uploadedAt,
        cachedAt: cached?.cachedAt ?? fromStore?.cachedAt,
        localPath: cached?.localPath ?? fromStore?.localPath ?? server.localPath,
      ));
    }
    merged.sort((a, b) {
      final dateA = a.uploadedAt ?? a.cachedAt;
      final dateB = b.uploadedAt ?? b.cachedAt;
      return (dateB ?? DateTime.fromMillisecondsSinceEpoch(0))
          .compareTo(dateA ?? DateTime.fromMillisecondsSinceEpoch(0));
    });
    return merged;
  }

  Future<void> _deleteFile(FileInfo file) async {
    try {
      await ref.read(filesServiceProvider).deleteFile(file.id);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not delete file')),
      );
      return;
    }
    try {
      await ref.read(filesStoreProvider).deleteFile(file.id);
    } catch (_) {
      // The server deletion is authoritative; ignore local cleanup errors.
    }
    await ref.read(fileCacheProvider).evict(file.id);
    await _refresh();
  }

  Future<void> _copyLink(FileInfo file) async {
    final settings = ref.read(settingsProvider).value;
    final host = settings?.host ?? BackendConfig.defaultHost;
    final url =
        '${BackendConfig.files(host, environment: settings?.environment).toString()}/fetch/${file.id}';
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Link copied')),
    );
  }

  Future<void> _clearCache() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear Cache'),
        content: const Text('Remove all downloaded files from this device?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final cache = ref.read(fileCacheProvider);
    // Plan §3.14 wires this to evictExpired(). We also evict every listed file
    // so the action clears *all* downloaded files (satisfying UX), not just the
    // expired ones; anything still on disk is swept later by TTL/size cap.
    await cache.evictExpired();
    for (final file in _files) {
      await cache.evict(file.id);
    }
    await _refresh();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Cache cleared')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Files'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _loading ? null : _initialLoad,
          ),
          IconButton(
            icon: const Icon(Icons.delete_sweep_outlined),
            tooltip: 'Clear Cache',
            onPressed: _loading ? null : _clearCache,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_notConfigured) {
      return const _NotConfiguredView();
    }
    if (_error != null) {
      return _ErrorView(onRetry: _initialLoad);
    }
    if (_files.isEmpty) {
      return _EmptyView(onGoToChat: () => Navigator.of(context).pop());
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.all(12),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 1.0,
              ),
              delegate: SliverChildBuilderDelegate(
                (context, index) => _FileTile(
                  key: ValueKey(_files[index].id),
                  file: _files[index],
                  onDelete: _deleteFile,
                  onCopyLink: _copyLink,
                ),
                childCount: _files.length,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown when the files service is unconfigured (the provider yields a
/// [NoOpFilesClient]): the service exists but has no bearer secret, so the
/// browser has nothing authoritative to list.
class _NotConfiguredView extends StatelessWidget {
  const _NotConfiguredView();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 56, color: scheme.onSurfaceVariant),
            const SizedBox(height: 16),
            Text(
              'Files service not configured',
              style: Theme.of(context).textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              'Set the files secret in Settings to browse uploaded files.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown when the service is configured and reachable but has no files.
class _EmptyView extends StatelessWidget {
  const _EmptyView({required this.onGoToChat});

  final VoidCallback onGoToChat;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.folder_open, size: 56, color: scheme.onSurfaceVariant),
          const SizedBox(height: 16),
          Text(
            'No files uploaded yet',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: onGoToChat,
            icon: const Icon(Icons.chat_bubble_outline),
            label: const Text('Go to Chat'),
          ),
        ],
      ),
    );
  }
}

/// Shown when listing fails; Retry re-runs the full initial load.
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 56, color: scheme.error),
          const SizedBox(height: 16),
          Text(
            'Could not load files',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

enum _TileAction { delete, copyLink }

/// A single 2-column grid tile: a thumbnail resized client-side (plan fix M8),
/// the filename, size and date. Tap downloads (if needed) then opens with
/// `open_file`; long-press shows a Delete / Copy Link sheet.
class _FileTile extends ConsumerStatefulWidget {
  const _FileTile({
    super.key,
    required this.file,
    required this.onDelete,
    required this.onCopyLink,
  });

  final FileInfo file;
  final FutureOr<void> Function(FileInfo) onDelete;
  final FutureOr<void> Function(FileInfo) onCopyLink;

  @override
  ConsumerState<_FileTile> createState() => _FileTileState();
}

class _FileTileState extends ConsumerState<_FileTile> {
  bool _downloading = false;

  /// Absolute path of a file downloaded this session; may outlive [file].
  String? _downloadedPath;

  String? get _displayPath => _downloadedPath ?? widget.file.localPath;

  bool get _isImage => widget.file.mimeType.startsWith('image/');

  bool get _hasLocalFile {
    final path = _displayPath;
    return path != null && File(path).existsSync();
  }

  DateTime? get _date => widget.file.uploadedAt ?? widget.file.cachedAt;

  Future<void> _open() async {
    if (_downloading) return;
    final path = _displayPath;
    if (path != null && File(path).existsSync()) {
      await _launch(path);
      return;
    }
    setState(() => _downloading = true);
    try {
      final data =
          await ref.read(filesServiceProvider).fetchFile(widget.file.id);
      final cache = ref.read(fileCacheProvider);
      final absPath = await cache.cacheFile(
        widget.file.id,
        cache.extensionForMime(widget.file.mimeType),
        data,
      );
      if (!mounted) return;
      setState(() {
        _downloadedPath = absPath;
        _downloading = false;
      });
      await _launch(absPath);
    } catch (_) {
      if (!mounted) return;
      setState(() => _downloading = false);
      _snack('Could not open ${widget.file.filename}');
    }
  }

  Future<void> _launch(String path) async {
    try {
      final result = await OpenFile.open(path);
      if (result.type != ResultType.done && mounted) {
        _snack('Could not open ${widget.file.filename}');
      }
    } catch (_) {
      if (!mounted) return;
      _snack('Could not open ${widget.file.filename}');
    }
  }

  void _snack(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _showActions() async {
    final action = await showModalBottomSheet<_TileAction>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('Delete'),
              onTap: () => Navigator.of(sheetContext).pop(_TileAction.delete),
            ),
            ListTile(
              leading: const Icon(Icons.link),
              title: const Text('Copy Link'),
              onTap: () => Navigator.of(sheetContext).pop(_TileAction.copyLink),
            ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case _TileAction.delete:
        widget.onDelete(widget.file);
      case _TileAction.copyLink:
        await widget.onCopyLink(widget.file);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final date = _date;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: _open,
        onLongPress: _showActions,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: SizedBox(
                width: double.infinity,
                child: _thumbnail(scheme),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.file.filename,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${formatBytes(widget.file.sizeBytes)}'
                    '${date != null ? ' · ${_formatDate(date)}' : ''}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _thumbnail(ColorScheme scheme) {
    if (_downloading) {
      return Container(
        color: scheme.surfaceContainerHighest,
        alignment: Alignment.center,
        child: const CircularProgressIndicator(),
      );
    }
    if (_isImage && _hasLocalFile) {
      // cacheWidth resizes client-side so the grid never decodes full-size
      // images (plan fix M8). A missing/corrupt file falls back to the
      // placeholder via errorBuilder.
      return Image.file(
        File(_displayPath!),
        fit: BoxFit.cover,
        cacheWidth: 120,
        errorBuilder: (_, _, _) => _placeholder(scheme),
      );
    }
    return _placeholder(scheme);
  }

  Widget _placeholder(ColorScheme scheme) {
    return Container(
      color: scheme.surfaceContainerHighest,
      alignment: Alignment.center,
      child: Icon(
        _isImage ? Icons.image_outlined : Icons.insert_drive_file_outlined,
        color: scheme.onSurfaceVariant,
        size: 36,
      ),
    );
  }
}

const List<String> _kMonths = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

String _formatDate(DateTime date) {
  final local = date.toLocal();
  return '${_kMonths[local.month - 1]} ${local.day}, ${local.year}';
}