import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/theme.dart';
import '../../../app/app_startup.dart';
import '../../../app/widgets/app_logo.dart';
import '../../../app/widgets/speak_button.dart';
import '../../../app/widgets/voice_text_mode_pill.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/ui/auth_flow.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/ui/chat_providers.dart';
import '../../chat/ui/chat_screen.dart';
import '../../chat/ui/conversation_list.dart';
import '../../settings/data/settings_providers.dart';
import '../../settings/ui/settings_screen.dart';
import '../data/engine_config.dart';
import '../data/engine_errors.dart';
import '../data/engine_manager.dart';
import '../data/engine_manager_provider.dart';
import '../data/voice_capture_providers.dart';
import './voice_controller_provider.dart';

/// Voice-first home screen: a single large hold-to-talk [SpeakButton], a
/// quiet status line, and a bottom bar carrying the shared Voice/Text mode
/// switch. Tapping **Text** hands off to [ChatScreen]; the chat screen's own
/// pill hands back to this screen, so the two surfaces stay one affordance
/// apart with a single text-chat implementation (no separate voice text
/// composer).
///
/// Consumes the existing voice providers ([voiceConversationStateProvider],
/// [voiceCapturePipelineProvider] and the engine status providers); it does not
/// reimplement any audio service. Pressing the speak button starts the text
/// conversation session, then begins the capture pipeline (VAD-gated).
class VoiceScreen extends ConsumerStatefulWidget {
  const VoiceScreen({super.key});

  @override
  ConsumerState<VoiceScreen> createState() => _VoiceScreenState();
}

class _VoiceScreenState extends ConsumerState<VoiceScreen> {
  bool _micBusy = false;

  /// The in-flight [_holdStart], so a very quick release can wait for it.
  Future<void>? _pendingStart;

  /// Mirrors [VoiceCapturePipeline.isRecording] for states where the server
  /// connection is down but local capture is still active.
  bool _localRecording = false;

  /// Errors raised outside the controller (e.g. mic permission before the
  /// pipeline starts) so they surface in the same banner as state errors.
  String? _localError;

  @override
  void initState() {
    super.initState();
    // The active conversation may already exist (set by an earlier chat/voice
    // session); ensure one exists so the shared conversation id is stable when
    // the user later switches to the chat screen. Clear the controller's
    // per-turn fields so stale turn data from a previous session can never
    // re-emit as phantom state.
    ref.read(activeConversationIdProvider.notifier).ensure();
    ref.read(voiceControllerProvider).clearTurnFields();
  }

  @override
  void dispose() {
    // The shared voice providers are NOT autoDispose, so this screen does not
    // rely on them tearing down when it unmounts. Leaving via the pill ends the
    // session explicitly (see [_openChat]); the providers' own `ref.onDispose`
    // callbacks (pipeline dispose, controller dispose) run when the provider
    // container is torn down. Calling `ref.read(...)` here is unsafe (Riverpod
    // forbids ref after unmount) and unnecessary.
    super.dispose();
  }

  /// Starts a hold-to-talk recording: stops any active recording (toggle), or
  /// starts the text conversation session then begins the capture pipeline.
  Future<void> _holdStart() async {
    if (kDebugMode) debugPrint('UI: _holdStart');
    if (_micBusy) return;
    final pipeline = ref.read(voiceCapturePipelineProvider);
    if (pipeline.isRecording) {
      await _holdEnd();
      return;
    }
    final controller = ref.read(voiceControllerProvider);
    setState(() {
      _micBusy = true;
      _localError = null;
    });
    final started = () async {
      try {
        if (!controller.state.isConnected) {
          await controller.startConversation();
        }
        if (!controller.state.isConnected) {
          return; // Session error is already surfaced through the state.
        }
        // Barge-in BEFORE the mic opens: interrupt()'s playback stop must
        // never run against a live microphone — on device that tears the
        // capture session down mid-hold (recording starts, then stops). The
        // await is bounded so a slow/hung stop still cannot wedge the hold:
        // past the bound the mic opens regardless, with the gates already
        // re-opened and the echo gate armed by interrupt()'s synchronous part.
        if (controller.state.isAiSpeaking || controller.state.isGenerating) {
          try {
            await controller.interrupt().timeout(
              const Duration(milliseconds: 500),
            );
          } on TimeoutException {
            // The stop is still winding down; open the mic anyway.
          }
        }
        await pipeline.startRecording();
        if (mounted) {
          setState(() => _localRecording = true);
        }
      } catch (e) {
        if (mounted) {
          setState(() => _localError = e.toString());
        }
      } finally {
        if (mounted) setState(() => _micBusy = false);
      }
    }();
    // Recorded so a very quick release (_holdEnd) waits for the start to
    // settle instead of early-returning and leaving the mic live.
    _pendingStart = started;
    await started;
  }

