import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import './audio_session_manager.dart';
import './mic_capture_service.dart';
import './vad_processor.dart';
import '../ui/voice_controller.dart';

/// Orchestrates mic capture → VAD → VoiceController.
///
/// Manages the lifecycle of microphone audio capture and feeds chunks through
/// the [VadProcessor]. On the end of an utterance, the pipeline triggers the
/// [VoiceController]'s text turn (flush buffered mic audio → on-device STT →
/// LLM reply → on-device TTS), so transmission happens at the text-turn
/// boundary rather than over any raw-audio channel.
class VoiceCapturePipeline {
  VoiceCapturePipeline({
    required this.micCapture,
    required this.vad,
    required this.audioSession,
    required this.voiceController,
  }) {
    audioSession.onInterruption = _handleInterruption;
  }

  /// Microphone capture used for voice activity detection.
  final MicCaptureService micCapture;

  /// Voice activity detection processor.
  final VadProcessor vad;

  /// Platform audio session manager.
  final AudioSessionManager audioSession;

  /// Conversation controller receiving mic audio for on-device STT and
  /// driving the text-turn flow.
  final VoiceController voiceController;

  StreamSubscription<List<int>>? _micSubscription;
  StreamSubscription<VadState>? _vadSubscription;
  Future<void> _micSubscriptionTail = Future<void>.value();

  int _micGeneration = 0;
  int _lifecycleEpoch = 0;
  bool _isStopped = true;
  bool _isDisposed = false;
  int? _restartInFlightGeneration;
  bool _startInFlight = false;

  bool _isRecording = false;
  bool _isPaused = false;

  /// Grace before a hold-to-talk recording self-heals after an interruption
  /// that never resolved. An interruption-begin that is never followed by an
  /// end (spurious focus churn from the app's own playback stop/start) must
  /// not permanently kill the user's hold — after this delay the mic is
  /// restarted while the hold is still active.
  static const _selfHealDelay = Duration(milliseconds: 1200);
  Timer? _selfHealTimer;

  /// Deadline of the current post-reopen discard window (W1.5,
  /// docs/open-gaps.md P2 → docs/production-voice-ux-plan.md). Recomputed by
  /// [_armMicReopenDiscard] on every open/reopen, so rapid restarts extend
  /// the window. Epoch-zero default = no active window.
  ///
  /// In production [MicReopenDiscardGate] (mic_capture_service.dart) applies
  /// the same [micReopenDiscardWindow] rule at the capture boundary for ALL
  /// subscribers — including the controller's STT buffer, which this
  /// pipeline cannot see — making this local check redundant-but-harmless
  /// defence for direct wirings that bypass the gate (tests injecting a raw
  /// fake capture service).
  DateTime _micReopenDiscardUntil = DateTime.fromMillisecondsSinceEpoch(0);

  /// Whether the pipeline is actively capturing audio.
  bool get isRecording => _isRecording;

  /// Stream of VAD state changes for UI consumption.
  Stream<VadState> get vadStateChanges => vad.stateChanges;

  /// Start capturing microphone audio and running VAD.
  ///
  /// When the VAD detects the end of speech, the utterance is flushed through
  /// the [VoiceController]'s text-turn flow (on-device STT → LLM → on-device
  /// TTS).
  Future<void> startRecording() async {
    if (_isDisposed || _isRecording || _startInFlight) return;
    _startInFlight = true;
    _restartInFlightGeneration = null;
    final epoch = ++_lifecycleEpoch;
    _isStopped = false;
    if (kDebugMode) {
      debugPrint('VoicePipeline: startRecording (focus → mic → VAD)');
    }

    try {
      await audioSession.requestAudioFocus();
      if (!_isLifecycleCurrent(epoch)) return;
      await micCapture.start();
      if (!_isLifecycleCurrent(epoch)) {
        if (_isStopped) await _stopMicBestEffort();
        return;
      }
      _armMicReopenDiscard();

      await _listenMic(lifecycleEpoch: epoch);
      if (!_isLifecycleCurrent(epoch)) return;
      await _vadSubscription?.cancel();
      if (!_isLifecycleCurrent(epoch)) return;
      _vadSubscription = vad.stateChanges.listen(_onVadStateChange);

      _isRecording = true;
      _isPaused = false;

      // Sync VoiceController state (mic start is a no-op since already running).
      if (!_isLifecycleCurrent(epoch)) {
        _isRecording = false;
        await _cancelMicSubscription();
        return;
      }
      await voiceController.startRecording();
    } catch (e) {
      if (_isLifecycleCurrent(epoch)) {
        _isStopped = true;
        _lifecycleEpoch++;
        await _cancelMicSubscription();
      }
      rethrow;
    } finally {
      _startInFlight = false;
    }
  }

