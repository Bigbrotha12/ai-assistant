import 'dart:io';
import 'dart:typed_data';

import 'package:ai_assistant/features/voice/engine_errors.dart';
import 'package:ai_assistant/features/voice/engines/supertonic_tts_engine.dart';
import 'package:ai_assistant/features/voice/pcm_resample.dart';
import 'package:flutter_test/flutter_test.dart';

/// Canned-samples [SupertonicSynthesizer] double. Never touches FFI: the
/// factory seam keeps the real isolate-backed backend out of these tests.
class FakeSynthesizer implements SupertonicSynthesizer {
  FakeSynthesizer({this.samples, this.sampleRate = 44100, this.error});

  /// Float32 mono samples to return (defaults to empty).
  final Float32List? samples;

  /// Native sample rate reported alongside [samples].
  final int sampleRate;

  /// When set, [generate] throws this instead of returning samples.
  final Object? error;

  int generateCalls = 0;
  bool freed = false;

  @override
  Future<({Float32List samples, int sampleRate})> generate(String text) {
    generateCalls++;
    final e = error;
    if (e != null) throw e;
    return Future.value((samples: samples ?? Float32List(0), sampleRate: sampleRate));
  }

  @override
  void free() {
    freed = true;
  }
}

/// 1 s of a ±0.5 square wave at [rate] Hz — non-silent by construction.
Float32List squareWave({int rate = kSupertonic3SampleRate}) =>
    Float32List.fromList(
      List<double>.generate(rate, (i) => i.isEven ? 0.5 : -0.5),
    );

void main() {
  group('SupertonicTtsEngine', () {
    late Directory tempDir;
    late String modelDir;
    int factoryCalls = 0;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('supertonic_tts_test_');
      modelDir = '${tempDir.path}/supertonic_3';
      Directory(modelDir).createSync(recursive: true);
      factoryCalls = 0;
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    SupertonicTtsEngine engine({SupertonicSynthesizer? synthesizer}) {
      final fake = synthesizer ?? FakeSynthesizer(samples: squareWave());
      return SupertonicTtsEngine(
        modelDir: modelDir,
        synthesizerFactory: (_) {
          // Counts *backend constructions* (not engine constructions): this
          // proves the engine defers backend creation to the first utterance
          // and memoises it across utterances.
          factoryCalls++;
          return fake;
        },
      );
    }

    void writeModelFiles() {
      for (final name in const [
        'duration_predictor.int8.onnx',
        'text_encoder.int8.onnx',
        'vector_estimator.int8.onnx',
        'vocoder.int8.onnx',
        'tts.json',
        'unicode_indexer.bin',
        'voice.bin',
      ]) {
        File('$modelDir/$name').writeAsBytesSync([1, 2, 3]);
      }
    }

    test('hasModel is false until every artifact exists', () {
      final e = engine();
      expect(e.hasModel, isFalse);
      expect(e.name, 'supertonic_3');

      writeModelFiles();
      expect(e.hasModel, isTrue);
    });

    test('hasModel is false when a single artifact is missing', () {
      writeModelFiles();
      File('$modelDir/voice.bin').deleteSync();
      expect(engine().hasModel, isFalse);
    });

    test('throws EngineModelNotFoundError when artifacts are absent',
        () async {
      final e = engine();
      await expectLater(
        e.synthesize('Hello world', sampleRate: 16000),
        throwsA(isA<EngineModelNotFoundError>()),
      );
      // The backend must never be created for a missing model.
      expect(factoryCalls, 0);
    });

    test(
        'synthesize converts float32 → int16 (clamped) and resamples '
        '44100 → 16000', () async {
      writeModelFiles();
      final fake = FakeSynthesizer(samples: squareWave());
      final e = engine(synthesizer: fake);

      final pcm = await e.synthesize('Hello world', sampleRate: 16000);

      // 1 s at 44.1 kHz → exactly 1 s at 16 kHz.
      expect(pcm.length, 16000);
      expect(pcm.reduce((a, b) => a.abs() > b.abs() ? a : b).abs(),
          greaterThan(16000));
      expect(fake.generateCalls, 1);
    });

    test('passes float samples through at the native rate without resampling',
        () async {
      writeModelFiles();
      final e = engine(
        synthesizer: FakeSynthesizer(samples: Float32List.fromList([
          0.0, 0.5, -0.5, 1.0,
        ]), ),
      );

      final pcm = await e.synthesize('Hello', sampleRate: 44100);

      expect(pcm, [0, 16384, -16384, 32767]);
    });

    test('empty audio from the backend surfaces as EngineInferenceError',
        () async {
      writeModelFiles();
      final e = engine(synthesizer: FakeSynthesizer(samples: Float32List(0)));
      await expectLater(
        e.synthesize('Hello', sampleRate: 16000),
        throwsA(isA<EngineInferenceError>()),
      );
    });

    test('propagates EngineError subtypes from a failing backend', () async {
      writeModelFiles();
      final e = engine(
        synthesizer: FakeSynthesizer(error: const EngineInferenceError('boom')),
      );
      await expectLater(
        e.synthesize('Hello', sampleRate: 16000),
        throwsA(isA<EngineInferenceError>()),
      );
    });

    test('maps raw backend exceptions to EngineInferenceError', () async {
      writeModelFiles();
      final e = engine(synthesizer: FakeSynthesizer(error: Exception('ffi blew up')));
      await expectLater(
        e.synthesize('Hello', sampleRate: 16000),
        throwsA(
          isA<EngineInferenceError>()
              .having((err) => err.message, 'message', contains('ffi blew up')),
        ),
      );
    });

    test('synthesizer is memoised across utterances', () async {
      writeModelFiles();
      final fake = FakeSynthesizer(samples: squareWave());
      final e = engine(synthesizer: fake);

      await e.synthesize('one', sampleRate: 16000);
      await e.synthesize('two', sampleRate: 16000);

      expect(fake.generateCalls, 2);
      expect(factoryCalls, 1);
    });

    test('dispose frees the synthesizer', () async {
      writeModelFiles();
      final fake = FakeSynthesizer(samples: squareWave());
      final e = engine(synthesizer: fake);

      await e.synthesize('Hello', sampleRate: 16000);
      expect(fake.freed, isFalse);
      e.dispose();
      expect(fake.freed, isTrue);
      e.dispose(); // idempotent
      expect(fake.freed, isTrue);
    });
  });

  group('resamplePcm16', () {
    test('same rate passes through and converts to int16', () {
      final out = resamplePcm16(
        [0.0, 0.5, -0.5, 1.0],
        inputRate: 44100,
        outputRate: 44100,
      );
      expect(out, [0, 16384, -16384, 32767]);
    });

    test('empty input yields empty output', () {
      expect(
        resamplePcm16(const [], inputRate: 44100, outputRate: 16000),
        isEmpty,
      );
    });

    test('clamps samples outside the int16 range', () {
      final out = resamplePcm16(
        [2.0, -2.0],
        inputRate: 44100,
        outputRate: 44100,
      );
      expect(out, [32767, -32768]);
    });

    test('downsamples 44.1k → 16k to the expected length', () {
      // 44100 samples at 44.1 kHz = 1 s → 16000 samples at 16 kHz.
      final input = List<double>.filled(44100, 0.5);
      final out = resamplePcm16(input, inputRate: 44100, outputRate: 16000);
      expect(out.length, 16000);
      expect(out.every((s) => s == 16384), isTrue);
    });
  });
}
