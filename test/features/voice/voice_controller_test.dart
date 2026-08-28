import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/engine_errors.dart';
import 'package:ai_assistant/features/voice/voice_controller.dart';

import 'voice_test_fakes.dart';

void main() {
  test('flushTranscriptionBuffer clears the buffer immediately', () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine(transcript: 'hello world');

    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
    );

    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();

    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();

    // The buffer is cleared before transcribe runs, so a second flush must
    // not re-transcribe the same audio.
    expect(stt.transcribed, hasLength(1));
    expect(stt.transcribed.single, [1, 2, 3]);
    expect(stt.sampleRates.single, 16000);

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('flushTranscriptionBuffer reports engine failures by type', () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine()..error = const EngineInferenceError('boom');

    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
    );

    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();

    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();

    // The original object is preserved so the UI can classify it by type.
    expect(controller.state.error, isA<EngineInferenceError>());
    expect((controller.state.error! as EngineInferenceError).message, 'boom');

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('disconnected event clears the optimistic connected state', () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      tokenMinter: (_) async => 'token',
    );

    await controller.connectToRoom(roomName: 'room-1');
    expect(controller.state.isConnected, isTrue);
    expect(controller.state.currentRoomName, 'room-1');

    // Server-initiated drop while the local client never called disconnect().
    liveKit.emitDisconnected();
    await pumpEventQueue();

    expect(controller.state.isConnected, isFalse);
    expect(controller.state.currentRoomName, isNull);

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('idle/recording/aiSpeaking events leave connected state untouched',
      () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      tokenMinter: (_) async => 'token',
    );

    await controller.connectToRoom(roomName: 'room-1');
    liveKit
      ..emitServerTranscript('hi')
      ..emitAiAudio([1, 2, 3]);
    liveKit.emitDisconnected();
    await pumpEventQueue();

    // Non-disconnect events do not flap isConnected.
    expect(controller.state.lastTranscript, 'hi');
    expect(controller.state.isAiSpeaking, isTrue);

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('TokenMinter failure surfaces the original error object', () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final connectFailure = StateError('token minting unavailable');
    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      tokenMinter: (_) async => throw connectFailure,
    );

    await controller.connectToRoom(roomName: 'room-1');

    expect(controller.state.isConnected, isFalse);
    expect(controller.state.error, same(connectFailure));

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('empty transcript does not update state or fire callbacks', () async {
    final liveKit = FakeLiveKitService();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine(transcript: '   ');

    final controller = VoiceController(
      liveKit: liveKit,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
    );
    final transcripts = <String>[];
    controller.onTranscript = transcripts.add;

    mic.emitChunk([1, 2, 3]);
    await controller.flushTranscriptionBuffer();

    expect(transcripts, isEmpty);
    expect(controller.state.onDeviceTranscript, isNull);

    await controller.dispose();
    await liveKit.dispose();
    await mic.dispose();
    await playback.dispose();
  });
}