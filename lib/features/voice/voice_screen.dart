import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../chat/chat_providers.dart';
import '../chat/conversation_list.dart';
import '../chat/database_providers.dart';
import '../chat/message_model.dart';
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

  /// Number of [_transcripts] entries seeded from the active conversation's
  /// persisted history (see [_seedFromConversation]). Live appends must never
  /// dedupe against this seeded prefix — the user may legitimately repeat the
  /// exact text of their last stored message.
  int _seededCount = 0;

  /// Bumped on every re-seed request so a slow store load for a stale
  /// conversation can never clobber a newer one (e.g. rapid history switches).
  int _seedEpoch = 0;

  /// True while [_seedFromConversation] has cleared the panel but not yet
  /// landed the loaded history. Live appends landing in that window are
  /// queued into [_pendingLive] instead of being appended, so they can never
  /// scramble the seeded order or duplicate a message the seed then re-imports.
  bool _seeding = false;

  /// Live transcript entries received while [_seeding]; replayed after the
  /// seed lands (in arrival order, after the seeded prefix).
  final _pendingLive = <_LogEntry>[];

  /// Composer input; voice hold-to-talk when false, text composer when true.
  bool _textInputMode = false;

  final _textInput = TextEditingController();

  /// True while a text-mode turn is streaming. The controller serialises turns
  /// internally, but the UI disables the SpeakButton and composer while it is
  /// set so the in-flight turn is never stacked visually.
  bool _turnInFlight = false;

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
  void initState() {
    super.initState();
    // The active conversation may already exist (set by an earlier chat/voice
    // session); ensure one exists, then seed the transcript from its history.
    final id = ref.read(activeConversationIdProvider.notifier).ensure();
    _seedFromConversation(id);
  }

  @override
  void dispose() {
    _logScroll.dispose();
    _textInput.dispose();
    // The voice providers own their teardown: `VoiceCapturePipelineNotifier`
    // and `VoiceControllerNotifier` dispose the pipeline (stopping any active
    // recording) and the controller (ending the conversation) via their
    // `ref.onDispose` callbacks once the last listener — this screen and the
    // conversation-state notifier — is gone. Calling `ref.read(...)` here is
    // both unsafe (Riverpod forbids ref after unmount) and unnecessary.
    super.dispose();
  }

  /// Loads [id]'s messages from the store and seeds `_transcripts` with them.
  ///
  /// Clears the panel immediately (switching conversations must never show
  /// stale bubbles) and resets `_seededCount` so the whole list is treated as
  /// seeded history by the live-append dedupe. A store load must not race an
  /// unopened database, so [databaseReadyProvider] is awaited first.
  Future<void> _seedFromConversation(String id) async {
    final epoch = ++_seedEpoch;
    // A shared controller carries per-turn state across conversations; clear
    // its fields so a stale lastReply / onDeviceTranscript from the previous
    // conversation can never re-emit into this one as a phantom bubble.
    ref.read(voiceControllerProvider).clearTurnFields();
    _seeding = true;
    _pendingLive.clear();
    if (_transcripts.isNotEmpty || _seededCount != 0) {
      setState(() {
        _transcripts.clear();
        _seededCount = 0;
      });
    }
    await ref.read(databaseReadyProvider);
    if (!mounted || epoch != _seedEpoch) {
      if (mounted) setState(() => _seeding = false);
      return;
    }
    final conversation = await ref.read(chatStoreProvider).loadConversation(id);
    if (!mounted || epoch != _seedEpoch) {
      if (mounted) setState(() => _seeding = false);
      return;
    }
    final entries = <_LogEntry>[];
    for (final message in conversation?.messages ?? const <Message>[]) {
      switch (message.role) {
        case MessageRole.user:
          entries.add(_LogEntry(message.content, fromUser: true));
        case MessageRole.assistant:
          entries.add(_LogEntry(message.content, fromUser: false));
        // Tool/system rows are internal plumbing, never surfaced.
        case MessageRole.tool || MessageRole.system:
          break;
      }
    }
    setState(() {
      _transcripts.addAll(entries);
      _seededCount = _transcripts.length;
      // Replay any live appends that landed while the seed was loading, in
      // order, after the seeded prefix. They were accepted (deduped) at
      // arrival time, so replaying them keeps order without duplication.
      if (_pendingLive.isNotEmpty) {
        _transcripts.addAll(_pendingLive);
        _pendingLive.clear();
      }
      _seeding = false;
    });
    _scrollLogToEnd();
  }

  /// Appends a freshly recognised user utterance to the log. Empty text is
  /// ignored so the list stays stable across unrelated state updates. The
  /// consecutive-identical dedupe only applies to LIVE appends: once the
  /// transcript has grown past [_seededCount] the last entry is known to be
  /// live, so a repeated utterance (same value re-emitted across state flips)
  /// is dropped — but it never collapses a live utterance into the seeded
  /// history.
  void _appendTranscript(VoiceConversationState state) {
    final text = state.onDeviceTranscript;
    if (text == null || text.trim().isEmpty) return;
    if (_transcripts.length > _seededCount &&
        _transcripts.isNotEmpty &&
        _transcripts.last.fromUser &&
        _transcripts.last.text == text) {
      return;
    }
    final entry = _LogEntry(text, fromUser: true);
    if (_seeding) {
      // The seed will re-import this utterance if it has been persisted; queue
      // it so it is replayed in order after the seed lands (never scrambled
      // ahead of the loaded history).
      _pendingLive.add(entry);
      return;
    }
    setState(() => _transcripts.add(entry));
    _scrollLogToEnd();
  }

  /// Appends the assistant's final reply to the log. [lastReply] is cleared
  /// at the start of each turn and set once at its end, so this fires exactly
  /// once per completed turn (even for identical reply text). Like
  /// [_appendTranscript], the dedupe is skipped while the log is still inside
  /// the seeded prefix.
  void _appendAssistantReply(VoiceConversationState state) {
    final text = state.lastReply;
    if (text == null || text.trim().isEmpty) return;
    if (_transcripts.length > _seededCount &&
        _transcripts.isNotEmpty &&
        !_transcripts.last.fromUser &&
        _transcripts.last.text == text) {
      return;
    }
    final entry = _LogEntry(text, fromUser: false);
    if (_seeding) {
      // Queue as with [_appendTranscript]; replayed after the seed lands.
      _pendingLive.add(entry);
      return;
    }
    setState(() => _transcripts.add(entry));
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
      // A typed turn while the AI is speaking stops it first (barge-in), so
      // the new reply is not spoken over the tail of the previous one.
      if (controller.state.isAiSpeaking) {
        await controller.interrupt();
      }
      if (!controller.state.isConnected) {
        await controller.startConversation();
      }
        if (!controller.state.isConnected) {
          return; // Session error is already surfaced through the state.
        }
        // Barge-in: holding the talk button while the AI is replying stops it
        // immediately so the user's utterance is captured instead of being
        // discarded by the mic gates.
        if (controller.state.isAiSpeaking) {
          await controller.interrupt();
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

  void _openVoiceSettings() => _push(const VoiceSettingsScreen());

  /// Switches the active conversation to a fresh, empty one.
  void _newConversation() {
    ref.read(activeConversationIdProvider.notifier).newConversation();
    _seedFromConversation(ref.read(activeConversationIdProvider.notifier).ensure());
  }

  /// Opens the session history; selecting a conversation switches the active
  /// id and re-seeds the transcript from that conversation's messages.
  Future<void> _openHistory() async {
    final selected = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ConversationListScreen()),
    );
    if (selected != null && mounted) {
      ref.read(activeConversationIdProvider.notifier).set(selected);
      _seedFromConversation(selected);
    }
  }

  /// Sends the composer text as a text-mode turn: starts the conversation
  /// session when needed, then hands off to the controller with `speakReply:
  /// false` so TTS never runs for a typed message. The field is cleared only
  /// once the message has actually been accepted by the controller.
  Future<void> _sendText() async {
    final text = _textInput.text.trim();
    if (text.isEmpty || _turnInFlight || _micBusy) return;
    final controller = ref.read(voiceControllerProvider);
    setState(() {
      _turnInFlight = true;
      _localError = null;
    });
    try {
      // A typed turn while the AI is speaking stops it first (barge-in), so
      // the new reply is not spoken over the tail of the previous one and the
      // typed turn can never be silently dropped by a later voice barge-in.
      if (controller.state.isAiSpeaking) {
        await controller.interrupt();
      }
      if (!controller.state.isConnected) {
        await controller.startConversation();
      }
      if (!controller.state.isConnected) {
        return; // Session error already surfaced through the state.
      }
      await controller.sendText(text, speakReply: false);
      _textInput.clear();
    } catch (e) {
      if (mounted) {
        setState(() => _localError = e.toString());
      }
    } finally {
      if (mounted) setState(() => _turnInFlight = false);
    }
  }

  void _setTextInputMode(bool value) {
    if (value == _textInputMode) return;
    setState(() => _textInputMode = value);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceConversationStateProvider);
    ref.listen(voiceConversationStateProvider, (_, next) {
      _appendTranscript(next);
      _appendAssistantReply(next);
    });
    // Re-seed whenever the app-wide active conversation changes while this
    // screen is mounted (e.g. a history pick in another surface).
    ref.listen<String?>(activeConversationIdProvider, (previous, next) {
      if (next != null && next != previous) {
        _seedFromConversation(next);
      }
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
            key: const Key('new-conversation'),
            tooltip: 'New Conversation',
            icon: const Icon(Icons.add_comment_outlined),
            onPressed: _newConversation,
          ),
          IconButton(
            key: const Key('history'),
            tooltip: 'History',
            icon: const Icon(Icons.history),
            onPressed: _openHistory,
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
                              generating: state.isGenerating,
                              connected: state.isConnected,
                              paused: state.isPaused,
                              premium: tier.premium,
                            ),
                            if (state.notice != null) ...[
                              const SizedBox(height: 6),
                              Text(
                                state.notice!,
                                textAlign: TextAlign.center,
                                style: Theme.of(context)
                                    .textTheme
                                    .labelSmall
                                    ?.copyWith(
                                      color: scheme.onSurfaceVariant,
                                    ),
                              ),
                            ],
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
                            if (_textInputMode) ...[
                              _Composer(
                                controller: _textInput,
                                enabled: !_turnInFlight && !_micBusy,
                                canSend: !_turnInFlight &&
                                    !_micBusy &&
                                    _textInput.text.trim().isNotEmpty,
                                onSend: _sendText,
                                onChanged: () => setState(() {}),
                              ),
                            ] else ...[
                              SpeakButton(
                                recording: recording,
                                aiSpeaking: state.isAiSpeaking,
                                busy: _micBusy || _turnInFlight,
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
                          ],
                        ),
                      ),
                    ),
                  ),
                  // Input mode toggle lives below the scrollable hero area so
                  // it is never clipped by the viewport or overlapped by the
                  // transcript panel. The Stop control (barge-in) sits beside
                  // it while the AI is speaking, clear of the SpeakButton's
                  // hit area.
                  Padding(
                    padding: const EdgeInsets.only(top: 8, bottom: 8),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        _InputModeToggle(
                          value: _textInputMode,
                          enabled: !_turnInFlight && !recording,
                          onChanged: _setTextInputMode,
                        ),
                        if (state.isAiSpeaking) ...[
                          const SizedBox(width: 12),
                          IconButton(
                            key: const Key('voice-stop-speaking'),
                            tooltip: 'Stop speaking',
                            icon: const Icon(Icons.stop_circle_outlined),
                            color: scheme.primary,
                            onPressed: () {
                              unawaited(
                                ref.read(voiceControllerProvider).interrupt(),
                              );
                            },
                          ),
                        ],
                      ],
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
/// state (recording / generating / AI speaking / paused / connected).
class _HeroStatus extends StatelessWidget {
  const _HeroStatus({
    required this.recording,
    required this.aiSpeaking,
    required this.generating,
    required this.connected,
    required this.paused,
    required this.premium,
  });

