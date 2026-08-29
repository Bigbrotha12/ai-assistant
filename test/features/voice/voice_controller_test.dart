import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/features/voice/engine_errors.dart';
import 'package:ai_assistant/features/voice/voice_controller.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

void main() {
  test('startConversation activates the session and endConversation teardown',
      () async {
    final chat = FakeChatClient();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
    );

    await controller.startConversation();
    expect(controller.state.isConnected, isTrue);

    await controller.startRecording();
    expect(controller.state.isRecording, isTrue);

    await controller.endConversation();
    expect(controller.state.isConnected, isFalse);
    expect(controller.state.isRecording, isFalse);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('flushTranscriptionBuffer clears the buffer immediately', () async {
    final chat = FakeChatClient(
      results: [
        ChatResult(content: 'hi there', toolCalls: const [], finishReason: 'stop'),
      ],
    );
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine(transcript: 'hello world');
    final tts = FakeTtsEngine();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
      ttsEngine: tts,
    );
    await controller.startConversation();

    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();

    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();

    // The buffer is cleared before transcribe runs, so a second flush must
    // not re-transcribe the same audio.
    expect(stt.transcribed, hasLength(1));
    expect(stt.transcribed.single, [1, 2, 3]);
    expect(stt.sampleRates.single, 16000);

    // The recognised utterance is sent to the chat client for a reply.
    expect(chat.calls.single.single.role, 'user');
    expect(chat.calls.single.single.content, 'hello world');

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('flushTranscriptionBuffer sends the utterance and speaks the reply',
      () async {
    final chat = FakeChatClient(
      streamDeltas: [
        ['Hello', ' there'],
      ],
      results: [
        ChatResult(content: 'Hello there', toolCalls: const [], finishReason: 'stop'),
      ],
    );
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine(transcript: 'hello world');
    final tts = FakeTtsEngine();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
      ttsEngine: tts,
    );
    await controller.startConversation();

    final replies = <String>[];
    controller.onTranscript = replies.add;

    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();
    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();
    await pumpEventQueue();
    await pumpEventQueue();

    // The streamed reply is accumulated into state and finalised.
    expect(controller.state.lastTranscript, 'Hello there');
    expect(replies, ['Hello there']);
    // The reply text is synthesised by the on-device TTS engine.
    expect(tts.synthesized, ['Hello there']);
    expect(playback.playedChunks, isNotEmpty);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('flushTranscriptionBuffer reports engine failures by type', () async {
    final chat = FakeChatClient();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine()..error = const EngineInferenceError('boom');

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
    );
    await controller.startConversation();

    mic.emitChunk([1, 2, 3]);
    await pumpEventQueue();

    await controller.flushTranscriptionBuffer();
    await pumpEventQueue();

    // The original object is preserved so the UI can classify it by type.
    expect(controller.state.error, isA<EngineInferenceError>());
    expect((controller.state.error! as EngineInferenceError).message, 'boom');

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('chat client failures surface the error and stop the turn', () async {
    final failure = ChatServerError('boom');
    final chat = FakeChatClient()..error = failure;
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
    );
    await controller.startConversation();

    await controller.sendText('hello');
    await pumpEventQueue();

    expect(controller.state.error, same(failure));
    expect(controller.state.lastTranscript, isNull);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('a gateway 401 surfaces as an auth-required error', () async {
    final failure = const ChatServerError('HTTP 401', statusCode: 401);
    final chat = FakeChatClient()..error = failure;
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
    );
    await controller.startConversation();

    await controller.sendText('hello');
    await pumpEventQueue();

    expect(controller.state.error, isA<ChatServerError>());
    expect(
      (controller.state.error! as ChatServerError).statusCode,
      401,
    );
    // The UI classifies this as "re-auth required", not a network error.
    expect(isAuthRequiredError(controller.state.error!), isTrue);

    // Dismissing clears the error without tearing the session down.
    controller.clearError();
    expect(controller.state.error, isNull);
    expect(controller.state.isConnected, isTrue);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('empty transcript does not update state or fire callbacks', () async {
    final chat = FakeChatClient();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();
    final stt = FakeSttEngine(transcript: '   ');

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
      sttEngine: stt,
    );
    await controller.startConversation();
    final transcripts = <String>[];
    controller.onTranscript = transcripts.add;

    mic.emitChunk([1, 2, 3]);
    await controller.flushTranscriptionBuffer();

    expect(transcripts, isEmpty);
    expect(controller.state.onDeviceTranscript, isNull);
    expect(chat.calls, isEmpty);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });

  test('sendText with empty input is a no-op', () async {
    final chat = FakeChatClient();
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
    );
    await controller.startConversation();

    await controller.sendText('   ');
    expect(chat.calls, isEmpty);

    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  });
}
