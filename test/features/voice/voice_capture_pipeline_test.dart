import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_pipeline.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller.dart';
import 'package:ai_assistant/features/voice/data/vad_processor.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

void main() {
  late FakeChatClient chat;
  late FakeMicCaptureService mic;
  late FakeAudioPlayback playback;
  late FakeVadProcessor vad;
  late FakeAudioSessionManager audioSession;
  late FakeSttEngine stt;
  late FakeTtsEngine tts;
  late VoiceController controller;
  late VoiceCapturePipeline pipeline;

  setUp(() {
    chat = FakeChatClient(
      results: [
        ChatResult(content: 'got it', toolCalls: const [], finishReason: 'stop'),
      ],
    );
    mic = FakeMicCaptureService();
    playback = FakeAudioPlayback();
    vad = FakeVadProcessor();
    audioSession = FakeAudioSessionManager();
    stt = FakeSttEngine(transcript: 'recognized speech');
    tts = FakeTtsEngine();
    controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
      ttsEngine: tts,
      // This test asserts back-to-back utterances; the echo refractory would
      // (correctly) swallow the second one at test speed.
      echoGateDuration: Duration.zero,
    );
    pipeline = VoiceCapturePipeline(
      micCapture: mic,
      vad: vad,
      audioSession: audioSession,
      voiceController: controller,
    );
  });

  tearDown(() async {
    if (pipeline.isRecording) {
      await pipeline.stopRecording();
    }
    await pipeline.dispose();
    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('speechStopped flushes the buffered mic audio on to the text turn',
      () async {
    await controller.startConversation();

    // Mic streams to both the pipeline (for VAD) and the controller (which
    // buffers every chunk while an STT engine is configured) — a broadcast
    // stream delivers to every listener.
    final utterance = List<int>.generate(200, (i) => i * 2);
    mic.emitChunk(utterance);
    await pumpEventQueue();
    expect(stt.transcribed, isEmpty);

    await pipeline.startRecording();

    // Speech begins, continues, then ends.
    vad.emitState(VadState.speechStarted);
    mic.emitChunk(utterance);
    await pumpEventQueue();
    vad.emitState(VadState.speechStopped);
    await pumpEventQueue();

    // Mid-hold silence is NOT end-of-utterance: the user is still holding,
    // and the VAD must not split the utterance (the hold's release flush
    // owns the turn boundary — a mid-hold flush races it and, under the
    // one-pending cap, drops one of the two halves).
    expect(stt.transcribed, isEmpty);

    // The hold is released: the release flush carries the whole utterance.
    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();
    await pumpEventQueue();
    await pumpEventQueue();

    // The exact utterance seen by the controller is flushed through.
    expect(stt.transcribed, isNotEmpty);
    expect(stt.transcribed.single, isNotEmpty);
    // The utterance slot is cleared when the turn begins (sendText), so by
    // the time the turn completes it is null again.
    expect(controller.state.onDeviceTranscript, isNull);

    // The recognised utterance drives the LLM reply and TTS playback.
    expect(chat.calls, hasLength(1));
    expect(chat.calls.single.single.role, 'user');
    expect(tts.synthesized, contains('got it'));
    expect(playback.playedChunks, isNotEmpty);

    // Capture is still running after the utterance ends.
    expect(controller.state.isRecording, isTrue);
  });

  test('buffer is cleared between utterances so flushes do not repeat audio',
      () async {
    await controller.startConversation();
    await pipeline.startRecording();

    // Utterance 1 (mid-hold VAD silence does not flush; release does).
    mic.emitChunk(List<int>.filled(50, 1));
    vad.emitState(VadState.speechStarted);
    await pumpEventQueue();
    vad.emitState(VadState.speechStopped);
    await pumpEventQueue();
    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();
    await pumpEventQueue();

    // Utterance 2.
    mic.emitChunk(List<int>.filled(30, 2));
    vad.emitState(VadState.speechStarted);
    await pumpEventQueue();
    vad.emitState(VadState.speechStopped);
    await pumpEventQueue();
    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();
    await pumpEventQueue();

    expect(stt.transcribed, hasLength(2));
    expect(stt.transcribed[0], hasLength(50));
    expect(stt.transcribed[1], hasLength(30));
    expect(stt.transcribed[1], isNot(contains(1)));
  });

  test('a mic stream error mid-hold restarts the mic instead of ending the '
      'recording', () async {
    await controller.startConversation();
    await pipeline.startRecording();
    expect(mic.startCount, 1);

    // The recorder dies mid-hold (e.g. ERROR_DEAD_OBJECT from focus churn).
    mic.emitError(Exception('ERROR_DEAD_OBJECT'));
    await pumpEventQueue();
    await pumpEventQueue();

    // The hold survives: the mic was restarted and recording is still active.
    expect(mic.startCount, 2);
    expect(controller.state.isRecording, isTrue);
    expect(controller.state.error, isNull);

    // Buffered audio is preserved across the restart.
    mic.emitChunk(List<int>.filled(10, 7));
    await pumpEventQueue();
    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();
    await pumpEventQueue();
    expect(stt.transcribed, isNotEmpty);
  });

  test('an interruption-begin that never resolves self-heals the mic while '
      'the hold is active', () async {
    await controller.startConversation();
    await pipeline.startRecording();
    expect(mic.startCount, 1);

    // A spurious interruption fires and its end never arrives.
    audioSession.handleInterruption(isInterrupted: true);
    await pumpEventQueue();
    expect(mic.isRecording, isFalse);

    // Past the self-heal grace the mic restarts, keeping the hold alive.
    await Future<void>.delayed(
      const Duration(milliseconds: 1400),
    );
    await pumpEventQueue();
    await pumpEventQueue();

    expect(mic.startCount, 2);
    expect(controller.state.isRecording, isTrue);
    expect(controller.state.isPaused, isFalse);
  });

  test('a real interruption end resumes the mic before the self-heal grace',
      () async {
    await controller.startConversation();
    await pipeline.startRecording();

    audioSession.handleInterruption(isInterrupted: true);
    await pumpEventQueue();
    expect(mic.isRecording, isFalse);

    // The interruption resolves immediately: the mic resumes without waiting
    // for the grace timer.
    audioSession.handleInterruption(isInterrupted: false);
    await pumpEventQueue();
    await pumpEventQueue();

    expect(mic.isRecording, isTrue);
    expect(controller.state.isPaused, isFalse);
  });
}
