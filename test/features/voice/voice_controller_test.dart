import 'dart:async';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/chat/data/status_tracker.dart'
    show domainPhrases;
import 'package:ai_assistant/features/voice/data/engine_errors.dart';
import 'package:ai_assistant/features/voice/ui/voice_conversation_state.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller.dart';

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

    test('interrupt re-opens the mic gates synchronously even while the '
        'playback stop is held open', () async {
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()
        ..holdCompletion = Completer<void>()
        ..stopGate = Completer<void>();
      final tts = FakeTtsEngine();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
      );
      await controller.startConversation();

      unawaited(controller.synthesizeOnDevice('hello'));
      await pumpEventQueue();
      expect(controller.state.isAiSpeaking, isTrue);

      // The stop is held open, yet the gates must reopen before it resolves:
      // a barge-in recording that starts now must not be blocked on it.
      final interruptFuture = controller.interrupt();
      expect(controller.state.isAiSpeaking, isFalse);

      // The stop resolves; interrupt completes and the flag stays cleared.
      playback.stopGate!.complete();
      await interruptFuture;
      expect(controller.state.isAiSpeaking, isFalse);

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

    test('barge-in mid-reply then a follow-up utterance still completes its '
        'turn (user-observed pipeline stall)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha. Beta.'],
        ],
        results: [
          const ChatResult(
            content: 'Alpha. Beta.',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback()..holdCompletion = Completer<void>();
      final tts = FakeTtsEngine();
      final stt = FakeSttEngine(transcript: 'follow up');
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      // Turn 1 (user speaks, releases, the AI starts replying).
      mic.emitChunk([1, 1, 1]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      expect(chat.callCount, 1);
      expect(stt.transcribed, hasLength(1));
      // Alpha is playing (held open).
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isTrue);

      // Barge-in mid-reply: the user presses the talk button.
      await controller.interrupt();
      // Release the interrupted track: the drain must exit cleanly.
      playback.holdCompletion!.complete();
      await pumpEventQueue();
      await pumpEventQueue();
      expect(controller.state.isAiSpeaking, isFalse);

      // The follow-up utterance: hold → speak → release → flush.
      mic.emitChunk([2, 2, 2]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      await pumpEventQueue();

      // Turn 2 MUST complete: STT ran, the stream started, a reply spoke.
      // (Turn 1 spoke Alpha; turn 2's reply "Alpha. Beta." speaks two
      // sentences — the follow-up survived the interrupt intact.)
      expect(stt.transcribed, hasLength(2));
      expect(chat.callCount, 2);
      expect(playback.playedChunks, hasLength(3));
      expect(controller.state.isAiSpeaking, isFalse);

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
      // Gate only the SECOND synthesis: with pipelining, sentence 2's
      // synthesis starts while sentence 1 is still playing, so gating from the
      // start would also hold sentence 1. gating index >= 1 keeps sentence 1
      // free while the prefetched sentence 2 hangs.
      final tts = FakeTtsEngine()
        ..gate = Completer<void>()
        ..gateStartIndex = 1;
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
      expect(tts.synthesized, isNotEmpty);
      expect(tts.synthesized.first, 'First sentence.');

      // Sentence 1 ends; sentence 2's prefetched synthesis is still held. The
      // raw player is idle (isPlaying flipped false), but the turn must still
      // count as speaking — the mic gates must not re-open mid-reply.
      playback.holdCompletion!.complete();
      await pumpEventQueue();
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isTrue);

      // Release the prefetched synthesis: sentence 2 plays and the turn
      // closes.
      tts.gate!.complete();
      await send;
      expect(tts.synthesized, ['First sentence.', 'Second sentence.']);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('the next sentence is synthesised while the current one plays '
        '(one-ahead pipeline)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['First sentence. ', 'Second sentence.'],
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
      // Gate only the second synthesis so it is observably requested while
      // sentence 1 is still playing (the prefetch) rather than after it ends.
      final tts = FakeTtsEngine()
        ..gate = Completer<void>()
        ..gateStartIndex = 1;
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

      // Sentence 1 is playing, held open — yet sentence 2's synthesis has
      // ALREADY been requested. Playback end no longer gates the next
      // synthesis.
      expect(playback.playedChunks, hasLength(1));
      expect(tts.synthesized, ['First sentence.', 'Second sentence.']);

      // Let sentence 1 finish and release sentence 2's prefetched synthesis:
      // sentence 2 then plays without a fresh synthesis in between.
      playback.holdCompletion!.complete();
      tts.gate!.complete();
      await send;

      expect(tts.synthesized, ['First sentence.', 'Second sentence.']);
      expect(playback.playedChunks, hasLength(2));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('model-baked edge silence is trimmed before playback', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha.'],
        ],
        results: [
          ChatResult(
            content: 'Alpha.',
            toolCalls: const [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      // A chunk with 200ms leading + 300ms trailing silence baked in.
      final padded = <int>[
        ...List<int>.filled(3200, 0),
        ...List<int>.filled(8000, 16384),
        ...List<int>.filled(4800, 0),
      ];
      final tts = FakeTtsEngine(samples: padded);
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      await controller.sendText('hello');

      // The played chunk is shorter than the synthesized one: the edge
      // silence was cut (keeping a natural margin), while the speech core
      // survives.
      expect(playback.playedChunks, hasLength(1));
      expect(playback.playedChunks.single.length, lessThan(padded.length));
      expect(playback.playedChunks.single.length, greaterThan(8000));

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
      // Alpha playing (held); Beta may already be prefetch-synthesised but
      // not yet played.
      expect(controller.state.isAiSpeaking, isTrue);
      expect(tts.synthesized, isNotEmpty);
      expect(tts.synthesized.first, 'Alpha.');

      await controller.interrupt();
      expect(controller.state.isAiSpeaking, isFalse);

      // Releasing the held playback must not resurrect the queue.
      playback.holdCompletion!.complete();
      await send;

      expect(tts.synthesized, contains('Alpha.'));
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
      // Alpha played; Beta may already be prefetch-synthesised but its
      // playback is suspended by the pause.
      expect(tts.synthesized, contains('Alpha.'));

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

  group('review fixes (post-commit 0995545)', () {
    test('a hung synthesis times out, drops that sentence, and the queue '
        'continues (C1)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['First sentence. Second sentence.'],
        ],
        results: [
          const ChatResult(
            content: 'First sentence. Second sentence.',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine()..gate = Completer<void>();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        synthesisTimeout: const Duration(milliseconds: 30),
      );
      await controller.startConversation();

      final send = controller.sendText('hello');
      await pumpEventQueue();

      // Sentence 1's synthesis hangs past the timeout: it is dropped and
      // reported, and the drain moves on to sentence 2 (the remainder),
      // whose synthesis is now also hanging on the same gate.
      await Future<void>.delayed(const Duration(milliseconds: 40));
      await pumpEventQueue();
      expect(controller.state.error, isNotNull);
      expect(playback.playedChunks, isEmpty);

      // Release before sentence 2's own timeout (started at ~30ms): it
      // synthesizes and plays — the queue survived the timed-out sentence.
      tts.gate!.complete();
      await send;
      await pumpEventQueue();

      // Sentence 2 survived and played. (The fake records the synthesis
      // request before its gate, so both calls appear in the record; only
      // sentence 2 produced audio.)
      expect(tts.synthesized, containsAll(['First sentence.', 'Second sentence.']));
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('interrupt during a held synthesis does not swallow the next '
        'turn\'s first sentence (M1)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha.'],
        ],
        results: [
          const ChatResult(
            content: 'Alpha.',
            toolCalls: [],
            finishReason: 'stop',
          ),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine()..gate = Completer<void>();
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      // Turn 1 enqueues Alpha; its synthesis hangs.
      final send1 = controller.sendText('hi');
      await pumpEventQueue();
      expect(tts.synthesized, ['Alpha.']);

      // Barge-in while the synthesis is still in flight, then let the stale
      // synthesis return.
      await controller.interrupt();
      tts.gate!.complete();
      await send1;

      // Turn 2 must get a FRESH drain: its Alpha is synthesized and played.
      final send2 = controller.sendText('hi again');
      await send2;

      expect(tts.synthesized, ['Alpha.', 'Alpha.']);
      expect(playback.playedChunks, hasLength(1));
      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('a playback stream closed mid-drain drops the queue instead of '
        'stranding it (M3)', () async {
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha. Beta.'],
        ],
        results: [
          const ChatResult(
            content: 'Alpha. Beta.',
            toolCalls: [],
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
      expect(playback.playedChunks, hasLength(1));

      // The player is torn down while Alpha is "playing": its end-wait
      // throws StateError — the drain must complete, drop the rest, and
      // return instead of hanging the turn.
      await playback.dispose();
      await send;

      expect(controller.state.isAiSpeaking, isFalse);

      await controller.dispose();
      await mic.dispose();
    });

    test('interrupt clears a stale drop notice (m6)', () async {
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
      await pumpEventQueue();
      // Queued, then dropped with a notice.
      mic.emitChunk([2, 2, 2]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      mic.emitChunk([3, 3, 3]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();
      expect(controller.state.notice, isNotNull);

      await controller.interrupt();
      expect(controller.state.notice, isNull);

      chat.hang!.complete(
        const ChatResult(content: '', toolCalls: [], finishReason: 'stop'),
      );
      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('onDeviceTranscript callback fires exactly once per utterance (m5)',
        () async {
      final chat = FakeChatClient(
        results: [
          const ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
        ],
      );
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final tts = FakeTtsEngine();
      final stt = FakeSttEngine();
      final transcripts = <String>[];
      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        sttEngine: stt,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
        onDeviceTranscript: transcripts.add,
      );
      await controller.startConversation();

      mic.emitChunk([1, 1, 1]);
      await Future<void>.delayed(Duration.zero);
      await controller.flushTranscriptionBuffer();
      await pumpEventQueue();

      expect(transcripts, ['hello']);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });

  group('status interjections', () {
    test('ack fires onReceived and enqueues a TTS phrase', () async {
      final chat = FakeChatClient(
        fireOnReceived: true,
        results: [
          const ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
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

      await controller.sendText('hello');
      await pumpEventQueue();

      // The ack fires before content; at least one interjection phrase was
      // enqueued before the reply text itself.
      expect(tts.synthesized, isNotEmpty);
      expect(tts.synthesized.first, isNot('hi'));
      expect(tts.synthesized, contains('hi'));
      // After the turn, status is cleared.
      expect(controller.state.status, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('onToolCallDelta sets status with Working prefix and enqueues TTS',
        () async {
      final chat = FakeChatClient(
        fireOnReceived: true,
        toolCallDeltas: [
          [(0, 'tasks_list_mcp_vikunja', '')],
        ],
        streamDeltas: [
          ['done'],
        ],
        results: [
          const ChatResult(content: 'done', toolCalls: [], finishReason: 'stop'),
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

      final emissions = <VoiceConversationState>[];
      controller.stateStream.listen(emissions.add);

      await controller.sendText('hello');
      await pumpEventQueue();

      // The tool-call fragment (with the task tool name) drove the status
      // interjection to 'Working — …' at some point during the stream.
      expect(
        emissions.any((s) => (s.status ?? '').startsWith('Working — ')),
        isTrue,
      );
      // A TTS utterance from the task phrase set was enqueued via the tracker.
      final taskPhrases = domainPhrases['task']!;
      expect(tts.synthesized.any((s) => taskPhrases.contains(s)), isTrue);
      // The stream then completed with content: the reply spoke and the
      // status interjection was cleared.
      expect(tts.synthesized, contains('done'));
      expect(controller.state.status, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('error phrase is spoken on a non-cancelled error', () async {
      final failure = ChatServerError('boom');
      final chat = FakeChatClient(fireOnReceived: true)..error = failure;
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

      await controller.sendText('hello');
      await pumpEventQueue();

      expect(controller.state.error, same(failure));
      // The TTS engine received at least one error-phrase utterance.
      expect(tts.synthesized, isNotEmpty);
      // The error phrase must be one of the known server error phrases
      // (the fake picks from the list deterministically or randomly).
      final hasErrorPhrase = tts.synthesized.any(
        (s) => s.contains('snag') ||
            s.contains('issue') ||
            s.contains('try again') ||
            s.contains('server'),
      );
      expect(hasErrorPhrase, isTrue);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('status is cleared at turn start and on abandon', () async {
      final chat = FakeChatClient(
        fireOnReceived: true,
        results: [
          const ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
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

      // Start a turn that hangs mid-stream.
      final send = controller.sendText('hello');
      await pumpEventQueue();

      // The ack has fired, so status should be set to 'Thinking…' or similar.
      expect(controller.state.status, isNotNull);

      // Cancel the token by interrupting.
      await controller.interrupt();
      chat.hang!.complete(
        const ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
      );
      await send;

      // After abandon, status is cleared.
      expect(controller.state.status, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('ack updates the status display but does not speak when '
        'speakReply is false', () async {
      final chat = FakeChatClient(
        fireOnReceived: true,
        results: [
          const ChatResult(content: 'hi', toolCalls: [], finishReason: 'stop'),
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

      final emissions = <VoiceConversationState>[];
      controller.stateStream.listen(emissions.add);

      await controller.sendText('text mode reply', speakReply: false);
      await pumpEventQueue();

      // The ack interjection still drove the status display…
      expect(emissions.any((s) => s.status == 'Thinking…'), isTrue);
      // …but no utterances were enqueued for TTS or played.
      expect(tts.synthesized, isEmpty);
      expect(playback.playedChunks, isEmpty);
      // The reply text still lands in the transcript state without speech.
      expect(controller.state.lastReply, 'hi');
      // The status interjection is cleared once the turn completes.
      expect(controller.state.status, isNull);

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });
}
