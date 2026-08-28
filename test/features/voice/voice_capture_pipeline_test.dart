import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/voice_capture_pipeline.dart';
import 'package:ai_assistant/features/voice/voice_controller.dart';
import 'package:ai_assistant/features/voice/vad_processor.dart';

import 'voice_test_fakes.dart';

void main() {
  late FakeLiveKitService liveKit;
  late FakeMicCaptureService mic;
  late FakeAudioPlayback playback;
  late FakeVadProcessor vad;
  late FakeAudioSessionManager audioSession;
  late FakeSttEngine stt;
  late VoiceController controller;
  late VoiceCapturePipeline pipeline;

  setUp(() {
    liveKit = FakeLiveKitService();
    mic = FakeMicCaptureService();
    playback = FakeAudioPlayback();
    vad = FakeVadProcessor();
    audioSession = FakeAudioSessionManager();
    stt = FakeSttEngine(transcript: 'recognized speech');
    controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
      tokenMinter: (_) async => 'token',
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
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('speechStopped flushes the buffered mic audio to on-device STT',
      () async {
    await controller.connectToRoom(roomName: 'room-1');

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

    // The exact utterance seen by the controller is flushed through.
    expect(stt.transcribed, isNotEmpty);
    expect(stt.transcribed.single, isNotEmpty);
    expect(controller.state.onDeviceTranscript, 'recognized speech');

    // Mic forwarding is gated off again after the utterance ends.
    expect(controller.state.isRecording, isTrue); // capture still running
    liveKit.sentAudio.clear();
    mic.emitChunk([9, 9, 9]);
    await pumpEventQueue();
    // While speech is silent, nothing is forwarded to the data channel.
    expect(liveKit.sentAudio, isEmpty);
  });

  test('buffer is cleared between utterances so flushes do not repeat audio',
      () async {
    await controller.connectToRoom(roomName: 'room-1');
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