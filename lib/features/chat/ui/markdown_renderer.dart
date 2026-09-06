import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

/// Renders LLM markdown output. LLM output is untrusted, so images are
/// disabled (prevents SSRF into tailnet-internal services via Image.network)
/// and only http/https links are opened externally.
class MarkdownRenderer extends StatelessWidget {
  const MarkdownRenderer({super.key, required this.markdown});

  final String markdown;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final baseStyleSheet = MarkdownStyleSheet.fromTheme(theme);
    final styleSheet = baseStyleSheet.copyWith(
      p: baseStyleSheet.p?.copyWith(
        fontSize: 15,
        color: theme.colorScheme.onSurface,
      ),
      code: baseStyleSheet.code?.copyWith(
        fontFamily: 'monospace',
        color: theme.colorScheme.onSurface,
      ),
    );

    return MarkdownBody(
      data: markdown,
      selectable: true,
      styleSheet: styleSheet,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      // Images disabled: rendering nothing prevents SSRF into tailnet-internal
      // services via Image.network.
      sizedImageBuilder: (config) => const SizedBox.shrink(),
      onTapLink: (text, href, title) => _openLink(href),
    );
  }

  /// Launches http/https links in an external application, ignoring all other
  /// schemes (intent://, file://, javascript:, etc.).
  void _openLink(String? href) {
    if (href == null || href.isEmpty) return;
    final uri = Uri.tryParse(href);
    if (uri == null) return;
    final scheme = uri.scheme.toLowerCase();
    if (scheme != 'http' && scheme != 'https') return;
    try {
      launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // Ignore launch failures; link handling must never crash the chat.
    }
  }
}