  /// Subscribes to the mic stream. Shared by [startRecording], the
  /// interruption-resume path and the self-heal path so error/done handling
  /// can never drift apart.
  Future<void> _listenMic({int? lifecycleEpoch}) {
    final generation = ++_micGeneration;
    final previous = _micSubscription;
    _micSubscription = null;
    final operation = _micSubscriptionTail.then<void>(
      (_) => _replaceMicSubscription(
        generation: generation,
        previous: previous,
        lifecycleEpoch: lifecycleEpoch,
      ),
    );
    _micSubscriptionTail = operation.catchError((Object _, StackTrace _) {});
    return operation;
  }

  Future<void> _replaceMicSubscription({
    required int generation,
    required StreamSubscription<List<int>>? previous,
    required int? lifecycleEpoch,
  }) async {
    if (previous != null) {
      await previous.cancel();
    }
    if (!_canAttach(generation, lifecycleEpoch)) return;

    var chunkCount = 0;
    final subscription = micCapture.audioStream.listen(
      (chunk) {
        if (!_isMicGenerationCurrent(generation)) return;
        // W1.5: drop warm-up/glitch frames captured in the first
        // [micReopenDiscardWindow] after this (re)open at the pipeline
        // boundary, before they reach VAD or the flush it triggers. In
        // production the service-boundary gate has already dropped them for
        // every subscriber (including the controller's parallel STT-buffer
        // subscription); this local check covers ungated wirings.
        if (DateTime.now().isBefore(_micReopenDiscardUntil)) return;
        chunkCount++;
        if (kDebugMode) {
          if (chunkCount == 1) {
            debugPrint(
              'VoicePipeline: first mic chunk ${chunk.length} samples',
            );
          } else if (chunkCount % 50 == 0) {
            // ~1s heartbeat at 20 ms frames; RMS approximates the mic level.
            debugPrint(
              'VoicePipeline: chunks=$chunkCount rms=${_chunkRmsDb(chunk).toStringAsFixed(1)}dBFS',
            );
          }
        }
        _onMicAudio(chunk);
      },
      onError: (Object e) {
        if (!_isMicGenerationCurrent(generation)) return;
        if (kDebugMode) {
          debugPrint('VoicePipeline: mic stream error: $e');
        }
        // A recorder that died mid-hold (e.g. ERROR_DEAD_OBJECT from audio
        // focus churn on repeated start/stop) must not end the user's
        // utterance. Restart the mic; a persistent failure surfaces through
        // the restart instead of an error banner that lies about a recovered
        // hold.
        unawaited(_restartMic(generation));
      },
      onDone: () {
        if (!_isMicGenerationCurrent(generation)) return;
        // The recorder died mid-hold (or the service is being torn down). If
        // the hold is still active, restart the mic so the utterance survives.
        if (kDebugMode) {
          debugPrint('VoicePipeline: mic stream ended');
        }
        unawaited(_restartMic(generation));
      },
    );
    if (!_canAttach(generation, lifecycleEpoch)) {
      await subscription.cancel();
      return;
    }
    _micSubscription = subscription;
  }

  /// Restarts the mic capture and re-subscribes, preserving the buffered STT
  /// audio (unlike [startRecording], which clears it). A no-op when the hold
  /// is over or the session is paused (a real interruption still owns the
  /// speaker). Failures are surfaced through [voiceController.reportError].
  Future<void> _restartMic(int generation) async {
    if (!_isMicGenerationCurrent(generation) ||
        !_isRecording ||
        _isPaused ||
        _restartInFlightGeneration != null) {
      return;
    }
    _restartInFlightGeneration = generation;
    _micGeneration++;
    final epoch = _lifecycleEpoch;
    if (kDebugMode) {
      debugPrint('VoicePipeline: restarting mic (self-heal)');
    }
    try {
      await micCapture.start();
      if (!_isRestartCurrent(epoch)) {
        if (_isStopped) await _stopMicBestEffort();
        return;
      }
      _armMicReopenDiscard();
      await _listenMic(lifecycleEpoch: epoch);
    } catch (e) {
      if (_isRestartCurrent(epoch)) {
        if (kDebugMode) {
          debugPrint('VoicePipeline: mic restart failed: $e');
        }
        voiceController.reportError(e);
      }
    } finally {
      if (_restartInFlightGeneration == generation) {
        _restartInFlightGeneration = null;
      }
    }
  }