  /// Stops the hold-to-talk recording on release.
  Future<void> _holdEnd() async {
    if (kDebugMode) debugPrint('UI: _holdEnd');
    await _pendingStart;
    final pipeline = ref.read(voiceCapturePipelineProvider);
    try {
      if (pipeline.isRecording) {
        await pipeline.stopRecording();
        // Hold-to-talk turn boundary: the VAD only flushes after its silence
        // window elapses *while still recording*, which a quick release never
        // satisfies — the buffered utterance must be flushed explicitly here.
        await ref.read(voiceControllerProvider).flushTranscriptionBuffer();
      }
    } catch (_) {
      // Failures surface through the conversation state; never crash.
    } finally {
      // Always clear the local flag: if the pipeline was torn down under us
      // (provider rebuild), an early return here would wedge the UI in
      // "listening" mode until the next press.
      if (mounted) setState(() => _localRecording = false);
    }
  }

  /// Restarts the text conversation session, then restarts local capture if
  /// the session is active. Used by the error banner's retry action.
  Future<void> _retryConnection() async {
    if (_micBusy) return;
    final pipeline = ref.read(voiceCapturePipelineProvider);
    final controller = ref.read(voiceControllerProvider);
    setState(() {
      _micBusy = true;
      _localError = null;
    });
    try {
      if (!controller.state.isConnected) {
        await controller.startConversation();
      }
      if (controller.state.isConnected) {
        if (pipeline.isRecording) {
          await pipeline.stopRecording();
        } else {
          await pipeline.startRecording();
          if (mounted) setState(() => _localRecording = true);
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() => _localError = e.toString());
      }
    } finally {
      if (mounted) setState(() => _micBusy = false);
    }
  }

