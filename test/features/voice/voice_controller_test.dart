import 'dart:async';
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

  test('startConversation and endConversation clear stale turn fields', () async {
    final chat = FakeChatClient(
      results: [
        ChatResult(content: 'hi', toolCalls: const [], finishReason: 'stop'),
      ],
    );
    final mic = FakeMicCaptureService();
    final playback = FakeAudioPlayback();

    final controller = VoiceController(
      chatClient: chat,
      micCapture: mic,
      playback: playback,
    );

    await controller.startConversation();
    await controller.sendText('hello', speakReply: false);
    // The completed turn leaves lastReply set.
    expect(controller.state.lastReply, 'hi');

    // endConversation clears per-turn fields.
    await controller.endConversation();
    expect(controller.state.lastReply, isNull);
    expect(controller.state.onDeviceTranscript, isNull);

    // A restarted session starts with clean per-turn fields.
    await controller.startConversation();
    expect(controller.state.lastReply, isNull);
    expect(controller.state.onDeviceTranscript, isNull);

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

  group('echo gate', () {
    test('mic chunks during and shortly after playback are not buffered',
        () async {
      final chat = FakeChatClient(
        results: [
          ChatResult(content: 'hi there', toolCalls: const [], finishReason: 'stop'),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final stt = FakeSttEngine();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
      );

      await controller.startConversation();
      await controller.startRecording();
      await controller.synthesizeOnDevice('reply');
      // FakeAudioPlayback emitted isPlaying true → false (completion); the
      // echo gate now covers the speaker tail. Chunks right after playback
      // must not reach the STT buffer.
      expect(controller.state.isAiSpeaking, isFalse);
      mic.emitChunk(List.filled(160, 5));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await Future<void>.delayed(Duration.zero);
      expect(stt.transcribed, isEmpty);

      // After the refractory window, capture resumes.
      await Future<void>.delayed(const Duration(milliseconds: 320));
      mic.emitChunk(List.filled(160, 7));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await Future<void>.delayed(Duration.zero);
      expect(stt.transcribed, hasLength(1));
      expect(stt.transcribed.single, everyElement(7));

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('turn lifecycle', () {
    test('endConversation cancels queued turns (no network or audio after)',
        () async {
      final chat = FakeChatClient(
        results: [
          ChatResult(content: 'hi there', toolCalls: const [], finishReason: 'stop'),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final stt = FakeSttEngine();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );

      await controller.startConversation();
      await controller.startRecording();

      // Turn 1 in flight (STT held open), turn 2 queued behind it.
      stt.gate = Completer<void>();
      mic.emitChunk(List.filled(40, 1));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await Future<void>.delayed(Duration.zero);
      mic.emitChunk(List.filled(40, 2));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      expect(stt.transcribed, hasLength(1));

      // Teardown while turn 1 is mid-flight.
      await controller.endConversation();

      // Release the gate: turn 1 must abort after STT, turn 2 never start —
      // no network call and no audio after the session is gone.
      stt.gate!.complete();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(chat.calls, isEmpty);
      expect(playback.playedChunks, isEmpty);
      expect(controller.state.isConnected, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('concurrent flushes serialize into ordered turns', () async {
      final chat = FakeChatClient(
        results: [
          ChatResult(content: 'hi there', toolCalls: const [], finishReason: 'stop'),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final stt = FakeSttEngine();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );

      await controller.startConversation();
      await controller.startRecording();

      stt.gate = Completer<void>();
      mic.emitChunk(List.filled(40, 1));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await Future<void>.delayed(Duration.zero);
      mic.emitChunk(List.filled(40, 2));
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      // Both buffers copied; only turn 1 has reached STT so far.
      expect(stt.transcribed, hasLength(1));

      stt.gate!.complete();
      // Let turn 1 finish and turn 2 run.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(stt.transcribed, hasLength(2));
      expect(stt.transcribed[0], everyElement(1));
      expect(stt.transcribed[1], everyElement(2));
      expect(chat.callCount, 2);
      expect(playback.playedChunks, hasLength(2));
      // The final reply is exposed exactly once per completed turn (cleared
      // at the start of the next), so per-turn listeners fire reliably.
      expect(controller.state.lastReply, 'hi there');

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('onDeviceTranscript is set per utterance and cleared at turn start',
        () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Hello', ' there', '!'],
        ],
        results: [
          ChatResult(
              content: 'Hello there!',
              toolCalls: const [],
              finishReason: 'stop'),
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
        // Back-to-back turns at test speed would otherwise be swallowed by
        // the echo refractory window.
        echoGateDuration: Duration.zero,
      );

      final emissions = <VoiceConversationState>[];
      controller.stateStream.listen(emissions.add);
      int transcriptEmits(String text) => emissions.fold(
            0,
            (n, s) => n + (s.onDeviceTranscript == text ? 1 : 0),
          );

      await controller.startConversation();

      // Turn 1: a full STT → LLM (streamed deltas) → TTS turn.
      mic.emitChunk([1, 2, 3]);
      await pumpEventQueue();
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      await pumpEventQueue();

      // (a) The slot is cleared once the turn begins, so it is null after
      // the turn completes (streaming deltas and playback flips must not
      // keep re-carrying the stale utterance).
      expect(controller.state.onDeviceTranscript, isNull);
      // (b) The recognised transcript appeared exactly twice per utterance:
      // once from flushTranscriptionBuffer and once from sendText (the UI
      // dedupes the consecutive identical values).
      expect(transcriptEmits('hello world'), 2);

      // Turn 2: the SAME text in a new turn must still produce fresh
      // non-null emissions, since the slot was null between turns.
      mic.emitChunk([4, 5, 6]);
      await pumpEventQueue();
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(controller.state.onDeviceTranscript, isNull);
      expect(transcriptEmits('hello world'), 4);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('mic stream errors are tolerated, not unhandled', () async {
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: FakeSttEngine(),
        ttsEngine: FakeTtsEngine(),
      );

      await controller.startConversation();
      // The capture pipeline is the single mic-error reporter; the
      // controller's own listener must merely survive it.
      mic.emitError(StateError('dead object'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.error, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });
}
