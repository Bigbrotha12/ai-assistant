import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import './audio_session_manager.dart';
import './vad_processor.dart';
import './voice_capture_pipeline.dart';
import '../ui/voice_controller_provider.dart';
import '../ui/voice_lifecycle_observer.dart';
import '../ui/voice_settings_providers.dart';

/// Voice activity detection processor.
///
/// Sensitivity and minimum silence duration are sourced from persisted
/// [VoiceSettings]. Settings are read (not watched) at build time: the
/// async settings load (loading → data) must not rebuild this provider at
/// startup — a rebuild cascades into the capture pipeline and tears down
/// an in-flight hold-to-talk. Live settings changes are applied to the
/// running processor in place by [VoiceCapturePipelineNotifier].
final vadProcessorProvider = Provider<VadProcessor>((ref) {
  final settings = ref.read(voiceSettingsProvider).value;
  final processor = EnergyBasedVadProcessor(
    sensitivity: settings?.vadSensitivity ?? 0.5,
    minSilenceSeconds: settings?.minTurnSeconds ?? 0.5,
  );
  ref.onDispose(processor.dispose);
  return processor;
});

/// Platform audio session manager for voice conversations.
final audioSessionManagerProvider = Provider<AudioSessionManager>((ref) {
  final manager = AudioSessionManagerImpl();
  manager.initialize(); // Fire-and-forget; best-effort init.
  ref.onDispose(manager.dispose);
  return manager;
});

/// Orchestrates mic capture → VAD → VoiceController.
///
/// Rebuilds when any upstream dependency changes (VoiceController,
/// VAD processor, mic capture, or audio session).
final voiceCapturePipelineProvider =
    NotifierProvider<VoiceCapturePipelineNotifier, VoiceCapturePipeline>(
      VoiceCapturePipelineNotifier.new,
    );

class VoiceCapturePipelineNotifier extends Notifier<VoiceCapturePipeline> {
  static int _buildCount = 0;

  /// Serialises lifecycle transitions in DISPATCH order. Background and
  /// foreground events can fire back-to-back (a pause→resume flick), and each
  /// handler awaits several platform calls before it takes effect; without a
  /// tail a foreground arriving mid-background-teardown would run first, be
  /// swallowed by the still-pending `enterBackground`, and strand the session
  /// backgrounded while the app is visible. The last event to arrive must win.
  Future<void> _lifecycleTail = Future.value();

  /// Upper bound on a single lifecycle transition. Platform teardown calls
  /// (mic stop, playback stop, focus, wake lock) are unguarded awaits; if one
  /// hangs, the tail must keep advancing so the transition that wins is the
  /// last event the OS dispatched — mirroring the codebase's convention of
  /// bounding every platform await (cf. `interrupt()`). A straggler from the
  /// timed-out transition cannot re-flip the flag afterwards: `enterBackground`
  /// / `exitBackground` set `_isBackgrounded` synchronously at entry, before
  /// any platform await, so they are never re-entered by a stale continuation.
  static const _lifecycleTransitionTimeout = Duration(seconds: 2);

  @override
  VoiceCapturePipeline build() {
    _buildCount++;
    if (kDebugMode) {
      debugPrint('Pipeline build #$_buildCount (rebuild=$_buildCount > 1)');
    }
    final pipeline = VoiceCapturePipeline(
      micCapture: ref.watch(micCaptureServiceProvider),
      vad: ref.watch(vadProcessorProvider),
      audioSession: ref.watch(audioSessionManagerProvider),
      voiceController: ref.watch(voiceControllerProvider),
    );

    // Apply voice-settings changes to the running VAD in place instead of
    // rebuilding the processor (and thereby this pipeline): a rebuild while
    // a hold is active stops the mic mid-utterance and drops the buffered
    // audio. Fires once at startup with the loaded settings, so the first
    // frame of a session already carries the persisted values.
    final vadSettingsSub = ref.listen(
      voiceSettingsProvider,
      (_, next) {
        pipeline.vad.setSensitivity(next.value?.vadSensitivity ?? 0.5);
        pipeline.vad.setMinSilenceSeconds(next.value?.minTurnSeconds ?? 0.5);
      },
    );
    ref.onDispose(() {
      vadSettingsSub.close();
      pipeline.dispose();
    });

    // Register a lifecycle observer here rather than in
    // VoiceControllerNotifier: the pipeline provider depends on the
    // controller, so a lifecycle read of the pipeline from the controller's
    // ref closed a dependency circle (Riverpod CircularDependencyError on
    // every background transition). The pipeline owns the recording state
    // this teardown needs anyway. Re-registration pairs with the notifier
    // rebuilds (onDispose removes the previous observer).
    final observer = VoiceLifecycleObserver(
      onBackground: _handleBackground,
      onForeground: _handleForeground,
    );
    WidgetsBinding.instance.addObserver(observer);
    ref.onDispose(observer.dispose);

    return pipeline;
  }

