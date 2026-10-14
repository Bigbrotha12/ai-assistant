import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../data/file_model.dart';
import '../data/file_utils.dart';

/// Maximum number of files a single message may carry.
const int kMaxAttachmentsPerMessage = 5;

/// Horizontal, scrollable strip of the files selected for the next message:
/// one thumbnail per [AttachmentDraft] (with an upload-status overlay and a
/// remove button) plus a trailing add (+) button that opens the platform
/// picker.
///
/// The row is *controlled*: the parent owns the current [attachments] list and
/// receives every mutation through [onChanged]. Status overlays are purely
/// visual — [uploadStatus] is keyed by job id, and [draftToJobId] maps a
/// draft's [AttachmentDraft.path] to its job id. Drafts without a mapped job
/// (i.e. anything still being composed) show no overlay.
class AttachmentRow extends StatefulWidget {
  const AttachmentRow({
    super.key,
    required this.attachments,
    required this.onChanged,
    required this.uploadStatus,
    this.draftToJobId = const {},
    this.picker,
    this.enabled = true,
    this.maxFiles = kMaxAttachmentsPerMessage,
  });

  /// The currently selected files, owned by the parent.
  final List<AttachmentDraft> attachments;

  /// Reports pick / remove mutations; the parent should store the new list and
  /// rebuild with it.
  final ValueChanged<List<AttachmentDraft>> onChanged;

  /// Live upload state, keyed by job id. Consumed only for the overlay.
  final ValueListenable<Map<String, UploadJobStatus>> uploadStatus;

  /// Maps [AttachmentDraft.path] -> job id, letting the row look up the
  /// matching [UploadJobStatus] for a draft.
  final Map<String, String> draftToJobId;

  /// Injectable picker; defaults to a real [ImagePicker]. Tests pass a fake.
  final ImagePicker? picker;

  /// Disables the add button (e.g. when the files service is not configured).
  final bool enabled;

  /// Hard cap on the number of files per message.
  final int maxFiles;

  @override
  State<AttachmentRow> createState() => _AttachmentRowState();
}

class _AttachmentRowState extends State<AttachmentRow> {
  late final ImagePicker _picker = widget.picker ?? ImagePicker();

  bool get _galleryAvailable =>
      _picker.supportsImageSource(ImageSource.gallery);
  bool get _cameraAvailable =>
      _picker.supportsImageSource(ImageSource.camera);
  bool get _nothingAvailable => !_galleryAvailable && !_cameraAvailable;
  bool get _atMax => widget.attachments.length >= widget.maxFiles;
  bool get _addEnabled => widget.enabled && !_atMax && !_nothingAvailable;

  String get _addTooltip {
    if (!widget.enabled) return 'Files service not configured';
    if (_atMax) return 'Max ${widget.maxFiles} files per message';
    if (_nothingAvailable) return 'No files available';
    return 'Add file';
  }

  ImageSource? _availableSource() {
    if (_galleryAvailable) return ImageSource.gallery;
    if (_cameraAvailable) return ImageSource.camera;
    return null;
  }

  Future<void> _addFile() async {
    final source = _availableSource();
    if (source == null) return;
    final XFile? picked;
    try {
      picked = await _picker.pickImage(
        source: source,
        maxWidth: 1920,
        imageQuality: 80,
      );
    } on PlatformException {
      // Permission denied or the platform picker failed; keep the selection.
      return;
    }
    if (picked == null || !mounted) return;
    final draft = await _draftFrom(picked);
    if (!mounted) return;
    widget.onChanged([...widget.attachments, draft]);
  }

  Future<AttachmentDraft> _draftFrom(XFile file) async {
    final path = file.path;
    final length = await File(path).length();
    return AttachmentDraft(
      path: path,
      filename: file.name.isNotEmpty
          ? file.name
          : path.split(Platform.pathSeparator).last,
      sizeBytes: length,
      mimeType: _mimeFromPath(path),
    );
  }

  void _remove(AttachmentDraft draft) {
    widget.onChanged([
      for (final d in widget.attachments)
        if (d != draft) d,
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, UploadJobStatus>>(
      valueListenable: widget.uploadStatus,
      builder: (context, statuses, _) {
        return SizedBox(
          height: 56,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: widget.attachments.length + 1,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              if (index == widget.attachments.length) {
                return _AddButton(
                  enabled: _addEnabled,
                  tooltip: _addTooltip,
                  onPressed: _addEnabled ? _addFile : null,
                );
              }
              final draft = widget.attachments[index];
              final jobId = widget.draftToJobId[draft.path];
              final status = jobId == null ? null : statuses[jobId];
              return _Thumb(
                draft: draft,
                status: status,
                onRemove: () => _remove(draft),
              );
            },
          ),
        );
      },
    );
  }
}

/// A single 56x56 preview tile: the image, an optional upload-status overlay,
/// and a remove (X) button.
class _Thumb extends StatelessWidget {
  const _Thumb({
    required this.draft,
    required this.status,
    required this.onRemove,
  });

  final AttachmentDraft draft;
  final UploadJobStatus? status;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 56,
      height: 56,
      child: Stack(
        children: [
          Positioned.fill(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.file(
                File(draft.path),
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => Container(
                  color: scheme.surfaceContainerHighest,
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.broken_image_outlined,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          ),
          if (status != null)
            Positioned.fill(
              child: _StatusOverlay(status: status!),
            ),
          Positioned(
            top: 0,
            right: 0,
            child: _RemoveButton(onPressed: onRemove),
          ),
        ],
      ),
    );
  }
}

/// Translucent upload-state badge rendered over a thumbnail.
class _StatusOverlay extends StatelessWidget {
  const _StatusOverlay({required this.status});

  final UploadJobStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(8),
      ),
      alignment: Alignment.center,
      child: switch (status.status) {
        UploadStatus.pending => Container(
            key: const ValueKey('attachment-status-pending'),
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: scheme.outline,
            ),
          ),
        UploadStatus.uploading => SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(
              value: status.progress.clamp(0.0, 1.0),
              strokeWidth: 2.5,
            ),
          ),
        UploadStatus.done => const Icon(
            Icons.check_circle,
            color: Colors.green,
            size: 22,
          ),
        UploadStatus.failed => Icon(
            Icons.cancel,
            color: scheme.error,
            size: 22,
          ),
      },
    );
  }
}

class _RemoveButton extends StatelessWidget {
  const _RemoveButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Remove',
      child: InkWell(
        onTap: onPressed,
        customBorder: const CircleBorder(),
        child: Container(
          padding: const EdgeInsets.all(2),
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.black54,
          ),
          child: const Icon(Icons.close, size: 14, color: Colors.white),
        ),
      ),
    );
  }
}

class _AddButton extends StatelessWidget {
  const _AddButton({
    required this.enabled,
    required this.tooltip,
    required this.onPressed,
  });

  final bool enabled;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onPressed,
        customBorder: const CircleBorder(),
        child: Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: enabled ? scheme.outline : scheme.outlineVariant,
              width: 1.5,
            ),
          ),
          child: Icon(
            Icons.add,
            color: enabled ? scheme.primary : scheme.outlineVariant,
          ),
        ),
      ),
    );
  }
}

/// Best-effort MIME detection for picked images, based on the file extension.
/// Cosmetic only — the server validates magic bytes.
String _mimeFromPath(String path) {
  final name = path.split(Platform.pathSeparator).last;
  return mimeForFilename(name);
}
