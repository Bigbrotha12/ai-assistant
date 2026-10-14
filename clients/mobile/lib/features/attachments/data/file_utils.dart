/// Shared formatting and MIME↔extension helpers for file attachments, so every
/// call site (chip, browser, cache) agrees on fallbacks.
library;

/// Formats [bytes] as a human-readable size string.
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) {
    return '${(bytes / 1024).toStringAsFixed(1)} KB';
  }
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// Maps a MIME type to a known extension (`.jpg`, `.png`, `.webp`), or null
/// when the type is not one of the supported image formats.
String? knownExtensionForMime(String mime) => switch (mime) {
      'image/jpeg' => '.jpg',
      'image/png' => '.png',
      'image/webp' => '.webp',
      _ => null,
    };

/// Maps a MIME type to the file extension used for cached files. Falls back to
/// `.bin` for anything unknown.
String extensionForMime(String mime) => knownExtensionForMime(mime) ?? '.bin';

/// Maps a file extension back to its MIME type; `application/octet-stream`
/// for anything unknown.
String mimeForExtension(String extension) => switch (extension.toLowerCase()) {
      '.jpg' || '.jpeg' => 'image/jpeg',
      '.png' => 'image/png',
      '.webp' => 'image/webp',
      '.gif' => 'image/gif',
      _ => 'application/octet-stream',
    };

/// Returns the extension of [filename] including the leading dot, or `''` when
/// the name has none (e.g. a bare server-assigned file id).
String extensionForFilename(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot == filename.length - 1) return '';
  return filename.substring(dot);
}

/// Best-effort MIME detection from a [filename]. Cosmetic only — the server
/// validates magic bytes.
String mimeForFilename(String filename) =>
    mimeForExtension(extensionForFilename(filename));