// Headless reproduction of the "chunks with long pauses" artifact.
//
// Does NOT use the real model/backend — synthesis latency (Supertonic) and
// LLM delivery timing are simulated with a stopwatch so the serialisation
// structure of the speak-queue drain can be measured deterministically:
//
//   Test 1 — LLM stays ahead: sentences are already queued when playback of
//   the previous chunk ends, so the inter-chunk pause must equal the next
//   chunk's synthesis time (the drain waits for `ended` before synthesising).
//
//   Test 2 — LLM lags: the queue empties mid-reply; the pause then grows by
//   the time the LLM/splitter takes to deliver the next sentence.
//
// Real wall-clock numbers: the fakes use `Future.delayed`, so measurements
// are in true milliseconds (generous tolerances keep them robust).

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/voice/data/audio_playback_service.dart';
import 'package:ai_assistant/features/voice/data/tts_engine.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

void main() {
  const synthDelayMs = 120;
  const chunkAudioMs = 100;

  group('voice pipeline chunk timing', () {
    test('inter-chunk pause equals next-chunk synthesis when the LLM is ahead',
        () async {
      final clock = Stopwatch()..start();
      final chat = FakeChatClient(
        streamDeltas: [
          ['Alpha one. Beta two. ', 'Gamma three.'],
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
      final playback = TimedPlayback(clock);
      final tts = TimedTts(
        clock: clock,
        delayMs: synthDelayMs,
        audioDurationMs: chunkAudioMs,
      );

      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      final turnStart = clock.elapsedMilliseconds;
      await controller.sendText('hello');

      expect(tts.synthesized, hasLength(3));
      expect(playback.playStartsMs, hasLength(3));
      _printTimeline(clock, playback, tts, turnStart, 'LLM ahead');

      // Gap between chunk N's playback end and chunk N+1's playback start.
      final gapA = playback.playStartsMs[1] - playback.playEndsMs[0];
      final gapB = playback.playStartsMs[2] - playback.playEndsMs[1];
      // With one-ahead pipelining, chunk N+1's synthesis overlaps chunk N's
      // playback: synthesis of the next chunk starts before the current one
      // finishes, and the audible gap shrinks below the full synthesis time
      // (120ms synth vs 100ms playback → ~20ms residual).
      expect(
        tts.synthStartMs[1],
        lessThan(playback.playEndsMs[0]),
        reason: 'chunk 2 synthesis started while chunk 1 was still playing',
      );
      expect(
        tts.synthStartMs[2],
        lessThan(playback.playEndsMs[1]),
        reason: 'chunk 3 synthesis started while chunk 2 was still playing',
      );
      expect(gapA, lessThan(synthDelayMs), reason: 'gap 1-2 < full synth');
      expect(gapB, lessThan(synthDelayMs), reason: 'gap 2-3 < full synth');
      // Time to first audio ≈ first synthesis cost only (no LLM round-trip
      // wait thrown in).
      expect(
        playback.playStartsMs[0] - turnStart,
        _approx(synthDelayMs),
        reason: 'time to first audio',
      );

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });

    test('pause grows by the LLM catch-up wait when the queue empties mid-reply',
        () async {
      final clock = Stopwatch()..start();
      const llmDelayMs = 400;
      final chat = StagedChatClient(
        clock: clock,
        stageGapMs: llmDelayMs,
        stageDeltas: [
          // Newline-delimited so the splitter closes sentence 1 immediately
          // (a '.'-terminal would wait for the lookahead of sentence 2).
          ['First sentence.\n'],
          ['Second sentence.'],
        ],
        result: ChatResult(
          content: 'First sentence. Second sentence.',
          toolCalls: const [],
          finishReason: 'stop',
        ),
      );
      final mic = FakeMicCaptureService();
      final playback = TimedPlayback(clock);
      final tts = TimedTts(
        clock: clock,
        delayMs: synthDelayMs,
        audioDurationMs: chunkAudioMs,
      );

      final controller = VoiceController(
        chatClient: chat,
        micCapture: mic,
        playback: playback,
        ttsEngine: tts,
        echoGateDuration: Duration.zero,
      );
      await controller.startConversation();

      final turnStart = clock.elapsedMilliseconds;
      await controller.sendText('hello');

      expect(tts.synthesized, hasLength(2));
      expect(playback.playStartsMs, hasLength(2));
      _printTimeline(clock, playback, tts, turnStart, 'LLM lags');

      // Sentence 1 is delivered at t≈0; it synthesises for ~synthDelayMs then
      // plays for ~chunkAudioMs. Sentence 2 arrives only at t≈llmDelayMs, so
      // the queue is empty from play1's end (≈ synth+audio) until then. That
      // empty-queue wait, plus sentence 2's synthesis, is the audible pause
      // between the two chunks.
      final gap = playback.playStartsMs[1] - playback.playEndsMs[0];
      final emptyQueueWait = llmDelayMs - synthDelayMs - chunkAudioMs;
      expect(
        emptyQueueWait,
        _approx(180),
        reason: 'queue sat empty for the residual LLM delay',
      );
      final expectedGap = llmDelayMs - chunkAudioMs;
      expect(gap, _approx(expectedGap), reason: 'gap 1-2 (LLM-bound)');

      await controller.dispose();
      await mic.dispose();
      await playback.dispose();
    });
  });
}

/// Loose-but-meaningful window around [expected]: ±40% or ±30ms, whichever
/// is larger, so a loaded workstation cannot flake the test while a real
/// regression (pause of the wrong magnitude) still fails.
Matcher _approx(int expected) {
  final slack = (expected * 0.4).round().clamp(30, 10000);
  return closeTo(expected.toDouble(), slack.toDouble());
}

void _printTimeline(
  Stopwatch clock,
  TimedPlayback playback,
  TimedTts tts,
  int turnStartMs,
  String label,
) {
  // ignore: avoid_print
  print(
    '--- [$label] synthMs=${tts.synthStartMs}/${tts.synthEndMs} '
    'play=${playback.playStartsMs}/${playback.playEndsMs} '
    'ttfb=${playback.playStartsMs.isEmpty ? 0 : playback.playStartsMs.first - turnStartMs}ms',
  );
}

/// Playback that consumes PCM at real-time rate (16 kHz): emits isPlaying
/// true on play, false after `samples/16` ms.
class TimedPlayback implements AudioPlayback {
  TimedPlayback(this.clock);

  final Stopwatch clock;
  final _isPlaying = StreamController<bool>.broadcast();
  final _errors = StreamController<Object>.broadcast();

  final List<int> playStartsMs = [];
  final List<int> playEndsMs = [];
  final List<List<int>> playedChunks = [];

  @override
  Stream<bool> get isPlaying => _isPlaying.stream;

  @override
  Stream<Object> get errors => _errors.stream;

  @override
  Future<void> playAudio(List<int> pcm16Samples) async {
    playedChunks.add(pcm16Samples);
    playStartsMs.add(clock.elapsedMilliseconds);
    await Future<void>.delayed(Duration.zero);
    if (!_isPlaying.isClosed) _isPlaying.add(true);
    final durationMs = pcm16Samples.length * 1000 ~/ kPlaybackSampleRate;
    unawaited(
      Future<void>.delayed(Duration(milliseconds: durationMs)).then((_) {
        playEndsMs.add(clock.elapsedMilliseconds);
        if (!_isPlaying.isClosed) _isPlaying.add(false);
      }),
    );
  }

  @override
  Future<void> stop() async {
    if (!_isPlaying.isClosed) _isPlaying.add(false);
  }

  Future<void> dispose() async {
    await _isPlaying.close();
    await _errors.close();
  }
}

/// TTS that takes [delayMs] per chunk and returns [audioDurationMs] of PCM.
class TimedTts implements TtsEngine {
  TimedTts({
    required this.clock,
    required this.delayMs,
    required this.audioDurationMs,
  });

  final Stopwatch clock;
  final int delayMs;
  final int audioDurationMs;

  @override
  String get name => 'timed_tts';

  final List<String> synthesized = [];
  final List<int> synthStartMs = [];
  final List<int> synthEndMs = [];

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    synthesized.add(text);
    synthStartMs.add(clock.elapsedMilliseconds);
    if (delayMs > 0) {
      await Future<void>.delayed(Duration(milliseconds: delayMs));
    }
    synthEndMs.add(clock.elapsedMilliseconds);
    return List<int>.filled(sampleRate * audioDurationMs ~/ 1000, 16384);
  }
}

/// Delivers staged sentence groups separated by [stageGapMs], simulating an
/// LLM that streams the next sentence only after a delay.
class StagedChatClient implements ChatClient {
  StagedChatClient({
    required this.clock,
    required this.stageGapMs,
    required this.stageDeltas,
    required this.result,
  });

  final Stopwatch clock;
  final int stageGapMs;
  final List<List<String>> stageDeltas;
  final ChatResult result;

  @override
  Future<ChatResult> streamCompletions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) async {
    if (cancelToken?.isCancelled ?? false) {
      throw const ChatNetworkError('cancelled');
    }
    for (var i = 0; i < stageDeltas.length; i++) {
      for (final delta in stageDeltas[i]) {
        onContent?.call(delta);
      }
      if (i < stageDeltas.length - 1) {
        await Future<void>.delayed(Duration(milliseconds: stageGapMs));
      }
    }
    return result;
  }

  @override
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
    void Function()? onReceived,
  }) {
    throw UnimplementedError();
  }
}