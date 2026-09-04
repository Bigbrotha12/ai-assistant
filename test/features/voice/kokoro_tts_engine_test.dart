import 'dart:io';
import 'dart:typed_data';

import 'package:ai_assistant/features/voice/engine_errors.dart';
import 'package:ai_assistant/features/voice/engines/kokoro_g2p.dart';
import 'package:ai_assistant/features/voice/engines/kokoro_onnx_session.dart';
import 'package:ai_assistant/features/voice/engines/kokoro_tokenizer.dart';
import 'package:ai_assistant/features/voice/engines/kokoro_tts_engine.dart';
import 'package:ai_assistant/features/voice/engines/kokoro_voices.dart';
import 'package:flutter_test/flutter_test.dart';

/// Pass-through G2P: returns the input verbatim so tests can drive the
/// tokenizer + ONNX pipeline with exact IPA phonemes (bypassing the heuristic
/// [KokoroG2P], which is exercised separately).
class _PassThroughG2P implements TextToPhonemes {
  @override
  String convert(String text) => text;

  @override
  Future<void> ensureLoaded() async {}
}

void main() {
  group('KokoroTokenizer', () {
    test('encodes the "hello world" IPA phonemes deterministically', () {
      // h ə ˈ l o ʊ (space) w ɜ ː l d
      const expectedContent = [
        50, 83, 156, 54, 57, 135, 16, 65, 87, 158, 54, 46,
      ];
      final tokens = KokoroTokenizer().encode('həˈloʊ wɜːld');
      expect(tokens, [0, ...expectedContent, 0]);
    });

    test('uses the built-in fallback vocab when none is injected', () {
      // A few known single-phoneme round-trips against the embedded map.
      expect(KokoroTokenizer().encode('a'), [0, 43, 0]);
      expect(KokoroTokenizer().encode('z'), [0, 68, 0]);
      expect(KokoroTokenizer().encode(' '), [0, 16, 0]);
    });

    test('skips unknown characters instead of failing', () {
      // 'θ' is in the vocab (119); the CJK char is not and is dropped.
      expect(KokoroTokenizer().encode('θ界e'), [0, 119, 47, 0]);
    });

    test('wraps content with leading and trailing pad token', () {
      final tokens = KokoroTokenizer().encode('h');
      expect(tokens.first, KokoroTokenizer.padTokenId);
      expect(tokens.last, KokoroTokenizer.padTokenId);
      expect(tokens.length, 3);
    });

    test('truncates content longer than the model context (maxTokens)', () {
      // 600 'a' phonemes → must be clamped to 510, then padded to 512.
      final tokens = KokoroTokenizer().encode(List.filled(600, 'a').join());
      expect(tokens.length, KokoroTokenizer.maxTokens + 2);
      expect(tokens.first, KokoroTokenizer.padTokenId);
      expect(tokens.last, KokoroTokenizer.padTokenId);
    });

    test('parses a data-driven vocab from tokenizer.json', () {
      const json = r'{"model": {"vocab": {"$": 0, "h": 50, "ə": 83}}}';
      final tokenizer = KokoroTokenizer.fromJson(json);
      expect(tokenizer.encode('hə'), [0, 50, 83, 0]);
    });

    test('fromJson rejects a malformed payload', () {
      expect(() => KokoroTokenizer.fromJson('42'), throwsFormatException);
      expect(() => KokoroTokenizer.fromJson('{"model": {}}'), throwsFormatException);
    });
  });

  group('KokoroG2P (heuristic)', () {
    final g2p = KokoroG2P();

    test('maps common consonant digraphs to their IPA', () {
      expect(g2p.convert('shake'), contains('ʃ'));
      expect(g2p.convert('change'), contains('ʧ'));
      expect(g2p.convert('phone'), contains('f'));
      final thisOutput = g2p.convert('this');
      expect(
        thisOutput.contains('θ') || thisOutput.contains('ð'),
        isTrue,
        reason: 'th should map to a dental fricative',
      );
    });

    test('maps long vowel digraphs', () {
      expect(g2p.convert('feel'), contains('iː'));
      expect(g2p.convert('moon'), contains('uː'));
      expect(g2p.convert('say'), contains('eɪ'));
      expect(g2p.convert('boat'), contains('oʊ'));
    });

    test('applies magic-e to lengthen the preceding vowel', () {
      // "make" → m + (è as long eɪ) + k
      expect(g2p.convert('make'), contains('eɪ'));
      expect(g2p.convert('like'), contains('aɪ'));
    });

    test('does not swallow a needed final vowel (the/he/be)', () {
      // "be": b + long e (iː), not a bare consonant.
      final be = g2p.convert('be');
      expect(be, contains('b'));
      expect(be.length, greaterThan(1));
      // "the": t+h (ð) + a vowel.
      final the = g2p.convert('the');
      expect(the.length, greaterThan(1));
    });

    test('joins words with a space (the space token)', () {
      expect(g2p.convert('hello world'), contains(' '));
    });

    test('is deterministic for the same input', () {
      expect(g2p.convert('Hello World'), g2p.convert('hello world'));
    });
  });

  group('G2P → token-id path', () {
    test('heuristic phonemes for "hello" tokenize to non-empty, padded ids',
        () {
      final phonemes = KokoroG2P().convert('hello');
      final ids = KokoroTokenizer().encode(phonemes);
      expect(ids.first, KokoroTokenizer.padTokenId);
      expect(ids.last, KokoroTokenizer.padTokenId);
      // All content ids resolve to known (non-pad) tokens.
      expect(ids.length, greaterThan(2));
    });
  });

  group('KokoroVoices', () {
    const dim = 256;

    Float32List validVoiceBytes(int rows) {
      final data = Float32List(rows * dim);
      for (var r = 0; r < rows; r++) {
        data[r * dim] = r.toDouble();
      }
      return data;
    }

    test('shapes bytes row-major into [rows, 1, dim]', () {
      final data = validVoiceBytes(8);
      final voices = KokoroVoices.fromBytes(data.buffer.asUint8List());
      expect(voices.rowCount, 8);
      expect(voices.dim, dim);
      expect(voices.styleFor(3), [3, ...List<double>.filled(dim - 1, 0.0)]);
    });

    test('rejects bytes not a whole multiple of the style dimension', () {
      final bad = Uint8List(dim * 4 + 1);
      expect(
        () => KokoroVoices.fromBytes(bad, dim: dim),
        throwsA(isA<EngineModelLoadError>()),
      );
    });

    test('styleFor throws when the token count exceeds the file rows', () {
      final voices = KokoroVoices.fromBytes(validVoiceBytes(4).buffer.asUint8List());
      expect(() => voices.styleFor(4), throwsA(isA<EngineModelLoadError>()));
      expect(() => voices.styleFor(100), throwsA(isA<EngineModelLoadError>()));
      // A valid in-range index still works.
      expect(voices.styleFor(3), [3, ...List<double>.filled(dim - 1, 0.0)]);
    });
  });

  group('resamplePcm16', () {
    test('same rate passes through and converts to int16', () {
      final out = resamplePcm16(
        [0.0, 0.5, -0.5, 1.0],
        inputRate: 24000,
        outputRate: 24000,
      );
      expect(out, [0, 16384, -16384, 32767]);
    });

    test('empty input yields empty output', () {
      expect(
        resamplePcm16(const [], inputRate: 24000, outputRate: 16000),
        isEmpty,
      );
    });

    test('clamps samples outside the int16 range', () {
      final out = resamplePcm16(
        [2.0, -2.0],
        inputRate: 24000,
        outputRate: 24000,
      );
      expect(out, [32767, -32768]);
    });

    test('downsamples 24k → 16k to a shorter output', () {
      // 24000 samples at 24 kHz = 1 s → 16000 samples at 16 kHz.
      final input = List<double>.filled(24000, 0.5);
      final out = resamplePcm16(input, inputRate: 24000, outputRate: 16000);
      expect(out.length, 16000);
      expect(out.every((s) => s == 16384), isTrue);
    });
  });

  group('KokoroTtsEngine', () {
    late Directory tempDir;
    late String modelPath;
    late String voicesPath;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('kokoro_tts_test_');
      modelPath = '${tempDir.path}/kokoro_82m.onnx';
      voicesPath = '${tempDir.path}/kokoro_82m_voices.bin';
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    void writeModel() => File(modelPath).writeAsBytesSync([1, 2, 3]);

    void writeVoices({int rows = 16}) {
      final data = Float32List(rows * 256);
      for (var r = 0; r < rows; r++) {
        data[r * 256] = r.toDouble();
      }
      File(voicesPath).writeAsBytesSync(data.buffer.asUint8List());
    }

    test('throws EngineModelNotFoundError when the model file is absent',
        () async {
      final engine = KokoroTtsEngine(modelPath: modelPath);
      expect(
        () => engine.synthesize('həˈloʊ wɜːld', sampleRate: 16000),
        throwsA(isA<EngineModelNotFoundError>()),
      );
    });

    test('throws EngineModelLoadError when voices artifact is missing',
        () async {
      writeModel();
      final engine = KokoroTtsEngine(modelPath: modelPath);
      expect(
        () => engine.synthesize('həˈloʊ', sampleRate: 16000),
        throwsA(isA<EngineModelLoadError>()),
      );
    });

    test('full pipeline: tokenizes, selects style, runs fake session, PCM16',
        () async {
      writeModel();
      writeVoices();

      final fake = FakeSession();
      final engine = KokoroTtsEngine(
        modelPath: modelPath,
        voicesPath: voicesPath,
        sessionFactory: (_) => fake,
        g2pFactory: _PassThroughG2P.new,
      );

      final pcm = await engine.synthesize('həˈloʊ wɜːld', sampleRate: 16000);

      // 1 s at 24 kHz → resampled to 16 kHz → 16000 PCM samples. Samples are
      // signed int16 and the non-silent square wave has audible non-zero peaks.
      expect(pcm.length, 16000);
      expect(pcm.reduce((a, b) => a.abs() > b.abs() ? a : b).abs(), greaterThan(16000));

      // Voice style index == content token count (12 for this utterance).
      final call = fake.capture;
      expect(call.ids, [0, 50, 83, 156, 54, 57, 135, 16, 65, 87, 158, 54, 46, 0]);
      expect(call.style[0], 12);
      expect(call.style.length, 256);
      expect(call.speed, [1.0]);
    });

    test('propagates EngineInferenceError from a failing session', () async {
      writeModel();
      writeVoices();
      final engine = KokoroTtsEngine(
        modelPath: modelPath,
        voicesPath: voicesPath,
        sessionFactory: (_) => FailingSession(),
        g2pFactory: _PassThroughG2P.new,
      );
      await expectLater(
        engine.synthesize('həˈloʊ', sampleRate: 16000),
        throwsA(isA<EngineInferenceError>()),
      );
    });

    test('empty audio from the session surfaces as EngineInferenceError',
        () async {
      writeModel();
      writeVoices();
      final engine = KokoroTtsEngine(
        modelPath: modelPath,
        voicesPath: voicesPath,
        sessionFactory: (_) => FakeSession(silent: true),
        g2pFactory: _PassThroughG2P.new,
      );
      await expectLater(
        engine.synthesize('həˈloʊ', sampleRate: 16000),
        throwsA(isA<EngineInferenceError>()),
      );
    });

    test(
        'synthesize runs the G2P (text → phonemes) before tokenizing and '
        'reaches the session with phoneme-derived ids', () async {
      writeModel();
      writeVoices();
      final fake = FakeSession();
      // A G2P that translates a known word "cat" to the IPA /kæt/.
      final engine = KokoroTtsEngine(
        modelPath: modelPath,
        voicesPath: voicesPath,
        sessionFactory: (_) => fake,
        g2pFactory: () => _FixedG2P('kæt'),
      );
      await engine.synthesize('anything', sampleRate: 16000);
      // /kæt/ → k(53) æ(72) t(62), wrapped in pads.
      final call = fake.capture;
      expect(call.ids, [0, 53, 72, 62, 0]);
      // style index == content token count (3).
      expect(call.style[0], 3);
    });
  });
}