  bool _isLifecycleCurrent(int epoch) {
    return !_isDisposed && !_isStopped && epoch == _lifecycleEpoch;
  }

  bool _isMicGenerationCurrent(int generation) {
    return !_isDisposed && !_isStopped && generation == _micGeneration;
  }

  bool _isRestartCurrent(int epoch) {
    return _isLifecycleCurrent(epoch) && _isRecording && !_isPaused;
  }

  bool _canAttach(int generation, int? lifecycleEpoch) {
    return _isMicGenerationCurrent(generation) &&
        !_isPaused &&
        (lifecycleEpoch == null || lifecycleEpoch == _lifecycleEpoch);
  }

  Future<void> _cancelMicSubscription() async {
    _micGeneration++;
    final subscription = _micSubscription;
    _micSubscription = null;
    try {
      await subscription?.cancel();
    } catch (_) {}
    await _micSubscriptionTail;
  }

  Future<void> _stopMicBestEffort() async {
    try {
      await micCapture.stop();
    } catch (_) {}
  }

  /// Arms the W1.5 post-reopen discard window: mic frames arriving before
  /// `now + [micReopenDiscardWindow]` (the shared constant in
  /// mic_capture_service.dart) are dropped in [_listenMic]. Called on every
  /// open/reopen (initial start, self-heal restart, interruption resume),
  /// each call recomputing the deadline so rapid restarts extend the window.
  void _armMicReopenDiscard() {
    _micReopenDiscardUntil = DateTime.now().add(micReopenDiscardWindow);
  }

  void _onMicAudio(List<int> chunk) {
    // No capture while paused (interruption) or while the assistant's own
    // TTS is playing through the speaker — the mic would otherwise feed the
    // assistant's voice back through VAD/STT as a phantom user turn.
    if (_isPaused || voiceController.state.isAiSpeaking) return;
    vad.processChunk(chunk);
  }

  void _onVadStateChange(VadState state) {
    if (kDebugMode) {
      debugPrint('VoicePipeline: VAD → $state');
    }
    switch (state) {
      case VadState.speechStarted:
        break;
      case VadState.speechStopped:
        // Mid-hold silence is NOT end-of-utterance: the user is still
        // holding and may resume speaking. The hold's release flush owns
        // that turn boundary — flushing here races it, and under the
        // one-pending busy-state cap one of the two utterances gets dropped
        // with a notice (observed as phantom "dropped" notices on device).
        // The pipeline's own flag is set synchronously at startRecording,
        // before the controller's async flag catches up.
        if (voiceController.state.isRecording || _isRecording) break;
        // End-of-utterance: flush the buffered mic audio through the
        // controller's text turn (on-device STT → LLM → TTS).
        // flushTranscriptionBuffer copies and clears the buffer
        // synchronously before its first await, so a new utterance cannot
        // interleave with the transcript being produced.
        unawaited(voiceController.flushTranscriptionBuffer());
      case VadState.idle:
        break;
    }
  }

  /// Root-mean-square level of a PCM16 chunk in dBFS (max 0, silence ≈ -96).
  double _chunkRmsDb(List<int> chunk) {
    if (chunk.isEmpty) return -96;
    var sumSq = 0.0;
    for (final sample in chunk) {
      sumSq += sample * sample;
    }
    final rms = sqrt(sumSq / chunk.length) / 32768.0;
    return rms <= 0 ? -96 : 20 * log(rms) / ln10;
  }

  /// Stop capturing microphone audio and tear down the pipeline.
  Future<void> stopRecording() async {
    final wasRecording = _isRecording;
    final hasResources =
        _isRecording ||
        _startInFlight ||
        _restartInFlightGeneration != null ||
        _micSubscription != null ||
        _vadSubscription != null;
    _isStopped = true;
    _lifecycleEpoch++;
    _restartInFlightGeneration = null;
    _isRecording = false;

    _selfHealTimer?.cancel();
    _selfHealTimer = null;
    if (!hasResources) return;
    if (kDebugMode) {
      debugPrint('VoicePipeline: stopRecording');
    }

    final vadSubscription = _vadSubscription;
    _vadSubscription = null;
    try {
      await vadSubscription?.cancel();
    } catch (_) {}
    await _cancelMicSubscription();

    if (!_isPaused) {
      await _stopMicBestEffort();
    }

    if (!voiceController.state.isAiSpeaking) {
      await audioSession.abandonAudioFocus();
    }

    if (wasRecording || voiceController.state.isRecording) {
      await voiceController.stopRecording();
    }
  }

