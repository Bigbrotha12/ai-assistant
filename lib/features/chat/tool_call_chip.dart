import 'package:flutter/material.dart';

import 'message_model.dart';

/// Renders a single tool call as a compact chip inside an assistant message.
/// The chip shows the tool name, and, when a result is present, a status
/// indicator (ok / error) plus a short result summary on the right.
class ToolCallChip extends StatelessWidget {
  const ToolCallChip({super.key, required this.toolCall});

  final ToolCall toolCall;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    final result = toolCall.result;
    final hasResult = result != null && result.isNotEmpty;
    final isError = hasResult && _looksLikeError(result);

    final Widget status = !hasResult
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(left: 6),
            child: isError
                ? const Icon(Icons.error_outline, size: 14, color: Colors.redAccent)
                : Icon(Icons.check_circle_outline,
                    size: 14, color: Colors.green.shade600),
          );

    final label = hasResult
        ? Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  'used ${toolCall.name}()',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Flexible(
                child: Text(
                  ' · ${_shortSummary(result)}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              status,
            ],
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  'used ${toolCall.name}()',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          );

    return Chip(
      avatar: Icon(Icons.build, size: 16, color: scheme.onSurfaceVariant),
      label: label,
      labelStyle: TextStyle(
        color: scheme.onSurface,
        fontSize: 13,
        fontFamily: 'monospace',
      ),
      backgroundColor: scheme.surfaceContainerHighest,
      side: BorderSide.none,
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
  }

  String _shortSummary(String result) {
    final trimmed = result.trim();
    if (trimmed.length <= 24) return trimmed;
    return '${trimmed.substring(0, 24)}…';
  }

  bool _looksLikeError(String result) {
    final lower = result.toLowerCase();
    return lower.contains('error') ||
        lower.contains('failed') ||
        lower.contains('exception');
  }
}
