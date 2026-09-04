import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../chat/chat_screen.dart';
import '../settings/settings_screen.dart';
import '../../core/app_startup.dart';
import '../../core/auth_credentials_providers.dart';
import '../../core/chat_client.dart';
import '../../core/settings_providers.dart';
import '../../core/theme.dart';
import '../../core/widgets/golden_pill.dart';
import '../../core/widgets/speak_button.dart';
import '../auth/auth_flow.dart';
import 'engine_config.dart';
import 'engine_errors.dart';
import 'engine_manager.dart';
import 'engine_manager_provider.dart';
import 'model_downloader.dart';
import 'voice_capture_providers.dart';
import 'voice_controller.dart';
import 'voice_controller_provider.dart';
import 'voice_settings_screen.dart';

/// Voice-first home screen: a single large hold-to-talk [SpeakButton], a
/// quiet status line, and a Transcript [GoldenPill] whose panel expands
/// upward from the bottom of the screen.
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
  final _logScroll = ScrollController();

  /// Ordered, de-duplicated user transcripts shown as chat bubbles.
  /// Transcript log: user utterances and assistant replies, in order.
  final _transcripts = <_LogEntry>[];

  bool _micBusy = false;

  /// The in-flight [_holdStart], so a very quick release can wait for it.
  Future<void>? _pendingStart;

  /// Mirrors [VoiceCapturePipeline.isRecording] for states where the server
  /// connection is down but local capture is still active.
  bool _localRecording = false;

  bool _engineBusy = false;

  /// Whether the live transcript panel is expanded (docs: chevron points up
  /// because the panel rises from the bottom).
  bool _transcriptOpen = false;

  /// Errors raised outside the controller (e.g. mic permission before the
  /// pipeline starts) so they surface in the same banner as state errors.
  String? _localError;

  @override
  void dispose() {
    _logScroll.dispose();
    // The voice providers own their teardown: `VoiceCapturePipelineNotifier`
    // and `VoiceControllerNotifier` dispose the pipeline (stopping any active
    // recording) and the controller (ending the conversation) via their
    // `ref.onDispose` callbacks once the last listener — this screen and the
    // conversation-state notifier — is gone. Calling `ref.read(...)` here is
    // both unsafe (Riverpod forbids ref after unmount) and unnecessary.
    super.dispose();
  }

  /// Appends a freshly recognised user utterance to the log. Empty text is
  /// ignored so the list stays stable across unrelated state updates.
  void _appendTranscript(VoiceConversationState state) {
    final text = state.onDeviceTranscript;
    if (text == null || text.trim().isEmpty) return;
    if (_transcripts.isNotEmpty &&
        _transcripts.last.fromUser &&
        _transcripts.last.text == text) {
      return;
    }
    setState(() => _transcripts.add(_LogEntry(text, fromUser: true)));
    _scrollLogToEnd();
  }

  /// Appends the assistant's final reply to the log. [lastReply] is cleared
  /// at the start of each turn and set once at its end, so this fires exactly
  /// once per completed turn (even for identical reply text).
  void _appendAssistantReply(VoiceConversationState state) {
    final text = state.lastReply;
    if (text == null || text.trim().isEmpty) return;
    if (_transcripts.isNotEmpty &&
        !_transcripts.last.fromUser &&
        _transcripts.last.text == text) {
      return;
    }
    setState(() => _transcripts.add(_LogEntry(text, fromUser: false)));
    _scrollLogToEnd();
  }

  void _scrollLogToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_logScroll.hasClients) {
        _logScroll.jumpTo(_logScroll.position.maxScrollExtent);
      }
    });
  }

  /// Starts a hold-to-talk recording: stops any active recording (toggle), or
  /// starts the text conversation session then begins the capture pipeline.
  Future<void> _holdStart() async {
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
    await _pendingStart;
    final pipeline = ref.read(voiceCapturePipelineProvider);
    if (!pipeline.isRecording) return;
    try {
      await pipeline.stopRecording();
      // Hold-to-talk turn boundary: the VAD only flushes after its silence
      // window elapses *while still recording*, which a quick release never
      // satisfies — the buffered utterance must be flushed explicitly here.
      await ref.read(voiceControllerProvider).flushTranscriptionBuffer();
      if (mounted) {
        setState(() => _localRecording = false);
      }
    } catch (_) {
      // Failures surface through the conversation state; never crash.
    }
  }

  Future<void> _downloadModels() async {
    setState(() => _engineBusy = true);
    try {
      await ref.read(voiceEngineStatusProvider.notifier).downloadAllModels();
    } finally {
      if (mounted) setState(() => _engineBusy = false);
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

  void _openChat() => _push(const ChatScreen());

  void _openVoiceSettings() => _push(const VoiceSettingsScreen());

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceConversationStateProvider);
    ref.listen(voiceConversationStateProvider, (_, next) {
      _appendTranscript(next);
      _appendAssistantReply(next);
    });

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

    return Scaffold(
      appBar: AppBar(
        title: const Text('AI Assistant'),
        actions: [
          IconButton(
            tooltip: 'Chat',
            icon: const Icon(Icons.chat_bubble_outline),
            onPressed: _openChat,
          ),
          PopupMenuButton<String>(
            onSelected: (value) {
              switch (value) {
                case 'voice-settings':
                  _openVoiceSettings();
                case 'settings':
                  _openBackendSettings();
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'voice-settings', child: Text('Voice Settings')),
              PopupMenuItem(value: 'settings', child: Text('Settings')),
            ],
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
              child: Column(
                children: [
                  Expanded(
                    child: Center(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 24,
                          vertical: 12,
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            _HeroStatus(
                              recording: recording,
                              aiSpeaking: state.isAiSpeaking,
                              connected: state.isConnected,
                              paused: state.isPaused,
                              premium: tier.premium,
                            ),
                            if (tier.premium) ...[
                              const SizedBox(height: 10),
                              Text(
                                'Speak',
                                style: Theme.of(context)
                                    .textTheme
                                    .displaySmall
                                    ?.copyWith(
                                      color: scheme.onSurface,
                                    ),
                              ),
                            ],
                            AnimatedSwitcher(
                              duration: const Duration(milliseconds: 200),
                              child: recording || state.isAiSpeaking
                                  ? Padding(
                                      key: const ValueKey('waveform'),
                                      padding: const EdgeInsets.only(top: 16),
                                      child: _Waveform(
                                        active: recording,
                                        color: tier.premium
                                            ? AppColors.goldBase
                                            : scheme.primary,
                                      ),
                                    )
                                  : const SizedBox(
                                      key: ValueKey('waveform-idle'),
                                      height: 22,
                                    ),
                            ),
                            const SizedBox(height: 20),
                            SpeakButton(
                              recording: recording,
                              aiSpeaking: state.isAiSpeaking,
                              busy: _micBusy,
                              onHoldStart: _holdStart,
                              onHoldEnd: _holdEnd,
                            ),
                            const SizedBox(height: 18),
                            Text(
                              'PRESS AND HOLD TO TALK',
                              style: Theme.of(context).textTheme.labelSmall
                                  ?.copyWith(
                                    letterSpacing: 1.4,
                                    color: tier.premium
                                        ? AppColors.goldDark
                                        : scheme.onSurfaceVariant,
                                  ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  // Transcript panel: expands upward from the pill, so the
                  // pill's chevron points UP when closed and DOWN when open.
                  AnimatedSize(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    alignment: Alignment.topCenter,
                    child: _transcriptOpen
                        ? SizedBox(
                            height: 176,
                            child: _MessageLog(
                              controller: _logScroll,
                              entries: _transcripts,
                              aiSpeaking: state.isAiSpeaking,
                              connected: state.isConnected,
                            ),
                          )
                        : const SizedBox(width: double.infinity),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 14, top: 8),
                    child: GoldenPill(
                      label: 'Transcript',
                      trailing: _transcripts.isEmpty ? null : '${_transcripts.length}',
                      open: _transcriptOpen,
                      onTap: () => setState(() => _transcriptOpen = !_transcriptOpen),
                    ),
                  ),
                ],
              ),
            ),
            _EngineStatusBar(
              downloading: _engineBusy,
              onDownload: _downloadModels,
            ),
          ],
        ),
      ),
    );
  }
}

/// Quiet status line above the speak button (§3.4): idle copy, or the live
/// state (recording / AI speaking / paused / connected).
class _HeroStatus extends StatelessWidget {
  const _HeroStatus({
    required this.recording,
    required this.aiSpeaking,
    required this.connected,
    required this.paused,
    required this.premium,
  });

  final bool recording;
  final bool aiSpeaking;
  final bool connected;
  final bool paused;
  final bool premium;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    final (icon, color, label) = paused
        ? (Icons.pause_circle_outline, scheme.onSurfaceVariant, 'Paused')
        : recording
            ? (Icons.mic, premium ? AppColors.goldDark : scheme.error, 'Listening…')
            : aiSpeaking
                ? (Icons.volume_up, premium ? AppColors.goldBase : scheme.primary, 'AI is speaking…')
                : connected
                    ? (Icons.check_circle, premium ? AppColors.goldBase : scheme.primary, 'Connected')
                    : (Icons.mic_none, scheme.onSurfaceVariant, 'Press and hold to talk');

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(icon, color: color, size: 18),
        const SizedBox(width: 8),
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(color: color),
        ),
      ],
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
      return 'Local speech-to-text model is missing. Download it below to '
          'enable on-device recognition.';
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
      statuses[EngineConfig.kokoro82mId] ?? VoiceEngineStatus.notStarted,
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