  /// Opens the system settings page for this app when the platform supports
  /// the `app-settings:` URI (e.g. iOS); a no-op elsewhere so the action never
  /// crashes.
  Future<void> _openAppSettings() async {
    final uri = Uri.parse('app-settings:');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  void _push(Widget screen) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  void _openBackendSettings() => _push(const SettingsScreen());

  /// Switches the active conversation to a fresh, empty one.
  void _newConversation() {
    ref.read(activeConversationIdProvider.notifier).newConversation();
  }

  /// Opens the session history; selecting a conversation switches the active
  /// id so the chat screen (and voice persistence) targets it next.
  Future<void> _openHistory() async {
    final selected = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ConversationListScreen()),
    );
    if (selected != null && mounted) {
      ref.read(activeConversationIdProvider.notifier).set(selected);
    }
  }

  /// Hands off to the text-chat surface (shared pill affordance). Ends the
  /// voice session first so the screen wake lock, mic capture, and playback
  /// are released — the shared voice providers are not autoDispose, so leaving
  /// this screen would otherwise retain them. Also flushes any queued
  /// persistence writes so the chat screen loads the complete conversation.
  /// Replaces this screen so toggling modes never stacks surfaces.
  Future<void> _openChat() async {
    try {
      final controller = ref.read(voiceControllerProvider);
      await controller.endConversation();
      await ref
          .read(voiceControllerProvider.notifier)
          .flushPersistence();
    } catch (_) {
      // Best-effort teardown: a failed stop/flush must never block the mode
      // switch (the chat surface still works; the session is abandoned).
    }
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const ChatScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceConversationStateProvider);

    final scheme = Theme.of(context).colorScheme;
    final tier = Theme.of(context).extension<TierTheme>() ?? const TierTheme(premium: false);
    final recording = state.isRecording || _localRecording;
    final error = state.error ?? _localError;
    // A gateway 401 (missing/invalid API key) surfaces the shared re-auth card
    // instead of the generic error banner.
    final authRequired = error != null && isAuthRequiredError(error);
    // Mirrors the onboarding gate's configured rule (API key + explicitly
    // stored, valid host), so the banner never disagrees with the gate.
    final configured = isConfigured(
      credentials: ref.watch(authCredentialsProvider).value,
      stored: ref.watch(settingsProvider).value,
    );

    // The SpeakButton is the hero stack's only flow child, so the stack sizes
    // to it and the Center below places it at the exact vertical middle of
    // the viewport. circleEdge is the distance from the stack's edge to the
    // tappable circle's edge; the hero text and caption anchor to it, so
    // appearing/disappearing text never moves the button off-center.
    const double heroDiameter = 172.0;
    final double heroBox =
        heroDiameter * (tier.premium ? SpeakButton.premiumBoxFactor : 1.0);
    final double circleEdge = heroBox / 2 + heroDiameter / 2;
    // The phase label's visual gap to the button: the fixed waveform slot
    // (36px) plus the 20px spacer below it. The caption mirrors this so the
    // button reads vertically centered between the two labels.
    const double heroLabelGap = 56.0;

    return Scaffold(
      appBar: AppBar(
        centerTitle: true,
        leading: IconButton(
          key: const Key('new-conversation'),
          tooltip: 'New Conversation',
          icon: const Icon(Icons.add_comment_outlined),
          onPressed: _newConversation,
        ),
        title: const BrandAppBarTitle(),
        actions: [
          IconButton(
            key: const Key('history'),
            tooltip: 'History',
            icon: const Icon(Icons.history),
            onPressed: _openHistory,
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (!configured)
              const _ConfigureBanner()
            else
              _FallbackBanner(),
            if (error != null)
              authRequired
                  ? Flexible(
                      fit: FlexFit.loose,
                      child: SingleChildScrollView(
                        child: ReauthCard(
                          onSuccess: (_) => _retryConnection(),
                          onDismiss: () {
                            ref.read(voiceControllerProvider).clearError();
                            setState(() => _localError = null);
                          },
                        ),
                      ),
                    )
                  : _ErrorBanner(
                      error: error,
                      onOpenSettings: _openAppSettings,
                      onConfigureBackend: _openBackendSettings,
                      onRetry: _retryConnection,
                    ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  // The hero text keeps the full scroll-viewport width
                  // (as in the previous centered column) while the
                  // button itself is pinned to the exact vertical
                  // middle of the viewport.
                  final double heroWidth = constraints.maxWidth - 48;
                  final double blockLeft = (heroBox - heroWidth) / 2;
                  return Center(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 24,
                        vertical: 12,
                      ),
                      // The SpeakButton is the stack's only flow
                      // child, so the stack sizes to it and Center
                      // places it at the exact vertical middle of the
                      // viewport. The hero text and caption anchor to
                      // the tappable circle's edges, so they never
                      // shift the button.
                      child: Stack(
                        // Don't clip the hero text/caption to the
                        // button's box: they intentionally extend
                        // above/below it while staying centered on the
                        // button.
                        clipBehavior: Clip.none,
                        alignment: Alignment.center,
                        children: [
                          // Hero text above the button: status line,
                          // phase label and the fixed-height waveform
                          // slot (16 top pad + 20 max bar), so the
                          // waveform's appearance never shifts the
                          // button.
                          Positioned(
                            left: blockLeft,
                            width: heroWidth,
                            bottom: circleEdge + 20,
                            child: Column(
                              children: [
                                _TurnStatusLine(
                                  notice: state.notice,
                                ),
                                const SizedBox(height: 10),
                                _PhaseLabel(
                                  phase: recording
                                      ? 'Listening'
                                      : state.isGenerating
                                          ? 'Working'
                                          : state.isAiSpeaking
                                              ? 'Speaking'
                                              : 'Speak',
                                  style: Theme.of(context)
                                      .textTheme
                                      .displaySmall
                                      ?.copyWith(
                                        color: scheme.onSurface,
                                      ),
                                ),
                                SizedBox(
                                  height: 36,
                                  child: AnimatedSwitcher(
                                    duration: const Duration(
                                        milliseconds: 200),
                                    child: recording ||
                                            state.isSpeaking
                                        ? Padding(
                                            key: const ValueKey(
                                                'waveform'),
                                            padding:
                                                const EdgeInsets.only(
                                                    top: 16),
                                            child: _Waveform(
                                              active: recording ||
                                                  state.isSpeaking,
                                              color: tier.premium
                                                  ? AppColors.goldBase
                                                  : scheme.primary,
                                            ),
                                          )
                                        : const SizedBox(
                                            key: ValueKey(
                                                'waveform-idle'),
                                            height: 1,
                                          ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          SpeakButton(
                            recording: recording,
                            aiSpeaking: state.isAiSpeaking,
                            generating: state.isGenerating,
                            busy: _micBusy,
                            onHoldStart: _holdStart,
                            onHoldEnd: _holdEnd,
                          ),
                          // Per-turn caption below the button, at the
                          // same distance the phase label sits above
                          // it.
                          Positioned(
                            left: blockLeft,
                            width: heroWidth,
                            top: circleEdge + heroLabelGap,
                            child: SizedBox(
                              height: 20,
                              child: Center(
                                child: Text(
                                  state.status ??
                                      'PRESS AND HOLD TO TALK',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  textAlign: TextAlign.center,
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelSmall
                                      ?.copyWith(
                                        letterSpacing:
                                            state.status == null
                                                ? 1.4
                                                : null,
                                        fontStyle: state.status == null
                                            ? null
                                            : FontStyle.italic,
                                        color: state.status == null &&
                                                tier.premium
                                            ? AppColors.goldDark
                                            : scheme.onSurfaceVariant,
                                      ),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            // Bottom bar: the shared Voice/Text pill with the settings gear
            // pinned to the right. Text mode lives on the chat screen; this
            // segment hands off to it.
            Material(
              color: scheme.surfaceContainerLow,
              child: SafeArea(
                top: false,
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      VoiceTextModePill(
                        selected: false,
                        // Block switching away mid-turn (recording, streaming,
                        // speaking, or a hold-start still warming up the mic)
                        // so the conversation state is consistent and the mic
                        // is never left live when this screen unmounts —
                        // mirrors the chat screen's own `enabled: !isStreaming`.
                        enabled: !recording &&
                            !state.isGenerating &&
                            !state.isAiSpeaking &&
                            !_micBusy,
                        onChanged: (text) {
                          if (text) unawaited(_openChat());
                        },
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: IconButton(
                          key: const Key('engine-bar-settings'),
                          tooltip: 'Settings',
                          icon: const Icon(Icons.settings_outlined),
                          onPressed: _openBackendSettings,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The hero phase label ('Speak' / 'Listening' / 'Working' / 'Speaking').
///
/// Idle renders the static 'Speak' copy; in an active phase the trailing dots
/// animate (one → two → three → loop) to signal liveness. The word stays
/// anchored in place — a fixed-width dot slot expands rightward — and the
/// single displaySmall line never shifts the surrounding layout.
class _PhaseLabel extends StatefulWidget {
  const _PhaseLabel({required this.phase, this.style});

  /// Phase word WITHOUT trailing dots ('Speak' for the idle state).
  final String phase;

  final TextStyle? style;

  @override
  State<_PhaseLabel> createState() => _PhaseLabelState();
}

class _PhaseLabelState extends State<_PhaseLabel>
    with SingleTickerProviderStateMixin {
  late final AnimationController _dots;

  @override
  void initState() {
    super.initState();
    _dots = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    if (widget.phase != 'Speak') _dots.repeat();
  }

  @override
  void didUpdateWidget(covariant _PhaseLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.phase == 'Speak' && widget.phase != 'Speak') {
      _dots.repeat();
    } else if (oldWidget.phase != 'Speak' && widget.phase == 'Speak') {
      _dots.stop();
      _dots.value = 0;
    }
  }

  @override
  void dispose() {
    _dots.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.phase == 'Speak') {
      return Text('Speak', style: widget.style);
    }
    return AnimatedBuilder(
      animation: _dots,
      builder: (context, _) {
        final dots = 1 + (_dots.value * 3).floor() % 3;
        return Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(widget.phase, style: widget.style),
            // Fixed-width slot (sized by an invisible 3-dot spacer) so the
            // word keeps its position while the dots expand rightward.
            Stack(
              alignment: Alignment.centerLeft,
              children: [
                Opacity(
                  opacity: 0,
                  child: Text('...', style: widget.style),
                ),
                Text('.' * dots, style: widget.style),
              ],
            ),
          ],
        );
      },
    );
  }
}

/// Transient notice line shown below the hero (e.g. 'Dropped — one utterance
/// at a time.'). The live phase (Thinking/Working/Speaking) is shown by the
/// big status label and the detailed per-turn status by the caption under the
/// button, so this line carries only non-duplicative notices. Always reserves
/// its height so appearing notices never shift the layout.
class _TurnStatusLine extends StatelessWidget {
  const _TurnStatusLine({this.notice});

  final String? notice;

  /// Height the notice line always reserves, so the layout never shifts when
  /// it appears or disappears.
  static const _slotHeight = 22.0;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final noticeStyle = Theme.of(context).textTheme.labelSmall?.copyWith(
          color: scheme.onSurfaceVariant,
        );
    return SizedBox(
      height: _slotHeight,
      child: Visibility(
        visible: notice != null,
        maintainSize: true,
        maintainState: true,
        maintainAnimation: true,
        child: Center(
          child: Text(
            notice ?? '',
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: noticeStyle,
          ),
        ),
      ),
    );
  }
}

/// Banner shown when a voice session error is active: microphone permission
/// and backend configuration get dedicated actions, connection errors get a
/// retry action, everything else is shown as-is.
///
/// Classifies [EngineError]s by type where possible and falls back to
/// string-matching for errors raised by external services (Dio, the chat
/// client).
class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({
    required this.error,
    required this.onOpenSettings,
    required this.onConfigureBackend,
    required this.onRetry,
  });

  final Object error;
  final Future<void> Function() onOpenSettings;
  final VoidCallback onConfigureBackend;
  final Future<void> Function() onRetry;

  String get _detail => error.toString();
  bool get _permissionDenied => _detail.toLowerCase().contains('permission');

  bool get _needsConfiguration =>
      _detail.toLowerCase().contains('not configured');

  bool get _connectionFailed =>
      _detail.toLowerCase().contains('connect');

  String get _message {
    if (error is EngineModelNotFoundError) {
      return 'An on-device voice model is missing. Download it below to '
          'enable offline speech recognition and voice replies.';
    }
    if (error is EngineInferenceError) {
      return 'On-device sound processing failed. Offline speech and voice '
          'fall back to the server.';
    }
    if (_permissionDenied) {
      return 'Microphone permission denied. Allow microphone access in system '
          'settings to use voice conversation.';
    }
    if (_needsConfiguration) {
      return 'Voice backend is not configured. Set up the backend host and '
          'secret to start a conversation.';
    }
    if (_connectionFailed) {
      return 'Could not connect to the voice backend. Check your connection '
          'and try again.';
    }
    return _detail;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final buttonStyle = TextButton.styleFrom(
      foregroundColor: scheme.onErrorContainer,
    );
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
                _message,
                style: TextStyle(color: scheme.onErrorContainer),
              ),
            ),
            if (_permissionDenied)
              TextButton(
                style: buttonStyle,
                onPressed: onOpenSettings,
                child: const Text('Open Settings'),
              )
            else if (_needsConfiguration)
              TextButton(
                style: buttonStyle,
                onPressed: onConfigureBackend,
                child: const Text('Configure'),
              )
            else if (_connectionFailed)
              TextButton(
                style: buttonStyle,
                onPressed: onRetry,
                child: const Text('Retry'),
              ),
          ],
        ),
      ),
    );
  }
}

/// Non-blocking inline banner prompting the user to configure the backend,
/// mirroring the ChatScreen banner. Shown when [settingsProvider] is invalid.
class _ConfigureBanner extends ConsumerWidget {
  const _ConfigureBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Icon(Icons.settings_outlined, color: scheme.onErrorContainer),
            const SizedBox(width: 12),
            const Expanded(child: Text('Backend not configured')),
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: scheme.onErrorContainer,
              ),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              ),
              child: const Text('Configure Backend'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Non-blocking banner describing partial model availability: shown when an
/// on-device engine is missing/failed but its server-side counterpart can
/// still service the conversation.
class _FallbackBanner extends ConsumerWidget {
  const _FallbackBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statuses = ref.watch(voiceEngineStatusProvider);
    final (stt, tts) = (
      statuses[EngineConfig.whisperTinyId] ?? VoiceEngineStatus.notStarted,
      statuses[EngineConfig.supertonic3Id] ?? VoiceEngineStatus.notStarted,
    );
    // Engines surfaced as `unavailable` are intentionally off (e.g. TTS is
    // gated until its model/tokenizer lands) — they should neither show a
    // download prompt nor trigger the fallback banner.
    final sttAvailable = stt != VoiceEngineStatus.unavailable;
    final ttsAvailable = tts != VoiceEngineStatus.unavailable;
    final sttReady = stt == VoiceEngineStatus.ready;
    final ttsReady = tts == VoiceEngineStatus.ready;

    final String message;
    if (sttAvailable && !sttReady) {
      message = ttsAvailable && !ttsReady
          ? 'On-device voice models not downloaded — download them below.'
          : 'Local speech-to-text unavailable — using server transcription.';
    } else if (ttsAvailable && !ttsReady) {
      message = 'Local text-to-speech unavailable — using server voice.';
    } else {
      return const SizedBox.shrink();
    }

    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: scheme.onSurfaceVariant),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                message,
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Animated bar visualiser that pulses while recording and collapses to a
/// flat row when idle (kept small so the hero speaks for itself).
class _Waveform extends StatefulWidget {
  const _Waveform({required this.active, required this.color});

  final bool active;
  final Color color;

  @override
  State<_Waveform> createState() => _WaveformState();
}

class _WaveformState extends State<_Waveform>
    with SingleTickerProviderStateMixin {
  static const _barCount = 9;

  late final AnimationController _controller;
  bool _wasActive = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    );
    if (widget.active) _controller.repeat();
    _wasActive = widget.active;
  }

  @override
  void didUpdateWidget(covariant _Waveform oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active == _wasActive) return;
    _wasActive = widget.active;
    if (widget.active) {
      _controller.repeat();
    } else {
      _controller.stop();
      _controller.value = 0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  double _barHeight(int index, double t) {
    if (!widget.active) return 4;
    final wave = math.sin((t * 2 * math.pi) + index * 0.9);
    return 6 + 14 * (0.5 + 0.5 * wave);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = widget.active ? _controller.value : 0.0;
        return Row(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var i = 0; i < _barCount; i++) ...[
              Container(
                width: 4,
                height: _barHeight(i, t),
                decoration: BoxDecoration(
                  color: widget.color,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              if (i != _barCount - 1) const SizedBox(width: 4),
            ],
          ],
        );
      },
    );
  }
}