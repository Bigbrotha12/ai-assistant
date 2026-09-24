import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/voice/data/mic_capture_service.dart';
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
        ChatResult(
          content: 'got it',
          toolCalls: const [],
          finishReason: 'stop',
        ),
      ],
    );
    mic = FakeMicCaptureService();
    playback = FakeAudioPlayback();
    vad = FakeVadProcessor();
    audioSession = FakeAudioSessionManager();
    stt = FakeSttEngine(transcript: 'recognized speech');
    tts = FakeTtsEngine();
    controller = VoiceController(
      sendTurn:
          ({
            required messages,
            required userText,
            systemPrompt,
            cancelToken,
            onReceived,
            onContent,
            onToolCallDelta,
          }) {
            return chat.sendTurn(
              '',
              history: const [],
              userText: userText,
              messages: messages,
              systemPrompt: systemPrompt,
              cancelToken: cancelToken,
              onReceived: onReceived,
              onContent: onContent,
              onToolCallDelta: onToolCallDelta,
            );
          },
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

  test(
    'speechStopped flushes the buffered mic audio on to the text turn',
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
    },
  );

  test(
    'buffer is cleared between utterances so flushes do not repeat audio',
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
    },
  );

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
    await Future<void>.delayed(const Duration(milliseconds: 1400));
    await pumpEventQueue();
    await pumpEventQueue();

    expect(mic.startCount, 2);
    expect(controller.state.isRecording, isTrue);
    expect(controller.state.isPaused, isFalse);
  });

  test(
    'a real interruption end resumes the mic before the self-heal grace',
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
    },
  );

  // W1.5 (docs/open-gaps.md P2 → docs/production-voice-ux-plan.md): discard
  // the first 150ms of frames after every mic open/reopen before they reach
  // VAD. Timing uses real delays, matching the self-heal test above.
  group('W1.5 post-reopen discard window', () {
    test('frames emitted within 150ms after a restart are dropped', () async {
      await controller.startConversation();
      await pipeline.startRecording();
      // Expire the initial-open window first, so only the restart's window
      // is under test.
      await Future<void>.delayed(const Duration(milliseconds: 200));

      // The recorder dies mid-hold and is restarted.
      mic.emitError(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      await pumpEventQueue();
      expect(mic.startCount, 2);

      // Warm-up frames right after the reopen must not reach VAD.
      mic.emitChunk(List<int>.filled(32, 3));
      await pumpEventQueue();
      expect(vad.processedChunks, isEmpty);
    });

    test('frames after the 150ms window pass through to VAD', () async {
      await controller.startConversation();
      await pipeline.startRecording();
      await Future<void>.delayed(const Duration(milliseconds: 200));

      mic.emitError(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      await pumpEventQueue();
      expect(mic.startCount, 2);

      // Past the window the same frames flow onward again.
      await Future<void>.delayed(const Duration(milliseconds: 200));
      mic.emitChunk(List<int>.filled(32, 4));
      await pumpEventQueue();
      expect(vad.processedChunks, isNotEmpty);
    });

    test('a second restart re-arms the window', () async {
      await controller.startConversation();
      await pipeline.startRecording();
      await Future<void>.delayed(const Duration(milliseconds: 200));

      // Restart 1: once its window lapses, frames are delivered.
      mic.emitError(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      mic.emitChunk(List<int>.filled(16, 1));
      await pumpEventQueue();
      expect(vad.processedChunks, isNotEmpty);
      final delivered = vad.processedChunks.length;

      // Restart 2 recomputes the deadline: fresh frames drop again.
      mic.emitError(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      await pumpEventQueue();
      expect(mic.startCount, 3);
      mic.emitChunk(List<int>.filled(16, 2));
      await pumpEventQueue();
      expect(vad.processedChunks, hasLength(delivered));
    });

    test('the initial mic open also discards its first 150ms', () async {
      await controller.startConversation();
      await pipeline.startRecording();

      // Every-open policy: the first open behaves like a reopen.
      mic.emitChunk(List<int>.filled(16, 9));
      await pumpEventQueue();
      expect(vad.processedChunks, isEmpty);

      await Future<void>.delayed(const Duration(milliseconds: 200));
      mic.emitChunk(List<int>.filled(16, 9));
      await pumpEventQueue();
      expect(vad.processedChunks, hasLength(1));
    });
  });

  group('MicReopenDiscardGate start race', () {
    test('drops a frame emitted while async start is pending', () async {
      final startGate = Completer<void>();
      late final _StartHookMicCaptureService mic;
      mic = _StartHookMicCaptureService((attempt) async {
        if (attempt == 1) {
          mic.emit([1]);
          await startGate.future;
        }
      });
      final gate = MicReopenDiscardGate(mic);
      final received = <List<int>>[];
      final subscription = gate.audioStream.listen(received.add);

      try {
        final start = gate.start();
        await pumpEventQueue();
        expect(received, isEmpty);

        startGate.complete();
        await start;
        await pumpEventQueue();
        expect(received, isEmpty);

        await Future<void>.delayed(
          micReopenDiscardWindow + const Duration(milliseconds: 50),
        );
        mic.emit([2]);
        await pumpEventQueue();
        expect(received, hasLength(1));
        expect(received.single, [2]);
      } finally {
        await subscription.cancel();
        await mic.dispose();
      }
    });

    test(
      'a failed start leaves the window armed for the next attempt',
      () async {
        late final _StartHookMicCaptureService mic;
        mic = _StartHookMicCaptureService((attempt) async {
          if (attempt == 1) {
            mic.emit([1]);
            throw StateError('start failed');
          }
          mic.emit([2]);
        });
        final gate = MicReopenDiscardGate(mic);
        final received = <List<int>>[];
        final subscription = gate.audioStream.listen(received.add);

        try {
          await expectLater(gate.start(), throwsA(isA<StateError>()));
          expect(received, isEmpty);

          await gate.start();
          await pumpEventQueue();
          expect(mic.startCount, 2);
          expect(received, isEmpty);

          await Future<void>.delayed(
            micReopenDiscardWindow + const Duration(milliseconds: 50),
          );
          mic.emit([3]);
          await pumpEventQueue();
          expect(received, hasLength(1));
          expect(received.single, [3]);
        } finally {
          await subscription.cancel();
          await mic.dispose();
        }
      },
    );
  });

  // W1.5 STT path: the pipeline's error-driven mic restart funnels through
  // the gated capture service, re-arming the service-boundary window — so
  // warm-up frames after the restart never reach the controller's STT
  // buffer, a parallel subscriber the pipeline's own filter cannot see.
  // Own wiring (gated mic) so the shared raw-fake fixtures above stay
  // untouched.
  test(
    'a pipeline-driven mic restart re-arms the STT-path discard window',
    () async {
      final restartRawMic = FakeMicCaptureService();
      final restartMic = MicReopenDiscardGate(restartRawMic);
      final restartChat = FakeChatClient();
      final restartVad = FakeVadProcessor();
      final restartSession = FakeAudioSessionManager();
      final restartStt = FakeSttEngine(transcript: '   ');
      final restartPlayback = FakeAudioPlayback();
      final restartController = VoiceController(
        sendTurn:
            ({
              required messages,
              required userText,
              systemPrompt,
              cancelToken,
              onReceived,
              onContent,
              onToolCallDelta,
            }) {
              return restartChat.sendTurn(
                '',
                history: const [],
                userText: userText,
                messages: messages,
                systemPrompt: systemPrompt,
                cancelToken: cancelToken,
                onReceived: onReceived,
                onContent: onContent,
                onToolCallDelta: onToolCallDelta,
              );
            },
        micCapture: restartMic,
        playback: restartPlayback,
        sttEngine: restartStt,
        ttsEngine: FakeTtsEngine(),
        echoGateDuration: Duration.zero,
      );
      final restartPipeline = VoiceCapturePipeline(
        micCapture: restartMic,
        vad: restartVad,
        audioSession: restartSession,
        voiceController: restartController,
      );
      addTearDown(() async {
        if (restartPipeline.isRecording) {
          await restartPipeline.stopRecording();
        }
        await restartPipeline.dispose();
        await restartController.dispose();
        await restartRawMic.dispose();
        await restartPlayback.dispose();
      });

      await restartController.startConversation();
      await restartPipeline.startRecording();
      // Expire the initial-open window so only the restart is under test.
      await Future<void>.delayed(const Duration(milliseconds: 200));

      // Prime the STT buffer with clean audio (whitespace transcript → the
      // flush records it but dispatches no turn).
      restartRawMic.emitChunk(List<int>.filled(16, 1));
      await pumpEventQueue();

      // The recorder dies mid-hold; the pipeline restarts it through the gate.
      restartRawMic.emitError(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      await pumpEventQueue();
      expect(restartRawMic.startCount, 2);

      // Warm-up frame right after the reopen must not reach the STT buffer:
      // the flush sees only the pre-restart audio.
      restartRawMic.emitChunk(List<int>.filled(16, 2));
      await pumpEventQueue();
      await restartController.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      expect(restartStt.transcribed, hasLength(1));
      expect(restartStt.transcribed.single, everyElement(1));

      // Past the re-armed window, frames buffer again.
      await Future<void>.delayed(const Duration(milliseconds: 200));
      restartRawMic.emitChunk(List<int>.filled(16, 3));
      await pumpEventQueue();
      await restartController.flushTranscriptionBuffer();
      await pumpEventQueue();
      await pumpEventQueue();
      expect(restartStt.transcribed, hasLength(2));
      expect(restartStt.transcribed.last, everyElement(3));
    },
  );

  group('mic subscription lifecycle', () {
    test(
      'error followed by done restarts once and leaves one pipeline listener',
      () async {
        final harness = _TrackedPipelineHarness();
        addTearDown(harness.dispose);

        await harness.controller.startConversation();
        await harness.pipeline.startRecording();
        expect(harness.mic.activeListenerCount, 2);

        harness.mic.emitErrorAndDoneToNewest(Exception('ERROR_DEAD_OBJECT'));
        await pumpEventQueue();
        await pumpEventQueue();

        expect(harness.mic.startCount, 2);
        expect(harness.mic.activeListenerCount, 2);
        expect(harness.pipeline.isRecording, isTrue);
      },
    );

    test(
      'cancels the old subscription before installing its replacement',
      () async {
        final harness = _TrackedPipelineHarness();
        addTearDown(harness.dispose);
        final cancelGate = Completer<void>();
        harness.mic.cancelGate = cancelGate;

        await harness.controller.startConversation();
        await harness.pipeline.startRecording();
        expect(harness.mic.activeListenerCounts, [1, 2]);

        harness.mic.emitErrorToNewest(Exception('ERROR_DEAD_OBJECT'));
        await pumpEventQueue();
        await pumpEventQueue();

        expect(harness.mic.startCount, 2);
        expect(harness.mic.activeListenerCount, 2);
        expect(harness.mic.activeListenerCounts, [1, 2]);

        cancelGate.complete();
        await pumpEventQueue();
        await pumpEventQueue();
        expect(harness.mic.activeListenerCounts, [1, 2, 2]);
        expect(harness.mic.activeListenerCount, 2);
      },
    );

    test(
      'stop while restart is in flight does not reattach or deliver frames',
      () async {
        final harness = _TrackedPipelineHarness();
        addTearDown(harness.dispose);
        final restartGate = Completer<void>();
        harness.mic.onStart = (attempt) async {
          if (attempt == 2) await restartGate.future;
        };

        await harness.controller.startConversation();
        await harness.pipeline.startRecording();
        await Future<void>.delayed(const Duration(milliseconds: 200));
        harness.mic.emitErrorToNewest(Exception('ERROR_DEAD_OBJECT'));
        await pumpEventQueue();
        expect(harness.mic.startCount, 2);

        await harness.pipeline.stopRecording();
        expect(harness.pipeline.isRecording, isFalse);
        expect(harness.mic.activeListenerCount, 1);
        harness.mic.emitChunk(List<int>.filled(16, 8));
        await pumpEventQueue();
        expect(harness.vad.processedChunks, isEmpty);

        restartGate.complete();
        await pumpEventQueue();
        await pumpEventQueue();
        expect(harness.mic.startCount, 2);
        expect(harness.mic.activeListenerCount, 1);
        expect(harness.vad.processedChunks, isEmpty);
      },
    );

    test('dispose while restart is in flight does not reattach', () async {
      final harness = _TrackedPipelineHarness();
      addTearDown(harness.dispose);
      final restartGate = Completer<void>();
      harness.mic.onStart = (attempt) async {
        if (attempt == 2) await restartGate.future;
      };

      await harness.controller.startConversation();
      await harness.pipeline.startRecording();
      harness.mic.emitErrorToNewest(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      expect(harness.mic.startCount, 2);

      await harness.pipeline.dispose();
      expect(harness.mic.activeListenerCount, 1);
      harness.mic.emitChunk(List<int>.filled(16, 9));
      await pumpEventQueue();
      expect(harness.vad.processedChunks, isEmpty);

      restartGate.complete();
      await pumpEventQueue();
      await pumpEventQueue();
      expect(harness.mic.startCount, 2);
      expect(harness.mic.activeListenerCount, 1);
    });

    test('a restart racing stop is ignored', () async {
      final harness = _TrackedPipelineHarness();
      addTearDown(harness.dispose);
      final restartGate = Completer<void>();
      harness.mic.onStart = (attempt) async {
        if (attempt == 2) await restartGate.future;
      };

      await harness.controller.startConversation();
      await harness.pipeline.startRecording();
      harness.mic.emitErrorToNewest(Exception('ERROR_DEAD_OBJECT'));
      await pumpEventQueue();
      expect(harness.mic.startCount, 2);

      final stop = harness.pipeline.stopRecording();
      harness.mic.emitErrorAndDoneToNewest(Exception('late failure'));
      await stop;
      restartGate.complete();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(harness.pipeline.isRecording, isFalse);
      expect(harness.mic.startCount, 2);
      expect(harness.mic.activeListenerCount, 1);
    });
  });
}

class _TrackedMicCaptureService implements MicCaptureService {
  _TrackedMicCaptureService();

  final List<_TrackedMicListener> _listeners = [];
  final List<int> activeListenerCounts = [];
  Completer<void>? cancelGate;
  Future<void> Function(int attempt)? onStart;
  int startCount = 0;
  bool _isRecording = false;

  int get activeListenerCount => _listeners.length;

  _TrackedMicListener get newestListener => _listeners.last;

  @override
  Stream<List<int>> get audioStream => Stream<List<int>>.multi((controller) {
    final listener = _TrackedMicListener(this, controller);
    _listeners.add(listener);
    activeListenerCounts.add(_listeners.length);
    controller.onCancel = () {
      final gate = cancelGate;
      if (gate == null) {
        _remove(listener);
        return Future<void>.value();
      }

      return gate.future.then((_) {
        _remove(listener);
      });
    };
  });

  @override
  bool get isRecording => _isRecording;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Future<void> start({int sampleRate = 16000}) async {
    if (_isRecording) return;
    final attempt = ++startCount;
    final hook = onStart;
    if (hook != null) await hook(attempt);
    _isRecording = true;
  }

  @override
  Future<void> stop() async {
    _isRecording = false;
  }

  void emitChunk(List<int> chunk) {
    for (final listener in List<_TrackedMicListener>.of(_listeners)) {
      listener.add(chunk);
    }
  }

  void emitErrorToNewest(Object error) {
    _isRecording = false;
    newestListener.addError(error);
  }

  void emitErrorAndDoneToNewest(Object error) {
    _isRecording = false;
    final listener = newestListener;
    listener.addError(error);
    listener.close();
  }

  void _remove(_TrackedMicListener listener) {
    _listeners.remove(listener);
  }

  Future<void> dispose() async {
    for (final listener in List<_TrackedMicListener>.of(_listeners)) {
      listener.close();
    }
  }
}

class _TrackedMicListener {
  _TrackedMicListener(this.owner, this.controller);

  final _TrackedMicCaptureService owner;
  final MultiStreamController<List<int>> controller;

  void add(List<int> chunk) {
    if (!controller.isClosed) controller.add(chunk);
  }

  void addError(Object error) {
    if (!controller.isClosed) controller.addError(error);
  }

  void close() {
    if (controller.isClosed) return;
    owner._remove(this);
    unawaited(controller.close());
  }
}

class _TrackedPipelineHarness {
  _TrackedPipelineHarness() {
    controller = VoiceController(
      sendTurn:
          ({
            required messages,
            required userText,
            systemPrompt,
            cancelToken,
            onReceived,
            onContent,
            onToolCallDelta,
          }) {
            return chat.sendTurn(
              '',
              history: const [],
              userText: userText,
              messages: messages,
              systemPrompt: systemPrompt,
              cancelToken: cancelToken,
              onReceived: onReceived,
              onContent: onContent,
              onToolCallDelta: onToolCallDelta,
            );
          },
      micCapture: mic,
      playback: playback,
      echoGateDuration: Duration.zero,
    );
    pipeline = VoiceCapturePipeline(
      micCapture: mic,
      vad: vad,
      audioSession: audioSession,
      voiceController: controller,
    );
  }

  final chat = FakeChatClient();
  final mic = _TrackedMicCaptureService();
  final playback = FakeAudioPlayback();
  final vad = FakeVadProcessor();
  final audioSession = FakeAudioSessionManager();
  late final VoiceController controller;
  late final VoiceCapturePipeline pipeline;

  Future<void> dispose() async {
    if (pipeline.isRecording) {
      await pipeline.stopRecording();
    }
    await pipeline.dispose();
    await controller.dispose();
    await mic.dispose();
    await playback.dispose();
  }
}

class _StartHookMicCaptureService implements MicCaptureService {
  _StartHookMicCaptureService(this._onStart);

  final Future<void> Function(int attempt) _onStart;
  final StreamController<List<int>> _audioController =
      StreamController<List<int>>.broadcast(sync: true);

  int startCount = 0;
  bool _isRecording = false;

  @override
  Stream<List<int>> get audioStream => _audioController.stream;

  @override
  bool get isRecording => _isRecording;

  @override
  Future<void> start({int sampleRate = 16000}) async {
    final attempt = ++startCount;
    await _onStart(attempt);
    _isRecording = true;
  }

  @override
  Future<void> stop() async {
    _isRecording = false;
  }

  @override
  Future<bool> requestPermission() async => true;

  void emit(List<int> chunk) {
    if (!_audioController.isClosed) {
      _audioController.add(chunk);
    }
  }

  Future<void> dispose() => _audioController.close();
}