/// Scrollable conversation log: recognised user utterances as right-aligned
/// bubbles and a live left-aligned bubble while the AI is speaking.
/// One transcript-log entry: who said it and what.
class _LogEntry {
  const _LogEntry(this.text, {required this.fromUser});

  final String text;
  final bool fromUser;
}

class _MessageLog extends StatelessWidget {
  const _MessageLog({
    required this.controller,
    required this.entries,
    required this.aiSpeaking,
    required this.connected,
  });

  final ScrollController controller;
  final List<_LogEntry> entries;
  final bool aiSpeaking;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    final itemCount = entries.length + (aiSpeaking ? 1 : 0);
    if (itemCount == 0) {
      return Center(
        child: Text(
          connected
              ? 'Nothing yet — start speaking'
              : 'Hold the button to start a conversation',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
      );
    }
    return ListView.builder(
      controller: controller,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (index >= entries.length) {
          return const _AssistantSpeakingBubble();
        }
        final entry = entries[index];
        return entry.fromUser
            ? _UserBubble(text: entry.text)
            : _AssistantBubble(text: entry.text);
      },
    );
  }
}

/// Right-aligned transcript bubble styled as a user message.
class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: scheme.primaryContainer,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(4),
          ),
        ),
        child: Text(text, style: TextStyle(color: scheme.onPrimaryContainer)),
      ),
    );
  }
}

