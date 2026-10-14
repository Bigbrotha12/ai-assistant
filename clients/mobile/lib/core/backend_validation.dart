// Shared host/storage validators for the settings and onboarding screens.
// Single source of truth so both forms enforce identical rules.

/// Validates a backend host entered in the settings/onboarding forms.
///
/// Returns an error message, or null when the host is usable as a scheme-less
/// URI authority (no `://`, path, whitespace, or other invalid characters).
String? validateHost(String host) {
  final trimmed = host.trim();
  if (trimmed.isEmpty) {
    return 'Enter the backend host';
  }
  if (RegExp(r'\s').hasMatch(trimmed)) {
    return 'Host must not contain whitespace';
  }
  if (trimmed.contains('://') || trimmed.contains('/')) {
    return 'Enter a host name, not a URL';
  }
  if (RegExp(r'[^a-zA-Z0-9.\-:]').hasMatch(trimmed)) {
    return 'Host contains invalid characters';
  }
  return null;
}

/// Validates an optional storage service URL. Blank is valid (falls back to
/// `<host>:17603`); a non-blank value must parse as an absolute URL.
String? validateStorageUrl(String? url) {
  final trimmed = url?.trim() ?? '';
  if (trimmed.isEmpty) return null;
  try {
    final uri = Uri.parse(trimmed);
    if (uri.scheme.isEmpty || uri.host.isEmpty) {
      return 'Enter a full URL (e.g. http://host:port)';
    }
  } catch (_) {
    return 'Invalid URL';
  }
  return null;
}