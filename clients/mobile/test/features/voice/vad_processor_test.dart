import 'package:ai_assistant/features/voice/data/vad_processor.dart';
import 'package:flutter_test/flutter_test.dart';

/// Builds a PCM16 buffer of [count] samples at the given [amplitude]
/// (signed 16-bit magnitude). A value of 0 is absolute silence.
List<int> _tone({int count = 100, int amplitude = 0}) =>
    List<int>.generate(count, (_) => amplitude, growable: false);

/// Loud speech-like signal: comfortably above every start threshold.
List<int> _speech() => _tone(count: 100, amplitude: 16000);

/// Near-silence: far below every stop threshold.
List<int> _silence() => _tone(count: 100, amplitude: 0);

/// Tone at ~-30 dBFS, above the most-sensitive threshold (-50 dB) but below
/// the least-sensitive one (-20 dB).
List<int> _midTone() => _tone(count: 100, amplitude: 1000);

/// Flushes the broadcast stream's asynchronous event delivery.
Future<void> _flush() => Future<void>.delayed(Duration.zero);

void main() {
  group('EnergyBasedVadProcessor', () {
    late VadProcessor vad;

    setUp(() {
      vad = EnergyBasedVadProcessor(sensitivity: 0.5);
    });

    tearDown(() {
      vad.dispose();
    });

    test('starts idle and stays idle on silence', () {
      expect(vad.state, VadState.idle);
      expect(vad.processChunk(_silence()), isFalse);
      expect(vad.state, VadState.idle);
    });

    test(
      'transitions idle -> speechStarted -> speechStopped -> idle',
      () async {
        final events = <VadState>[];
        final sub = vad.stateChanges.listen(events.add);

        // Above-threshold energy held longer than the min speech duration
        // confirms the start.
        vad.processChunk(_speech());
        await Future<void>.delayed(const Duration(milliseconds: 250));
        expect(vad.processChunk(_speech()), isTrue);
        expect(vad.state, VadState.speechStarted);

        // Below-threshold energy held longer than the min silence duration
        // ends the utterance.
        vad.processChunk(_silence());
        await Future<void>.delayed(const Duration(milliseconds: 400));
        vad.processChunk(_silence());
        expect(vad.state, VadState.speechStopped);

        // The next chunk resets to idle.
        vad.processChunk(_silence());
        expect(vad.state, VadState.idle);

        await _flush();
        await sub.cancel();
        expect(events, containsAllInOrder([
          VadState.speechStarted,
          VadState.speechStopped,
          VadState.idle,
        ]));
      },
      timeout: const Timeout(Duration(seconds: 5)),
    );

    test('short speech burst below min duration does not trigger', () async {
      final events = <VadState>[];
      final sub = vad.stateChanges.listen(events.add);

      // A loud burst that doesn't outlast the min speech duration, followed
      // by silence before the threshold is held.
      vad.processChunk(_speech());
      await Future<void>.delayed(const Duration(milliseconds: 50));
      vad.processChunk(_silence());
      await Future<void>.delayed(const Duration(milliseconds: 400));
      vad.processChunk(_silence());

      expect(vad.state, VadState.idle);
      await _flush();
      await sub.cancel();
      expect(events, isEmpty);
    });

    test('higher sensitivity lowers the start threshold (more sensitive)', () async {
      final sensitive = EnergyBasedVadProcessor(sensitivity: 1.0);
      final insensitive = EnergyBasedVadProcessor(sensitivity: 0.0);

      // A mid-level tone is above the high-sensitivity threshold but below
      // the low-sensitivity threshold, so only the sensitive detector fires.
      insensitive.processChunk(_midTone());
      await Future<void>.delayed(const Duration(milliseconds: 250));
      insensitive.processChunk(_midTone());
      expect(insensitive.state, VadState.idle);

      sensitive.processChunk(_midTone());
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(sensitive.processChunk(_midTone()), isTrue);
      expect(sensitive.state, VadState.speechStarted);

      insensitive.dispose();
      sensitive.dispose();
    }, timeout: const Timeout(Duration(seconds: 5)));
  });
}
