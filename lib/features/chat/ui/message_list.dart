import 'package:flutter/material.dart';

import './message_bubble.dart';
import '../data/message_model.dart';

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

  /// Id of the last visible message this list auto-scrolled to while idle.
  /// Rebuilds that don't change the tail (upload progress, error banner
  /// toggles) are ignored so the list never re-animates for irrelevant data.
  String? _pinnedTailId;

  /// True while a [_scrollToBottom] animation is in flight. Streaming flushes
  /// every ~80ms; without this guard each flush would start a new 200ms
  /// `animateTo` against a stale `maxScrollExtent`, producing overlapping
  /// animations that fight the growing list.
  bool _scrollAnimationActive = false;

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
    // While idle, only re-animate when the tail actually changed; skip the
    // redundant rebuilds (attachment uploads, error banner toggles) that
    // don't move the bottom of the list.
    if (!widget.isStreaming) {
      final tailId = _tailMessageId();
      if (tailId == _pinnedTailId) return;
      _pinnedTailId = tailId;
    }
    // One animation at a time: overlapping `animateTo` calls each target a
    // stale maxScrollExtent (captured before the next flush grows the list).
    // Set the guard synchronously so a second call in the same frame (e.g.
    // multiple state updates before the first frame paints) cannot schedule a
    // second overlapping callback.
    if (_scrollAnimationActive) return;
    _scrollAnimationActive = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Every path must clear the guard — the post-frame callback can run
      // after the flag was set even when there is nothing to scroll, and
      // leaving it true would disable auto-scroll for the State's lifetime.
      if (!controller.hasClients) {
        _scrollAnimationActive = false;
        return;
      }
      final position = controller.position;
      if (position.maxScrollExtent <= 0) {
        _scrollAnimationActive = false;
        return;
      }
      // Resolve the target against the live extent at animation start so the
      // caret keeps chasing the growing content instead of a captured value.
      final target = position.maxScrollExtent;
      position
          .animateTo(
            target,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          )
          .then((_) => _onScrollAnimationDone(target),
              onError: (_) => _onScrollAnimationDone(target));
    });
  }

  /// Re-arms scrolling after an animation finishes — but only when the list
  /// actually grew past the animated [target] while the animation was in
  /// flight (a streaming flush landed during the 200ms). Re-animating
  /// unconditionally would busy-loop during a long generation gap.
  void _onScrollAnimationDone(double target) {
    _scrollAnimationActive = false;
    final controller = widget.scrollController;
    if (!controller.hasClients) return;
    if (controller.position.maxScrollExtent > target) {
      _scrollToBottom();
    }
  }

  /// Id of the last visible (non-tool) message, or null when none.
  String? _tailMessageId() {
    final messages = widget.messages;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role != MessageRole.tool) return messages[i].id;
    }
    return null;
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
                // Stable key by message id: the ListView reconciles children
                // by runtimeType + index otherwise, so when the streaming
                // caret (a different widget type) vacates a slot and a
                // MessageBubble lands on it, the previous element's composited
                // layer can be repurposed and paint a stale bubble (the last
                // assistant reply showing up "duplicated" after a new send).
                return MessageBubble(
                  key: ValueKey('message-${visible[index].id}'),
                  message: visible[index],
                );
              }
              // Distinct key type from MessageBubble so it can never swap
              // layers with a bubble slot during reconciliation.
              return _StreamingCaret(
                key: const ValueKey('streaming-caret'),
                opacity: _caretOpacity,
              );
            },
          ),
        ),
      ],
    );
  }
}

/// Blinking caret shown after the last assistant message while streaming.
class _StreamingCaret extends StatelessWidget {
  const _StreamingCaret({super.key, required this.opacity});

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
