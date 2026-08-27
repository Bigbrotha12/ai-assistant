import 'package:flutter/material.dart';

import 'markdown_renderer.dart';
import 'message_model.dart';
import 'tool_call_chip.dart';

/// Renders a single chat message. User messages are right-aligned plain text;
/// assistant messages are left-aligned markdown with optional tool-call chips;
/// tool role messages are intentionally rendered as nothing (their results are
/// shown inside the assistant's chips).
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

    final isUser = message.role == MessageRole.user;

    final background = isUser
        ? scheme.primaryContainer
        : scheme.surfaceContainerHighest;
    final foreground =
        isUser ? scheme.onPrimaryContainer : scheme.onSurface;

    final content = isUser
        ? Text(
            message.content,
            style: TextStyle(color: foreground, fontSize: 15),
          )
        : MarkdownRenderer(markdown: message.content);

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
            borderRadius: BorderRadius.circular(16),
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
}
