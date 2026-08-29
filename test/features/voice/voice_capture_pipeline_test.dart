import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/features/voice/voice_capture_pipeline.dart';
import 'package:ai_assistant/features/voice/voice_controller.dart';
import 'package:ai_assistant/features/voice/vad_processor.dart';

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
    await pumpEventQueue();
    await pumpEventQueue();

    // The exact utterance seen by the controller is flushed through.
    expect(stt.transcribed, isNotEmpty);
    expect(stt.transcribed.single, isNotEmpty);
    expect(controller.state.onDeviceTranscript, 'recognized speech');

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

    // Utterance 1.
    mic.emitChunk(List<int>.filled(50, 1));
    vad.emitState(VadState.speechStarted);
    await pumpEventQueue();
    vad.emitState(VadState.speechStopped);
    await pumpEventQueue();
    await pumpEventQueue();

    // Utterance 2.
    mic.emitChunk(List<int>.filled(30, 2));
    vad.emitState(VadState.speechStarted);
    await pumpEventQueue();
    vad.emitState(VadState.speechStopped);
    await pumpEventQueue();
    await pumpEventQueue();

    expect(stt.transcribed, hasLength(2));
    expect(stt.transcribed[0], hasLength(50));
    expect(stt.transcribed[1], hasLength(30));
    expect(stt.transcribed[1], isNot(contains(1)));
  });
}