/// G2P that ignores input and returns a fixed phoneme string.
class _FixedG2P implements TextToPhonemes {
  _FixedG2P(this.phonemes);
  final String phonemes;
  @override
  String convert(String text) => phonemes;

  @override
  Future<void> ensureLoaded() async {}
}

/// Records its call arguments so the engine's wiring can be asserted, and
/// returns a deterministic 1 s tone computed so resampling produces non-zero
/// PCM (an all-zeros output would read as silence and fail the non-zero
/// assertion otherwise).
class FakeSession implements KokoroOnnxSession {
  FakeSession({this.silent = false});

  final bool silent;

  ({List<int> ids, Float32List style, Float32List speed}) get capture =>
      (ids: _ids!, style: _style!, speed: _speed!);

  List<int>? _ids;
  Float32List? _style;
  Float32List? _speed;

  @override
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  }) async {
    _ids = inputIds;
    _style = style;
    _speed = speed;
    if (silent) return const [];
    // 1 s at 24 kHz of a ±0.5 square wave.
    return List<double>.generate(24000, (i) => i.isEven ? 0.5 : -0.5);
  }

  @override
  void release() {}
}

class FailingSession implements KokoroOnnxSession {
  @override
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  }) async {
    throw EngineInferenceError('boom');
  }

  @override
  void release() {}
}
