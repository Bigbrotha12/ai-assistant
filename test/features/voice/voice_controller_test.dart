import 'dart:async';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/features/chat/message_model.dart';
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

    test('endConversation cancels an in-flight LLM stream (no transcript or '
        'audio after the session is gone)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['partial'],
        ],
        results: [
          ChatResult(content: 'partial', toolCalls: const [], finishReason: 'stop'),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      final transcripts = <String>[];
      controller.onTranscript = transcripts.add;

      // The stream accumulates a delta, then hangs in flight.
      final send = controller.sendText('hello');
      await Future<void>.delayed(Duration.zero);
      expect(chat.callCount, 1);
      expect(controller.state.lastTranscript, 'partial');

      // The session ends while the stream is in flight.
      await controller.endConversation();

      // The stream returns a result despite the cancelled token: nothing may
      // fire onTranscript or keep mutating state after the session is gone.
      chat.hang!.complete(
        const ChatResult(content: 'partial', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      expect(controller.state.lastTranscript, isNull);
      expect(transcripts, isEmpty);
      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);
      expect(controller.state.isConnected, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('interrupt', () {
    test('interrupt during playback stops playback and clears isAiSpeaking',
        () async {
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      // Synthesis completes but playAudio holds the playing state open, as a
      // real long reply would.
      unawaited(controller.synthesizeOnDevice('hello'));
      await pumpEventQueue();
      expect(controller.state.isAiSpeaking, isTrue);
      expect(playback.playedChunks, hasLength(1));

      await controller.interrupt();

      expect(controller.state.isAiSpeaking, isFalse);

      // Releasing the held playback must not restart anything.
      playback.holdCompletion!.complete();
      await pumpEventQueue();
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupt before the LLM call surfaces a real cancellation that '
        'sendText swallows', () async {
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      // Hold the turn between user text and the LLM call (the context builder
      // await), so the interrupt lands while the active token is still live
      // and the fake's entry check — not a hand-fabricated error — produces
      // the ChatNetworkError('cancelled').
      final builderGate = Completer<void>();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        contextBuilder: (_) async {
          await builderGate.future;
          return [ApiMessage(role: 'user', content: 'hello')];
        },
      );
      await controller.startConversation();

      final transcripts = <String>[];
      controller.onTranscript = transcripts.add;

      final send = controller.sendText('hello');
      await Future<void>.delayed(Duration.zero);
      // The turn is still inside the context builder; the LLM call has not
      // been dispatched yet.
      expect(chat.callCount, 0);

      await controller.interrupt();

      // Release the builder: the LLM call is dispatched against the cancelled
      // token, so the fake throws a genuine ChatNetworkError('cancelled') —
      // the same path the Dio-backed client takes. sendText must swallow it
      // (no error banner), fire no transcript, and synthesise nothing.
      builderGate.complete();
      await send;

      expect(controller.state.error, isNull);
      expect(controller.state.lastTranscript, isNull);
      expect(transcripts, isEmpty);
      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a result that returns despite a cancelled token is abandoned '
        '(no partial transcript leaks into state)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['partial', ' reply'],
        ],
        results: [
          ChatResult(
            content: 'partial reply',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      final transcripts = <String>[];
      controller.onTranscript = transcripts.add;

      // The stream accumulates deltas, then hangs in flight.
      final send = controller.sendText('hello');
      await Future<void>.delayed(Duration.zero);
      expect(chat.callCount, 1);
      expect(controller.state.lastTranscript, 'partial reply');

      await controller.interrupt();

      // The client surfaced a result despite the cancelled token (it finished
      // streaming just as the interrupt landed): the post-completion guard
      // must abandon the turn and drop the partial transcript.
      chat.hang!.complete(
        const ChatResult(
          content: 'partial reply',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      expect(controller.state.error, isNull);
      expect(controller.state.lastTranscript, isNull);
      expect(transcripts, isEmpty);
      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a genuine ChatServerError alongside a cancelled token still '
        'surfaces (the catch only swallows the real cancellation)', () async {
      final failure = ChatServerError('boom');
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await Future<void>.delayed(Duration.zero);
      expect(chat.callCount, 1);

      await controller.interrupt();

      // The server failed in the same instant the interrupt landed: the error
      // is a ChatServerError, NOT the cancellation marker, so it must surface
      // even though the token is cancelled.
      chat.hang!.completeError(failure);
      await send;

      expect(controller.state.error, same(failure));
      expect(controller.state.lastTranscript, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a new turn after interrupt still streams (token not pre-cancelled)',
        () async {
      final chat = FakeChatClient(
        results: [
          ChatResult(content: 'hi', toolCalls: const [], finishReason: 'stop'),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      // Interrupt with nothing playing: idempotent and side-effect free, and
      // the next turn must stream against a fresh, uncancelled token.
      await controller.interrupt();
      expect(controller.state.error, isNull);

      await controller.sendText('hello');

      expect(chat.callCount, 1);
      expect(controller.state.lastReply, 'hi');
      expect(tts.synthesized, ['hi']);
      expect(playback.playedChunks, hasLength(1));

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupting during synthesis skips playback', () async {
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine()..gate = Completer<void>();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      // Synthesis is held open in the worker isolate.
      final synth = controller.synthesizeOnDevice('hello');
      await Future<void>.delayed(Duration.zero);
      expect(tts.synthesized, ['hello']);

      await controller.interrupt();
      // Release synthesis: the completed PCM must not reach playback because
      // the turn was interrupted while it ran.
      tts.gate!.complete();
      await synth;

      expect(playback.playedChunks, isEmpty);
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupt while the flush turn waits for playback end releases the '
        'turn queue', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Hello', ' there'],
        ],
        results: [
          ChatResult(
            content: 'Hello there',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final stt = FakeSttEngine(transcript: 'hello world');
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

      final transcripts = <String>[];
      controller.onTranscript = transcripts.add;

      // Full flush → stream → synthesize → playback turn. Playback is held
      // open, so the turn parks in the flush's firstWhere(!playing) wait —
      // the timeline the real (fire-and-forget) playback service produces.
      mic.emitChunk([1, 2, 3]);
      await pumpEventQueue();
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(controller.state.isAiSpeaking, isTrue);
      expect(controller.state.lastTranscript, 'Hello there');
      expect(transcripts, ['Hello there']);
      expect(playback.playedChunks, hasLength(1));

      // Barge-in while the serialized turn waits for playback to end: the
      // wait must resolve so the turn completes and the queue advances.
      await controller.interrupt();
      playback.holdCompletion!.complete();

      // A fresh turn queued behind the interrupted one must proceed.
      mic.emitChunk([4, 5, 6]);
      await pumpEventQueue();
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(chat.callCount, 2);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('isGenerating lifecycle', () {
    test('true while the LLM stream is held, false once the turn completes',
        () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Hello', ' there.'],
        ],
        results: [
          ChatResult(
            content: 'Hello there.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      expect(controller.state.isGenerating, isFalse);

      // The stream hangs mid-generation, as a real LLM stream would.
      final send = controller.sendText('hello');
      await pumpEventQueue();
      expect(chat.hang!.isCompleted, isFalse);
      expect(controller.state.isGenerating, isTrue);

      // Release the stream and let the whole turn finish (speak-queue drain
      // + playback included).
      chat.hang!.complete(
        const ChatResult(
          content: 'Hello there.',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      expect(controller.state.isGenerating, isFalse);
      expect(controller.state.isAiSpeaking, isFalse);
      expect(controller.state.lastReply, 'Hello there.');

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('isGenerating is false on an errored stream', () async {
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
      expect(controller.state.isGenerating, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('isGenerating is false after a barge-in interrupt during a held '
        'stream', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['partial'],
        ],
        results: [
          ChatResult(
            content: 'partial',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      expect(controller.state.isGenerating, isTrue);

      // Barge-in while the stream is held: the result returns despite the
      // cancelled token, and the abandon path must still clear the flag.
      await controller.interrupt();
      chat.hang!.complete(
        const ChatResult(
          content: 'partial',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      expect(controller.state.isGenerating, isFalse);
      expect(controller.state.lastTranscript, isNull);
      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('sentence-buffered streaming', () {
    test('first sentence plays before the LLM stream completes', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['First sentence.', ' Second sentence still streaming.'],
        ],
        results: [
          ChatResult(
            content: 'First sentence. Second sentence still streaming.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      // The stream accumulates the first sentence, then hangs mid-stream.
      final send = controller.sendText('hello');
      await pumpEventQueue();
      expect(chat.hang!.isCompleted, isFalse);
      // The first sentence was already synthesized and played while the LLM
      // is still generating.
      expect(playback.playedChunks, hasLength(1));
      expect(tts.synthesized, ['First sentence.']);

      // Release the hang: the trailing remainder is dispatched on
      // completion and plays afterwards.
      chat.hang!.complete(
        const ChatResult(
          content: 'First sentence. Second sentence still streaming.',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      expect(tts.synthesized, [
        'First sentence.',
        'Second sentence still streaming.',
      ]);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('sentences are synthesized and played in streaming order', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha one.', ' Beta two.', ' Gamma three.'],
        ],
        results: [
          ChatResult(
            content: 'Alpha one. Beta two. Gamma three.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      // Distinct PCM per synthesis call ties each played chunk to its
      // utterance, so the played order is observable.
      final tts = FakeTtsEngine(sampleVariants: const [
        [1],
        [2, 2],
        [3, 3, 3],
      ]);
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      await controller.sendText('hello');

      expect(tts.synthesized, ['Alpha one.', 'Beta two.', 'Gamma three.']);
      expect(playback.playedChunks, [
        [1],
        [2, 2],
        [3, 3, 3],
      ]);
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('the trailing partial sentence is dispatched on LLM completion',
        () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Done sentence.', ' Trailing bit'],
        ],
        results: [
          ChatResult(
            content: 'Done sentence. Trailing bit',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      await controller.sendText('hello');

      // The boundary closes 'Done sentence.' mid-stream; 'Trailing bit'
      // has no terminator and must be flushed as the remainder on
      // completion.
      expect(tts.synthesized, ['Done sentence.', 'Trailing bit']);
      expect(playback.playedChunks, hasLength(2));

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('isAiSpeaking stays true across the inter-sentence gap', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['First sentence.', ' Second sentence.'],
        ],
        results: [
          ChatResult(
            content: 'First sentence. Second sentence.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      // Sentence 1 is playing, held open.
      expect(controller.state.isAiSpeaking, isTrue);
      expect(playback.playedChunks, hasLength(1));
      expect(tts.synthesized, ['First sentence.']);

      // Sentence 1 ends; sentence 2's synthesis is held. The raw player is
      // idle (isPlaying flipped false), but the turn must still count as
      // speaking — the mic gates must not re-open mid-reply.
      playback.holdCompletion!.complete();
      tts.gate = Completer<void>();
      await pumpEventQueue();
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isTrue);

      // Release the synthesis: sentence 2 plays and the turn closes.
      tts.gate!.complete();
      await send;
      expect(tts.synthesized, ['First sentence.', 'Second sentence.']);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupt mid-queue drops the remaining queued sentences', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha.', ' Beta.', ' Gamma.'],
        ],
        results: [
          ChatResult(
            content: 'Alpha. Beta. Gamma.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      // Alpha playing (held); Beta and Gamma queued but not yet synthesized.
      expect(controller.state.isAiSpeaking, isTrue);
      expect(tts.synthesized, ['Alpha.']);

      await controller.interrupt();
      expect(controller.state.isAiSpeaking, isFalse);

      // Releasing the held playback must not resurrect the queue.
      playback.holdCompletion!.complete();
      await send;

      expect(tts.synthesized, ['Alpha.']);
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('pause mid-queue suspends the reply and resume continues it',
        () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha.', ' Beta.'],
        ],
        results: [
          ChatResult(
            content: 'Alpha. Beta.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      expect(controller.state.isAiSpeaking, isTrue);
      expect(playback.playedChunks, hasLength(1));

      // OS interruption: playback stops, but the queue must not advance
      // while paused.
      await controller.pauseForInterruption();
      await pumpEventQueue();
      expect(controller.state.isPaused, isTrue);
      expect(playback.playedChunks, hasLength(1));
      expect(tts.synthesized, ['Alpha.']);

      // The interruption ended the held track; release the fake's hold so
      // the resumed sentence can finish.
      playback.holdCompletion!.complete();

      await controller.resumeAfterInterruption();
      await send;

      // Nothing was lost: Beta plays after the resume.
      expect(tts.synthesized, ['Alpha.', 'Beta.']);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a sentence that filters to empty is skipped', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['(humming)', '\nReal sentence.'],
        ],
        results: [
          ChatResult(
            content: '(humming)\nReal sentence.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      await controller.sendText('hello');

      // The newline closes "(humming)" as its own sentence; it filters to
      // empty and must be skipped, while the real sentence is spoken.
      expect(tts.synthesized, ['Real sentence.']);
      expect(playback.playedChunks, hasLength(1));

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('busy state (W1.2)', () {
    // emitChunk delivers asynchronously; the buffer only holds the chunk
    // after an event-loop turn (same pattern as the turn-lifecycle tests).
    Future<void> settle() async {
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
        await pumpEventQueue();
      }
    }

    test('an utterance flushed mid-generation queues as the NEXT turn',
        () async {
      final chat = FakeChatClient(
        results: [
          const ChatResult(content: 'First reply.', toolCalls: [], finishReason: 'stop'),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final stt = FakeSttEngine(transcript: 'second hello');
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      // Turn 1 runs and hangs mid-stream.
      mic.emitChunk([1, 1, 1]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await settle();
      expect(chat.callCount, 1);
      expect(controller.state.isGenerating, isTrue);

      // A second utterance flushed mid-generation is accepted as the queued
      // next turn: no concurrent chat call, and its STT waits behind turn 1.
      mic.emitChunk([2, 2, 2]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await settle();
      expect(chat.callCount, 1);
      expect(stt.transcribed, hasLength(1));
      expect(controller.state.notice, isNull);

      // A third utterance while one is already pending is dropped with a
      // notice.
      mic.emitChunk([3, 3, 3]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await settle();
      expect(stt.transcribed, hasLength(1));
      expect(controller.state.notice, isNotNull);

      // Releasing the stream finishes turn 1, then the queued turn runs.
      chat.hang!.complete(
        const ChatResult(
          content: 'First reply.',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await settle();

      expect(chat.callCount, 2);
      expect(stt.transcribed, hasLength(2));
      // The queued turn's sendText consumed the drop notice.
      expect(controller.state.notice, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a dropped flush leaves the mic buffer clear (nothing accumulates)',
        () async {
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final stt = FakeSttEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      mic.emitChunk([1, 1, 1]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await settle();

      // Flush 2 is accepted (one pending slot), flush 3 is dropped: neither
      // drop may resurrect audio later.
      mic.emitChunk([2, 2, 2]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      mic.emitChunk([3, 3, 3]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await settle();

      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await settle();

      // Exactly two turns reached STT — [3,3,3] never did. The queued turn
      // (accepted mid-generation) ran after turn 1, never concurrently.
      expect(stt.transcribed, hasLength(2));
      expect(stt.transcribed[0], [1, 1, 1]);
      expect(stt.transcribed[1], [2, 2, 2]);
      expect(chat.callCount, 2);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('interim speech (W1.3)', () {
    test('fires after the delay when the stream produces nothing', () async {
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      expect(controller.state.isGenerating, isTrue);

      // Nothing streamed for one interim delay: the canned line speaks.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(tts.synthesized, [VoiceController.kInterimSpeechLine]);
      expect(playback.playedChunks, hasLength(1));

      // Releasing the stream: empty reply → no further audio.
      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await send;
      await pumpEventQueue();

      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isGenerating, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('does not fire when a reply sentence is already enqueued',
        () async {
      final chat = FakeChatClient(
        streamDeltas: [
          // The trailing capital closes the first boundary mid-stream, so the
          // sentence is enqueued while the stream is still held.
          ['First sentence. Second'],
        ],
        results: [
          const ChatResult(
            content: 'First sentence. Second',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ],
      )..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();

      // The sentence is enqueued and synthesizing long before the delay
      // elapses: first audio is already in flight, no acknowledgement. The
      // timer was cancelled at first playback; by the time the delay has
      // elapsed, even a completed first sentence must not resurrect it.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(tts.synthesized, ['First sentence.']);
      expect(playback.playedChunks, hasLength(1));

      chat.hang!.complete(
        const ChatResult(
          content: 'First sentence. Second',
          toolCalls: [],
          finishReason: 'stop',
        ),
      );
      await send;

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a queued utterance re-arms the acknowledgement', () async {
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final stt = FakeSttEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();

      // First acknowledgement for the silent turn.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();
      expect(playback.playedChunks, hasLength(1));

      // A queued utterance re-arms: a second line speaks for it — from the
      // cache, without a second synthesis.
      mic.emitChunk([1, 1, 1]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(playback.playedChunks, hasLength(2));
      expect(tts.synthesized, [VoiceController.kInterimSpeechLine]);

      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('does not fire on an errored turn', () async {
      final chat = FakeChatClient()..error = ChatServerError('boom');
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      await controller.sendText('hello');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(playback.playedChunks, isEmpty);
      expect(controller.state.error, isNotNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('never fires for a text-mode turn (speakReply: false)', () async {
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      final send = controller.sendText('hello', speakReply: false);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);

      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupt cancels the pending acknowledgement', () async {
      final chat = FakeChatClient()..hang = Completer<ChatResult>();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        interimDelay: const Duration(milliseconds: 20),
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();
      await controller.interrupt();

      // Far past the delay: nothing may fire into an interrupted turn.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await pumpEventQueue();

      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);

      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });
}
