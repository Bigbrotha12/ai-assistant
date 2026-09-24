import 'dart:io';

import 'package:ai_assistant/features/voice/data/engine_errors.dart';
import 'package:ai_assistant/features/voice/data/engine_config.dart';
import 'package:ai_assistant/features/voice/data/engines/whisper_stt_engine.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fake [WhisperTranscriber] that never touches the native model.
///
/// Records how many times a model instance would have been (re)created, counts
/// how many callers are in flight at once (to verify serialisation), and lets
/// the test swap the canned result / inject errors.
class _FakeTranscriber implements WhisperTranscriber {
  final int _created = 1;
  int _active = 0;
  int _maxActive = 0;

  /// The recognition to return for each `transcribe` call.
  String result = 'hello world';

  /// Language argument of every `transcribe` call, in order.
  final List<String> languages = [];

  /// Set to throw inside `transcribe` to exercise the inference-error path.
  Object? error;

  @override
  int get modelInitCount => _created;

  @override
  Future<String> transcribe(String wavPath, {required String language}) async {
    languages.add(language);
    _active++;
    if (_active > _maxActive) _maxActive = _active;
    // Let the scheduler interleave so concurrent callers genuinely overlap.
    await Future<void>.delayed(const Duration(milliseconds: 5));
    _active--;
    if (error != null) throw error!;
    return result;
  }

  /// Non-zero when `transcribe` ever ran with >1 caller in flight. A correct
  /// engine serialises these, so this must stay `0`.
  int get maxActiveInFlight => _maxActive;
}

void main() {
  group('WhisperSttEngine warm handle reuse', () {
    test('name is the configured whisper id', () {
      final engine = WhisperSttEngine(modelPath: '/nonexistent/ggml-tiny.bin');
      expect(engine.name, EngineConfig.whisperTinyId);
    });

    test('reuses one handle across consecutive turns (no per-utterance init)',
        () async {
      final fake = _FakeTranscriber();
      final dir = await _tempModelFile();
      final engine = WhisperSttEngine(
        modelPath: '${dir.path}/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
      );

      fake.result = 'first turn';
      final r1 = await engine.transcribe(<int>[1, 2, 3], sampleRate: 16000);
      fake.result = 'second turn';
      final r2 = await engine.transcribe(<int>[4, 5], sampleRate: 16000);
      fake.result = 'third turn';
      final r3 = await engine.transcribe(<int>[6], sampleRate: 16000);

      expect(r1, 'first turn');
      expect(r2, 'second turn');
      expect(r3, 'third turn');

      // The engine must have created exactly one handle and kept it warm.
      expect(engine.modelInitCount, 1);
      expect(fake.modelInitCount, 1);

      // Every call counted.
      expect(engine.transcribeCount, 3);
      expect(engine.lastTranscribeDuration, isNotNull);

      _cleanup(dir);
    });

    test('serialises concurrent transcribe calls through the shared handle',
        () async {
      final fake = _FakeTranscriber();
      final dir = await _tempModelFile();
      final engine = WhisperSttEngine(
        modelPath: '${dir.path}/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
      );

      final results = await Future.wait<String>([
        engine.transcribe(<int>[1], sampleRate: 16000),
        engine.transcribe(<int>[2], sampleRate: 16000),
        engine.transcribe(<int>[3], sampleRate: 16000),
        engine.transcribe(<int>[4], sampleRate: 16000),
      ]);

      expect(results, const <String>[
        'hello world',
        'hello world',
        'hello world',
        'hello world',
      ]);
      expect(engine.modelInitCount, 1);
      expect(fake.maxActiveInFlight, 1,
          reason: 'concurrent transcribe calls must be serialised, not overlap');
      expect(engine.transcribeCount, 4);

      _cleanup(dir);
    });

    test('missing model throws EngineModelNotFoundError (memoised, once)',
        () async {
      final fake = _FakeTranscriber();
      final engine = WhisperSttEngine(
        modelPath: '/definitely/not/here/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
      );

      await expectLater(
        engine.transcribe(<int>[1], sampleRate: 16000),
        throwsA(isA<EngineModelNotFoundError>()),
      );
      await expectLater(
        engine.transcribe(<int>[1], sampleRate: 16000),
        throwsA(isA<EngineModelNotFoundError>()),
      );

      // Handle never created for a missing model.
      expect(engine.modelInitCount, 0);
      expect(engine.transcribeCount, 2);
    });

    test('wraps transcriber failures in EngineInferenceError', () async {
      final fake = _FakeTranscriber()..error = StateError('boom');
      final dir = await _tempModelFile();
      final engine = WhisperSttEngine(
        modelPath: '${dir.path}/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
      );

      await expectLater(
        engine.transcribe(<int>[1], sampleRate: 16000),
        throwsA(isA<EngineInferenceError>()),
      );

      // A failed turn must not wedge the serialisation tail: the next call
      // still works.
      fake.error = null;
      final text = await engine.transcribe(<int>[2], sampleRate: 16000);
      expect(text, 'hello world');

      _cleanup(dir);
    });
  });

  group('WhisperSttEngine language support', () {
    test('declares a curated multilingual supportedLanguages set', () {
      final engine = WhisperSttEngine(modelPath: '/nonexistent/ggml-tiny.bin');
      final languages = engine.supportedLanguages;

      expect(languages, isNotEmpty);
      expect(languages.length, greaterThanOrEqualTo(10));
      expect(languages.length, lessThanOrEqualTo(15));

      final codes = languages.map((lang) => lang.code).toList();
      expect(codes.toSet(), hasLength(codes.length),
          reason: 'no duplicate codes');
      for (final code in codes) {
        expect(code, matches(RegExp(r'^[a-z]{2}$')), reason: 'ISO 639-1');
      }
      // Curated majors, including every code the old hardcoded list offered.
      expect(codes, containsAll(['en', 'es', 'fr', 'de', 'zh', 'ja']));

      for (final lang in languages) {
        expect(lang.label, isNotEmpty);
        expect(lang.label, isNot(lang.code),
            reason: 'labels must be human-readable, not raw codes');
      }
    });

    test('defaults the recognition language to en and threads it into STT',
        () async {
      final fake = _FakeTranscriber();
      final dir = await _tempModelFile();
      final engine = WhisperSttEngine(
        modelPath: '${dir.path}/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
      );

      expect(engine.preferredLanguage, 'en');
      await engine.transcribe(<int>[1], sampleRate: 16000);

      expect(fake.languages, ['en']);
      _cleanup(dir);
    });

    test('constructor language and setter are threaded into every STT call',
        () async {
      final fake = _FakeTranscriber();
      final dir = await _tempModelFile();
      final engine = WhisperSttEngine(
        modelPath: '${dir.path}/ggml-tiny.bin',
        transcriberFactory: (_) => fake,
        language: 'fr',
      );

      await engine.transcribe(<int>[1], sampleRate: 16000);
      engine.preferredLanguage = 'ja';
      await engine.transcribe(<int>[2], sampleRate: 16000);

      expect(engine.preferredLanguage, 'ja');
      expect(fake.languages, ['fr', 'ja']);
      _cleanup(dir);
    });
  });
}

/// Creates a throwaway temp directory with a fake `ggml-tiny.bin` marker file
/// so the engine's model-existence check passes.
Future<Directory> _tempModelFile() async {
  final dir = await Directory.systemTemp.createTemp('whisper_stt_test_');
  await File('${dir.path}/ggml-tiny.bin').writeAsString('fake model');
  return dir;
}

void _cleanup(Directory dir) {
  try {
    dir.deleteSync(recursive: true);
  } catch (_) {
    // Best effort in tests.
  }
}