/// Left-aligned transcript bubble styled as an assistant message.
class _AssistantBubble extends StatelessWidget {
  const _AssistantBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Text(
          text,
          style: TextStyle(color: scheme.onSurfaceVariant),
        ),
      ),
    );
  }
}

/// Left-aligned bubble shown while TTS audio from the AI is playing back.
class _AssistantSpeakingBubble extends StatelessWidget {
  const _AssistantSpeakingBubble();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 12,
              height: 12,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 8),
            Text(
              'Assistant is speaking…',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

/// Bottom bar with per-engine readiness chips (STT/TTS) and model download
/// progress / retry actions.
class _EngineStatusBar extends ConsumerWidget {
  const _EngineStatusBar({required this.downloading, required this.onDownload});

  final bool downloading;
  final Future<void> Function() onDownload;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statuses = ref.watch(voiceEngineStatusProvider);
    final progress = ref.watch(modelDownloadProgressProvider).value;
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: _EngineStatusChip(
                      label: 'Whisper',
                      status:
                          statuses[EngineConfig.whisperTinyId] ??
                          VoiceEngineStatus.notStarted,
                      progress: progress,
                      onAction: downloading ? null : onDownload,
                    ),
                  ),
                  // Engines surfaced as `unavailable` are intentionally off —
                  // hide their chip entirely instead of offering a download
                  // that can never succeed.
                  if (statuses[EngineConfig.kokoro82mId] !=
                      VoiceEngineStatus.unavailable) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: _EngineStatusChip(
                        label: 'Kokoro',
                        status:
                            statuses[EngineConfig.kokoro82mId] ??
                            VoiceEngineStatus.notStarted,
                        progress: progress,
                        onAction: downloading ? null : onDownload,
                      ),
                    ),
                  ],
                ],
              ),
              if (downloading) ...[
                const SizedBox(height: 8),
                const LinearProgressIndicator(minHeight: 2),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Single engine readiness chip: status icon, label, progress or action.
class _EngineStatusChip extends StatelessWidget {
  const _EngineStatusChip({
    required this.label,
    required this.status,
    required this.progress,
    required this.onAction,
  });

  final String label;
  final VoiceEngineStatus status;
  final ModelDownloadProgress? progress;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final downloading = status == VoiceEngineStatus.downloading;
    final needsAction = status == VoiceEngineStatus.failed ||
        status == VoiceEngineStatus.notStarted;
    final actionLabel =
        status == VoiceEngineStatus.failed ? 'Retry' : 'Download';
    final percent = progress?.percent;

    final (icon, color, subtitle) = switch (status) {
      VoiceEngineStatus.ready => (
          Icons.check_circle,
          Colors.green.shade600,
          'ready',
        ),
      VoiceEngineStatus.downloading => (
          Icons.downloading,
          scheme.primary,
          percent == null
              ? 'downloading…'
              : 'downloading ${(percent * 100).round()}%',
        ),
      VoiceEngineStatus.failed => (
          Icons.error_outline,
          scheme.error,
          'download failed',
        ),
      VoiceEngineStatus.notStarted => (
          Icons.download_outlined,
          scheme.onSurfaceVariant,
          'not downloaded',
        ),
      VoiceEngineStatus.unavailable => (
          Icons.block,
          scheme.onSurfaceVariant,
          'unavailable',
        ),
    };

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: scheme.outline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: color, size: 18),
              const SizedBox(width: 6),
              Expanded(child: Text(label, style: theme.textTheme.labelLarge)),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(color: color),
          ),
          if (needsAction) ...[
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: onAction,
                icon: const Icon(Icons.download, size: 18),
                label: Text(actionLabel),
              ),
            ),
          ] else if (downloading) ...[
            const SizedBox(height: 6),
            LinearProgressIndicator(value: percent, minHeight: 4),
          ],
        ],
      ),
    );
  }
}