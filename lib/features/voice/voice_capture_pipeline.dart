import 'dart:async';

import 'package:flutter/foundation.dart';

import 'audio_session_manager.dart';
import 'mic_capture_service.dart';
import 'vad_processor.dart';
import 'voice_controller.dart';

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

  bool _isRecording = false;
  bool _isPaused = false;

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
    if (_isRecording) return;

    await audioSession.requestAudioFocus();
    await micCapture.start();

    _micSubscription = micCapture.audioStream.listen(
      _onMicAudio,
      onError: (Object e) {
        if (kDebugMode) {
          debugPrint('VoiceCapturePipeline: mic stream error: $e');
        }
        voiceController.reportError(e);
      },
    );
    _vadSubscription = vad.stateChanges.listen(_onVadStateChange);

    _isRecording = true;
    _isPaused = false;

    // Sync VoiceController state (mic start is a no-op since already running).
    await voiceController.startRecording();
  }

  void _onMicAudio(List<int> chunk) {
    if (_isPaused) return;
    vad.processChunk(chunk);
  }

  void _onVadStateChange(VadState state) {
    switch (state) {
      case VadState.speechStarted:
        break;
      case VadState.speechStopped:
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

  /// Stop capturing microphone audio and tear down the pipeline.
  Future<void> stopRecording() async {
    if (!_isRecording) return;
    _isRecording = false;

    await _vadSubscription?.cancel();
    _vadSubscription = null;
    await _micSubscription?.cancel();
    _micSubscription = null;

    // Mic may already be stopped if an interruption is in progress.
    if (!_isPaused) {
      try {
        await micCapture.stop();
      } catch (_) {
        // Best-effort stop.
      }
    }

    await audioSession.abandonAudioFocus();

    // Sync VoiceController state.
    await voiceController.stopRecording();
  }

  void _handleInterruption(bool isInterrupted) {
    if (isInterrupted) {
      _isPaused = true;
      unawaited(_pauseForInterruption());
    } else {
      unawaited(_resumeAfterInterruption());
    }
  }

  Future<void> _pauseForInterruption() async {
    await _micSubscription?.cancel();
    _micSubscription = null;
    try {
      await micCapture.stop();
    } catch (_) {
      // Best-effort stop.
    }
    // Pause any in-flight TTS playback and mark the session paused.
    await voiceController.pauseForInterruption();
  }

  Future<void> _resumeAfterInterruption() async {
    _isPaused = false;
    // Clear the paused flag regardless of whether mic restart succeeds.
    await voiceController.resumeAfterInterruption();
    if (!_isRecording) return;
    try {
      await micCapture.start();
      _micSubscription = micCapture.audioStream.listen(_onMicAudio);
    } catch (e) {
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

  /// Release all resources.
  Future<void> dispose() async {
    if (_isRecording) {
      await stopRecording();
    }
    audioSession.onInterruption = null;
  }
}