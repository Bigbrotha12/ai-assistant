import 'package:flutter/material.dart';

import 'message_bubble.dart';
import 'message_model.dart';

/// Scrollable list of chat messages with streaming caret, error banner, and
/// DB-ready loading state.
class MessageList extends StatefulWidget {
  const MessageList({
    super.key,
    required this.messages,
    required this.isStreaming,
    required this.error,
    required this.onRetry,
    required this.isDbReady,
    required this.scrollController,
  });

  final List<Message> messages;
  final bool isStreaming;
  final String? error;
  final VoidCallback onRetry;
  final bool isDbReady;
  final ScrollController scrollController;

  @override
  State<MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<MessageList>
    with SingleTickerProviderStateMixin {
  static const double _nearBottomThreshold = 100;

  late final AnimationController _caretController;
  late final Animation<double> _caretOpacity;

  /// True while the scroll position sits within [_nearBottomThreshold] pixels
  /// of the bottom; auto-scroll only fires then, so a user who scrolled up to
  /// read is not yanked back down by streaming updates.
  bool _nearBottom = true;

  @override
  void initState() {
    super.initState();
    _caretController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    );
    _caretOpacity = Tween<double>(begin: 1, end: 0.1).animate(
      CurvedAnimation(parent: _caretController, curve: Curves.easeInOut),
    );
    _syncCaretAnimation();
    _attachScrollListener();
  }

  void _attachScrollListener() {
    final controller = widget.scrollController;
    if (!controller.hasClients) {
      // Not yet attached to a scrollable; listener is attached on first layout
      // via the position's own listener below.
      controller.addListener(_updateNearBottom);
    } else {
      _updateNearBottom();
      controller.addListener(_updateNearBottom);
    }
  }

  void _updateNearBottom() {
    final controller = widget.scrollController;
    if (!controller.hasClients) return;
    final position = controller.position;
    _nearBottom =
        position.maxScrollExtent - position.pixels <= _nearBottomThreshold;
  }

  @override
  void didUpdateWidget(MessageList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scrollController != widget.scrollController) {
      oldWidget.scrollController.removeListener(_updateNearBottom);
      _attachScrollListener();
    }
    _syncCaretAnimation();
    _scrollToBottom();
  }

  /// Runs the caret blink animation only while streaming; stopping it lets
  /// pumpAndSettle (and idle frames) settle when no stream is active.
  void _syncCaretAnimation() {
    if (widget.isStreaming) {
      if (!_caretController.isAnimating) {
        _caretController.repeat(reverse: true);
      }
    } else if (_caretController.isAnimating) {
      _caretController
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    widget.scrollController.removeListener(_updateNearBottom);
    _caretController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_nearBottom) return;
    final controller = widget.scrollController;
    if (!controller.hasClients) return;
    final position = controller.position;
    if (position.maxScrollExtent <= 0) return;
    final target = position.maxScrollExtent;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!controller.hasClients) return;
      controller.animateTo(
        target,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.isDbReady) {
      return const Center(child: CircularProgressIndicator());
    }

    final visible = [
      for (final m in widget.messages)
        if (m.role != MessageRole.tool) m,
    ];

    return Column(
      children: [
        if (widget.error != null)
          _ErrorBanner(error: widget.error!, onRetry: widget.onRetry),
        Expanded(
          child: ListView.builder(
            controller: widget.scrollController,
            padding: const EdgeInsets.symmetric(vertical: 12),
            itemCount: visible.length + (widget.isStreaming ? 1 : 0),
            itemBuilder: (context, index) {
              if (index < visible.length) {
                return MessageBubble(message: visible[index]);
              }
              return _StreamingCaret(opacity: _caretOpacity);
            },
          ),
        ),
      ],
    );
  }
}

/// Blinking caret shown after the last assistant message while streaming.
class _StreamingCaret extends StatelessWidget {
  const _StreamingCaret({required this.opacity});

  final Animation<double> opacity;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: FadeTransition(
          opacity: opacity,
          child: Text(
            '▋',
            style: TextStyle(
              color: scheme.primary,
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ),
    );
  }
}

/// Error banner using the project's error-container pattern, with a Retry
/// action.
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error, required this.onRetry});

  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Icon(Icons.error_outline, color: scheme.onErrorContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                error,
                style: TextStyle(color: scheme.onErrorContainer),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            TextButton(
              onPressed: onRetry,
              child: Text(
                'Retry',
                style: TextStyle(color: scheme.onErrorContainer),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