  final bool recording;
  final bool aiSpeaking;
  final bool generating;
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
                : generating
                    ? (
                        Icons.hourglass_top,
                        scheme.onSurfaceVariant,
                        'Working…',
                      )
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

/// Compact text composer replacing the SpeakButton in text mode. Sends via the
/// keyboard action or the trailing send button; no attachments/tool chips yet.
class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.canSend,
    required this.onSend,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool canSend;
  final VoidCallback onSend;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(AppRadii.lg),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('voice-composer-field'),
                controller: controller,
                enabled: enabled,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) {
                  if (canSend) onSend();
                },
                onChanged: (_) => onChanged(),
                decoration: const InputDecoration(
                  hintText: 'Message the assistant…',
                  border: InputBorder.none,
                  isDense: true,
                ),
              ),
            ),
            IconButton(
              key: const Key('voice-composer-send'),
              icon: const Icon(Icons.send),
              tooltip: 'Send',
              color: scheme.primary,
              onPressed: canSend ? onSend : null,
            ),
          ],
        ),
      ),
    );
  }
}

/// Small segmented voice / text mode switch shown under the input area.
class _InputModeToggle extends StatelessWidget {
  const _InputModeToggle({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<bool>(
      key: const Key('voice-input-mode-toggle'),
      segments: const [
        ButtonSegment(
          value: false,
          icon: Icon(Icons.mic_none, size: 18),
          label: Text('Voice'),
        ),
        ButtonSegment(
          value: true,
          icon: Icon(Icons.keyboard_outlined, size: 18),
          label: Text('Text'),
        ),
      ],
      selected: {value},
      onSelectionChanged: enabled ? (selection) => onChanged(selection.single) : null,
      showSelectedIcon: false,
      style: ButtonStyle(
        visualDensity: VisualDensity.compact,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: WidgetStatePropertyAll(
          Theme.of(context).textTheme.labelMedium,
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
                  if (statuses[EngineConfig.supertonic3Id] !=
                      VoiceEngineStatus.unavailable) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: _EngineStatusChip(
                        label: 'Supertonic 3',
                        status:
                            statuses[EngineConfig.supertonic3Id] ??
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