  /// Bumped on every interruption transition; pause/resume coroutines bail
  /// when their epoch is stale, so a begin→end flip-flop can never leave the
  /// new mic subscription cancelled by an old pause coroutine.
  int _interruptionEpoch = 0;

  void _handleInterruption(bool isInterrupted) {
    _interruptionEpoch++;
    if (isInterrupted) {
      _isPaused = true;
      final epoch = _interruptionEpoch;
      unawaited(_pauseForInterruption(epoch));
    } else {
      final epoch = _interruptionEpoch;
      unawaited(_resumeAfterInterruption(epoch));
    }
  }

  Future<void> _pauseForInterruption(int epoch) async {
    final lifecycleEpoch = _lifecycleEpoch;
    await _cancelMicSubscription();
    if (epoch != _interruptionEpoch ||
        !_isLifecycleCurrent(lifecycleEpoch) ||
        !_isRecording) {
      return;
    }
    await _stopMicBestEffort();
    if (epoch != _interruptionEpoch ||
        !_isLifecycleCurrent(lifecycleEpoch) ||
        !_isRecording) {
      return;
    }
    // Pause any in-flight TTS playback and mark the session paused.
    await voiceController.pauseForInterruption();
    if (epoch != _interruptionEpoch ||
        !_isLifecycleCurrent(lifecycleEpoch) ||
        !_isRecording) {
      return;
    }
    // A hold-to-talk must not be killed by a transient interruption that
    // never resolves (spurious focus churn from the app's own playback
    // stop/start). If the user is still holding when the grace elapses and
    // no interruption-end has arrived, restart the mic.
    _armSelfHeal(epoch);
  }

  /// Arms the self-heal fallback for a paused hold: after [_selfHealDelay],
  /// if the hold is still active and no newer interruption event has
  /// superseded [epoch], resume the mic exactly as an interruption-end would.
  void _armSelfHeal(int epoch) {
    _selfHealTimer?.cancel();
    _selfHealTimer = Timer(_selfHealDelay, () {
      _selfHealTimer = null;
      if (!_isRecording || _isStopped || epoch != _interruptionEpoch) return;
      if (kDebugMode) {
        debugPrint('VoicePipeline: interruption unresolved — self-healing mic');
      }
      unawaited(_resumeAfterInterruption(epoch));
    });
  }

  Future<void> _resumeAfterInterruption(int epoch) async {
    if (_isDisposed) return;
    final lifecycleEpoch = _lifecycleEpoch;
    _selfHealTimer?.cancel();
    _selfHealTimer = null;
    _isPaused = false;
    // Clear the paused flag regardless of whether mic restart succeeds.
    await voiceController.resumeAfterInterruption();
    if (epoch != _interruptionEpoch ||
        !_isRecording ||
        !_isLifecycleCurrent(lifecycleEpoch)) {
      return;
    }
    try {
      await micCapture.start();
      if (epoch != _interruptionEpoch ||
          !_isRecording ||
          !_isLifecycleCurrent(lifecycleEpoch)) {
        if (_isStopped) await _stopMicBestEffort();
        return;
      }
      _armMicReopenDiscard();
      await _listenMic(lifecycleEpoch: lifecycleEpoch);
    } catch (e) {
      if (epoch == _interruptionEpoch &&
          _isRecording &&
          _isLifecycleCurrent(lifecycleEpoch)) {
        if (kDebugMode) {
          debugPrint(
            'VoiceCapturePipeline: mic restart after '
            'interruption failed: $e',
          );
        }
        // Surface a mic failure (e.g. permission revoked mid-session) so the
        // UI can present a recovery action instead of failing silently.
        voiceController.reportError(e);
      }
    }
  }

  /// Release all resources.
  Future<void> dispose() async {
    if (_isDisposed) return;
    if (kDebugMode) {
      debugPrint('Pipeline dispose (recording was $_isRecording)');
    }
    final wasRecording = _isRecording;
    _isDisposed = true;
    _isStopped = true;
    _lifecycleEpoch++;
    _restartInFlightGeneration = null;
    _isRecording = false;
    _selfHealTimer?.cancel();
    _selfHealTimer = null;
    audioSession.onInterruption = null;

    final vadSubscription = _vadSubscription;
    _vadSubscription = null;
    try {
      await vadSubscription?.cancel();
    } catch (_) {}
    await _cancelMicSubscription();
    if (!_isPaused) {
      await _stopMicBestEffort();
    }

    // stopRecording may have kept focus (reply still playing); the pipeline
    // is going away, so focus ownership ends here unconditionally.
    await audioSession.abandonAudioFocus();
    if (wasRecording || voiceController.state.isRecording) {
      await voiceController.stopRecording();
    }
  }
}
