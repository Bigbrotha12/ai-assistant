import 'package:flutter/material.dart';

import '../../../app/theme.dart';
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
    this.isRetryInFlight = false,
    required this.isDbReady,
    required this.scrollController,
  });

  final List<Message> messages;
  final bool isStreaming;
  final String? error;
  final VoidCallback onRetry;
  final bool isRetryInFlight;
  final bool isDbReady;
  final ScrollController scrollController;

  @override
  State<MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<MessageList>
    with SingleTickerProviderStateMixin {
  static const double _nearBottomThreshold = 100;

  late final AnimationController _dotsController;
  late final Animation<double> _dotsAnimation;

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
    _dotsController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    _dotsAnimation = Tween<double>(
      begin: 0,
      end: 1,
    ).animate(CurvedAnimation(parent: _dotsController, curve: Curves.linear));
    _syncDotsAnimation();
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
    _syncDotsAnimation();
    _scrollToBottom();
  }

  /// Runs the dots animation only while streaming; stopping it lets
  /// pumpAndSettle (and idle frames) settle when no stream is active.
  void _syncDotsAnimation() {
    if (widget.isStreaming) {
      if (!_dotsController.isAnimating) {
        _dotsController.repeat();
      }
    } else if (_dotsController.isAnimating) {
      _dotsController
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    widget.scrollController.removeListener(_updateNearBottom);
    _dotsController.dispose();
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
          .then(
            (_) => _onScrollAnimationDone(target),
            onError: (_) => _onScrollAnimationDone(target),
          );
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

    // The streaming assistant placeholder (empty content) renders as a
    // three-dot "typing" bubble while the reply is being generated.
    final showStreamingDots =
        widget.isStreaming &&
        visible.isNotEmpty &&
        visible.last.role == MessageRole.assistant &&
        visible.last.content.isEmpty;

    return Column(
      children: [
        if (widget.error != null)
          _ErrorBanner(
            error: widget.error!,
            onRetry: widget.onRetry,
            isRetryInFlight: widget.isRetryInFlight,
          ),
        Expanded(
          child: ListView.builder(
            controller: widget.scrollController,
            padding: const EdgeInsets.symmetric(vertical: 12),
            itemCount: visible.length,
            itemBuilder: (context, index) {
              // Stable key by message id: the ListView reconciles children
              // by runtimeType + index otherwise, so when the streaming dots
              // (a different widget type) vacate a slot and a MessageBubble
              // lands on it, the previous element's composited layer can be
              // repurposed and paint a stale bubble (the last assistant reply
              // showing up "duplicated" after a new send).
              if (!showStreamingDots || index < visible.length - 1) {
                return MessageBubble(
                  key: ValueKey('message-${visible[index].id}'),
                  message: visible[index],
                );
              }
              // Distinct key type from MessageBubble so it can never swap
              // layers with a bubble slot during reconciliation.
              return _StreamingDots(
                key: const ValueKey('streaming-dots'),
                animation: _dotsAnimation,
              );
            },
          ),
        ),
      ],
    );
  }
}

/// Three-dot "typing" indicator inside an assistant-style bubble with a fixed
/// width, so the dots animate without expanding the bubble. Shown while the
/// assistant reply is generating and no text has landed yet.
class _StreamingDots extends StatelessWidget {
  const _StreamingDots({super.key, required this.animation});

  final Animation<double> animation;

  /// Staggered pulse: each dot reaches full opacity one third of a cycle
  /// after the previous one, so the three dots ripple left → right.
  static double _dotOpacity(double t, int index) {
    final phase = (t - index / 3) % 1.0;
    final intensity = 1.0 - (phase * 3).clamp(0.0, 1.0);
    return 0.2 + 0.8 * intensity;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tier =
        Theme.of(context).extension<TierTheme>() ??
        const TierTheme(premium: false);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: tier.premium
              ? AppColors.paperRaised
              : scheme.surfaceContainerLowest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
          border: Border.all(
            color: tier.premium ? AppColors.goldBase : scheme.outline,
          ),
        ),
        child: SizedBox(
          width: 48,
          child: AnimatedBuilder(
            animation: animation,
            builder: (context, _) {
              final t = animation.value;
              return Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var i = 0; i < 3; i++)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: scheme.onSurfaceVariant.withValues(
                            alpha: _dotOpacity(t, i),
                          ),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Error banner using the project's error-container pattern, with a Retry
/// action.
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({
    required this.error,
    required this.onRetry,
    required this.isRetryInFlight,
  });

  final String error;
  final VoidCallback onRetry;
  final bool isRetryInFlight;

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
              onPressed: isRetryInFlight ? null : onRetry,
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
