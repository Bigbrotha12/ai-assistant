import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../attachments/ui/file_attachment_chip.dart';
import './markdown_renderer.dart';
import '../data/message_model.dart';
import './tool_call_chip.dart';

/// Renders a single chat message. User messages are right-aligned plain text;
/// assistant messages are left-aligned markdown (as a block list, so
/// `[file:<id>]` references render as tappable [FileAttachmentChip]s) with
/// optional tool-call chips; tool role messages are intentionally rendered as
/// nothing (their results are shown inside the assistant's chips).
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.message});

  final Message message;

  @override
  Widget build(BuildContext context) {
    if (message.role == MessageRole.tool) {
      return const SizedBox.shrink();
    }

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tier = theme.extension<TierTheme>() ?? const TierTheme(premium: false);

    final isUser = message.role == MessageRole.user;

    // §4.2 bubbles: user = primary-tint fill with a 4px "tail" on the lower
    // right; assistant = raised surface with an outline (premium: paper +
    // hairline gold) and a 4px tail on the lower left. Gold stays an accent.
    final background = isUser
        ? (tier.premium ? AppColors.primarySoft : scheme.primaryContainer)
        : (tier.premium ? AppColors.paperRaised : scheme.surfaceContainerLowest);
    final foreground =
        isUser ? scheme.onPrimaryContainer : scheme.onSurface;
    final borderRadius = isUser
        ? const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(4),
          )
        : const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          );
    final border = isUser
        ? null
        : Border.all(
            color: tier.premium ? AppColors.goldBase : scheme.outline,
            width: tier.premium ? 1 : 1,
          );

    final content = isUser
        ? Text(
            message.content,
            style: TextStyle(color: foreground, fontSize: 15),
          )
        : _buildAssistantContent(message.content);

    final toolCalls = message.toolCalls;
    final hasToolCalls = toolCalls != null && toolCalls.isNotEmpty;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.85),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: background,
            borderRadius: borderRadius,
            border: border,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              content,
              if (hasToolCalls) ...[
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final call in toolCalls)
                      ToolCallChip(toolCall: call),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// Renders assistant content as a block list: text blocks via
  /// [MarkdownRenderer] and `[file:<id>]` references via [FileAttachmentChip].
  /// Widgets cannot be injected inside `flutter_markdown`, so refs are split
  /// out at parse time. A message with no refs yields a single text block and
  /// renders exactly as before.
  Widget _buildAssistantContent(String content) {
    final blocks = _parseBlocks(content);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final block in blocks)
          switch (block) {
            _TextBlock(:final text) => MarkdownRenderer(markdown: text),
            _FileRefBlock(:final fileId, :final filename) =>
              FileAttachmentChip(fileId: fileId, filename: filename),
          },
      ],
    );
  }
}

/// One unit of assistant content: either plain text or a `[file:<id>]` ref.
sealed class _MessageBlock {
  const _MessageBlock();
}

class _TextBlock extends _MessageBlock {
  const _TextBlock(this.text);

  final String text;
}

class _FileRefBlock extends _MessageBlock {
  const _FileRefBlock({required this.fileId, required this.filename});

  final String fileId;
  final String filename;
}

/// Matches `[file:<id>]` where the id is a server UUID with no special chars.
final RegExp _fileRefPattern = RegExp(r'\[file:([a-zA-Z0-9._-]+)\]');

/// Splits [content] on `[file:<id>]` patterns. Text outside refs becomes
/// [_TextBlock]s; each ref becomes a [_FileRefBlock]. No filename context
/// exists in the content, so the fileId doubles as the display name.
List<_MessageBlock> _parseBlocks(String content) {
  final blocks = <_MessageBlock>[];
  var lastEnd = 0;
  for (final match in _fileRefPattern.allMatches(content)) {
    if (match.start > lastEnd) {
      blocks.add(_TextBlock(content.substring(lastEnd, match.start)));
    }
    final fileId = match.group(1)!;
    blocks.add(_FileRefBlock(fileId: fileId, filename: fileId));
    lastEnd = match.end;
  }
  if (lastEnd < content.length) {
    blocks.add(_TextBlock(content.substring(lastEnd)));
  }
  if (blocks.isEmpty) {
    blocks.add(_TextBlock(content));
  }
  return blocks;
}
