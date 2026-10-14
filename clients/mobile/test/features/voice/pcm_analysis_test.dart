import 'dart:math';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/pcm_analysis.dart';

void main() {
  const sampleRate = 16000;

  group('analyzePcm16Envelope', () {
    test('empty buffer yields zero durations and no level', () {
      final m = analyzePcm16Envelope(const [], sampleRate: sampleRate);

      expect(m.samples, 0);
      expect(m.speechMs, 0);
      expect(m.leadingSilenceMs, 0);
      expect(m.trailingSilenceMs, 0);
      expect(m.peak, 0);
      expect(m.rmsDb, double.negativeInfinity);
    });

    test('all-silence buffer counts the whole span as leading silence', () {
      final m = analyzePcm16Envelope(
        List<int>.filled(1600, 0),
        sampleRate: sampleRate,
      );

      expect(m.samples, 1600);
      expect(m.speechMs, 0);
      expect(m.leadingSilenceMs, 100); // 1600 / 16000 * 1000
      expect(m.trailingSilenceMs, 0);
    });

    test('head/tail silence around speech is isolated', () {
      final samples = <int>[
        ...List<int>.filled(160, 0), // 10 ms leading silence
        ...List<int>.filled(640, 16384), // 40 ms speech (half scale)
        ...List<int>.filled(320, 0), // 20 ms trailing silence
      ];

      final m = analyzePcm16Envelope(samples, sampleRate: sampleRate);

      expect(m.samples, 160 + 640 + 320);
      expect(m.leadingSilenceMs, 10);
      expect(m.trailingSilenceMs, 20);
      expect(m.speechMs, 40);
      expect(m.peak, closeTo(0.5, 0.001));
    });

    test('loud frames between quiet runs bound the silence runs', () {
      final samples = <int>[
        ...List<int>.filled(32, 50), // below the default 80 threshold
        ...List<int>.filled(16, 200), // above threshold
        ...List<int>.filled(32, 50),
      ];

      final m = analyzePcm16Envelope(samples, sampleRate: sampleRate);

      expect(m.leadingSilenceMs, 2); // 32/16000*1000
      expect(m.trailingSilenceMs, 2);
      expect(m.speechMs, 1);
    });

    test('one loud frame breaks the trailing-silence run', () {
      final samples = <int>[
        ...List<int>.filled(160, 0),
        200, // single loud frame, then silence
        ...List<int>.filled(160, 0),
      ];

      final m = analyzePcm16Envelope(samples, sampleRate: sampleRate);

      expect(m.leadingSilenceMs, 10);
      expect(m.trailingSilenceMs, 10);
      expect(m.speechMs, 0); // 1 frame rounds below 1 ms
    });

    test('custom threshold widens or narrows the silence runs', () {
      final samples = <int>[
        ...List<int>.filled(160, 50),
        ...List<int>.filled(640, 200),
        ...List<int>.filled(320, 50),
      ];

      // Default threshold (80): the 50-amplitude frames are "silence".
      final strict = analyzePcm16Envelope(samples, sampleRate: sampleRate);
      expect(strict.leadingSilenceMs, 10);
      expect(strict.trailingSilenceMs, 20);
      expect(strict.speechMs, 40);

      // Low threshold (30): the 50-amplitude frames count as speech.
      final lenient = analyzePcm16Envelope(
        samples,
        sampleRate: sampleRate,
        amplitudeThreshold: 30,
      );
      expect(lenient.leadingSilenceMs, 0);
      expect(lenient.trailingSilenceMs, 0);
      expect(lenient.speechMs, 70);
    });

    test('peak and RMS of a constant half-scale buffer', () {
      final m = analyzePcm16Envelope(
        List<int>.filled(640, 16384),
        sampleRate: sampleRate,
      );

      expect(m.peak, closeTo(0.5, 0.001));
      // RMS of a constant 16384 = 16384 → 20*log10(0.5) dBFS.
      expect(m.rmsDb, closeTo(20 * log(0.5) / ln10, 0.01));
      expect(m.speechMs, 40);
    });
  });

  group('trimPcm16Silence', () {
    test('trims leading/trailing runs but keeps the natural margins', () {
      final samples = <int>[
        ...List<int>.filled(3200, 0), // 200 ms leading silence
        ...List<int>.filled(8000, 16384), // 500 ms speech
        ...List<int>.filled(4800, 0), // 300 ms trailing silence
      ];

      final trimmed = trimPcm16Silence(samples, sampleRate: sampleRate);

      // 200ms - 40ms margin kept from the front; 300ms - 150ms margin kept
      // from the back → 16000 - 160 - 150 = trimmed around 16000 samples.
      expect(trimmed.length, lessThan(samples.length));
      expect(trimmed.length, greaterThan(8000));
      expect(trimmed.first, 0); // margin before speech onset
      expect(trimmed.last, 0); // margin after speech offset
    });

    test('short edge runs below the margins are left untouched', () {
      final samples = <int>[
        ...List<int>.filled(8, 0), // 0.5 ms — well below the 40 ms margin
        ...List<int>.filled(64, 16384),
        ...List<int>.filled(16, 0), // 1 ms — below the 150 ms margin
      ];

      final trimmed = trimPcm16Silence(samples, sampleRate: sampleRate);

      expect(trimmed, same(samples));
    });

    test('internal silence is preserved, only edges are trimmed', () {
      final samples = <int>[
        ...List<int>.filled(3200, 0), // leading silence
        ...List<int>.filled(3200, 16384), // speech
        ...List<int>.filled(800, 0), // internal clause pause (kept)
        ...List<int>.filled(3200, 16384), // speech
        ...List<int>.filled(4800, 0), // trailing silence
      ];

      final trimmed = trimPcm16Silence(samples, sampleRate: sampleRate);

      // Leading 200ms and trailing 300ms trimmed (minus margins), but the
      // 800-sample internal pause must survive intact.
      expect(trimmed.length, lessThan(samples.length));
      expect(trimmed.length, greaterThanOrEqualTo(3200 + 800 + 3200));
    });

    test('all-silence buffers are returned unchanged', () {
      final samples = List<int>.filled(1600, 0);

      final trimmed = trimPcm16Silence(samples, sampleRate: sampleRate);

      expect(trimmed, same(samples));
    });

    test('loud speech below the threshold stays untrimmed', () {
      final samples = List<int>.filled(640, 200);
      expect(trimPcm16Silence(samples, sampleRate: sampleRate), same(samples));
    });
  });
}