  /// Suspends recording and playback when the app moves to the background but
  /// KEEPS the in-flight LLM turn alive: inference completes in the background
  /// and its reply queues (persisted via onTranscript) for playback on the next
  /// foreground. The audio-safe parts of a full teardown still happen — mic,
  /// player, and focus are all released so nothing leaks while not visible.
  Future<void> _handleBackground() => _enqueueLifecycleTransition(
        _applyBackground,
        'background',
      );

  /// Resumes a backgrounded session on foreground: any reply held while the
  /// app was hidden starts playing (playback re-acquires focus), and a
  /// session left paused by an OS audio interruption is resumed. The
  /// conversation itself stays connected across the background period.
  Future<void> _handleForeground() => _enqueueLifecycleTransition(
        _applyForeground,
        'foreground',
      );

  /// Queues a lifecycle transition behind any still-running one so the last
  /// event to arrive takes effect last. Each transition is bounded so a hung
  /// platform teardown can never wedge the whole chain (and with it every
  /// subsequent event). Errors — including the bound's [TimeoutException] —
  /// are swallowed: lifecycle transitions are best-effort teardown, and the
  /// observer fires them intentionally unawaited.
  Future<void> _enqueueLifecycleTransition(
    Future<void> Function() action,
    String name,
  ) {
    final next = _lifecycleTail.then(
      (_) => action().timeout(_lifecycleTransitionTimeout),
    );
    _lifecycleTail = next.catchError((Object error, StackTrace stack) {
      if (kDebugMode) {
        debugPrint('Pipeline: $name transition failed: $error');
      }
    });
    return _lifecycleTail;
  }

  Future<void> _applyBackground() async {
    if (kDebugMode) {
      debugPrint('Pipeline: app → background (recording=${state.isRecording})');
    }
    // Capture references before the first await: the notifier may be
    // rebuilt/disposed while the teardown is in flight, which would leave
    // this ref dead mid-await.
    final pipeline = state;
    final controller = ref.read(voiceControllerProvider);
    final session = ref.read(audioSessionManagerProvider);
    // Flag the controller backgrounded FIRST: enterBackground sets
    // `_isBackgrounded` synchronously before its own platform awaits, so a
    // later leg (or a straggling timed-out continuation) can never re-enter it
    // and re-strand the session after a foreground has cleared the flag. Each
    // remaining leg is also gated on the flag: a straggler resuming past the
    // tail's bound must not stop the mic or yank focus off a reply the
    // resumed drain is already streaming.
    await controller.enterBackground();
    // The pipeline stop is NOT gated on the flag: it is idempotent, and if the
    // straggler parked inside enterBackground past the tail's bound it MUST
    // still cancel the mic subscription/VAD — otherwise the mic records (and
    // can fire a phantom turn) for the whole background period and beyond. Its
    // own focus abandon is already guarded by `isAiSpeaking`, and the resumed
    // drain re-requests focus anyway.
    if (pipeline.isRecording) {
      await pipeline.stopRecording();
    }
    // enterBackground stops playback but owns no focus; a reply that was
    // playing at this moment would otherwise leak the audio focus for the app
    // session. Unlike the mic stop, yanking focus off a reply the resumed
    // drain is already streaming is a real harm, so gate it on the flag.
    if (controller.isBackgrounded) {
      await session.abandonAudioFocus();
    }
  }

  Future<void> _applyForeground() async {
    final controller = ref.read(voiceControllerProvider);
    await controller.exitBackground();
    if (controller.state.isPaused) {
      await controller.resumeAfterInterruption();
    }
  }
}
