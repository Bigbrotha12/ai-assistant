import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:whisper_kit/whisper_kit.dart';

import '../engine_errors.dart';
import '../engine_config.dart';
import '../stt_engine.dart';
import '../wav_util.dart';

/// Creates a [WhisperTranscriber] for the directory containing the model file.
///
/// Injecting this factory lets tests substitute a fake transcriber so the
/// engine's *lifetime* behaviour can be verified without loading the real
/// whisper native model.
typedef WhisperTranscriberFactory = WhisperTranscriber Function(String modelDir);

/// A single, reusable transcription handle held by [WhisperSttEngine].
///
/// Operations on the handle are expected to be called sequentially by the
/// engine (which serialises access), so a handle must never be invoked
/// concurrently. It is created lazily on first use and kept warm for the
/// lifetime of the engine.
abstract interface class WhisperTranscriber {
  /// Number of times the underlying model instance was (re)created.
  ///
  /// For a warm engine this should stay `1`: the handle is instantiated once
  /// and reused for every subsequent utterance.
  int get modelInitCount;

  /// Transcribes the WAV file at [wavPath], returning the recognised text.
  Future<String> transcribe(String wavPath);
}

/// Self-hosted speech-to-text engine backed by whisper_kit.
///
/// Uses [WhisperModel.tiny] (English-only download, smallest footprint) and
/// keeps a **single persistent, warm engine instance** across turns: the
/// [Whisper] model handle is constructed once (lazily, on first use) and
/// reused for every subsequent utterance instead of being re-instantiated per
/// call.
///
/// whisper_kit 0.3.x expects `TranscribeRequest.audio` to be a **file path**
/// to a WAV on disk (the native side opens it with `drwav_init_file`); it does
/// not accept raw PCM or base64. The engine therefore writes the incoming
/// PCM16 samples to a temporary WAV file — in a background isolate, off the UI
/// thread — and passes that path. The temp file is deleted after inference.
///
/// [modelPath] must point to the `ggml-tiny.bin` model file. whisper_kit
/// resolves the actual model file from the directory containing [modelPath]
/// (`<dir>/ggml-tiny.bin`), so the downloaded model must be named accordingly.
///
/// ## Native-layer limitation (known follow-up)
///
/// whisper_kit 0.3.1's `Whisper.transcribe()` internally spawns a fresh
/// `Isolate.run` per call and its native `request()` re-initialises the
/// whisper context from the model file on every request (the native main.cpp
/// only exports `request` and `whisper_kit_free`). A genuinely zero-reload
/// native model therefore requires patching whisper_kit's native main.cpp to
/// hold the `whisper_context*` across requests — **out of scope here**. What
/// this engine achieves is the Dart-side warm path: one [Whisper] handle is
/// constructed and reused, eliminating per-utterance Dart re-instantiation and
/// the `_initModel()` file re-check (observable via [modelInitCount]). The
/// native context reload persists until whisper_kit is patched.
class WhisperSttEngine implements SttEngine {
  /// Creates a Whisper STT engine.
  ///
  /// [modelPath] must point to a valid `ggml-*.bin` model file on disk.
  ///
  /// [transcriberFactory] is injectable for tests; it defaults to a real
  /// whisper-backed handle.
  WhisperSttEngine({
    required this.modelPath,
    WhisperTranscriberFactory? transcriberFactory,
  }) : _transcriberFactory =
            transcriberFactory ?? _nativeTranscriberFactory;

  @override
  final String name = EngineConfig.whisperTinyId;

  /// Path to the Whisper ggml model file.
  final String modelPath;

  final WhisperTranscriberFactory _transcriberFactory;

  /// Lazily-created warm handle; `null` until first use.
  WhisperTranscriber? _transcriber;

  /// Whether the model file-existence check has already run (memoised so the
  /// per-turn path does not re-stat the file).
  bool _modelChecked = false;

  /// Serialisation tail: every [transcribe] is chained onto this so concurrent
  /// calls queue rather than corrupt the shared warm handle.
  Future<void> _tail = Future.value();

  int _transcribeCount = 0;

  Duration? _lastTranscribeDuration;

  /// Number of times the underlying model instance was (re)created.
  ///
  /// For a warm engine this stays `1` regardless of how many utterances have
  /// been transcribed. `0` until the first [transcribe] call.
  int get modelInitCount => _transcriber?.modelInitCount ?? 0;

  /// Total number of [transcribe] calls the engine has accepted.
  int get transcribeCount => _transcribeCount;

  /// Duration of the most recently completed [transcribe], or `null` before
  /// the first call completes.
  Duration? get lastTranscribeDuration => _lastTranscribeDuration;

  /// Sync (enclosing isolate) check that the model file exists.
  bool get hasModel => File(modelPath).existsSync();

  @override
  Future<String> transcribe(
    List<int> pcm16bit, {
    required int sampleRate,
  }) {
    return _runSerialized(() => _transcribeSerialized(pcm16bit, sampleRate));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /// Serialises [action] onto [_tail] so concurrent callers queue.
  Future<T> _runSerialized<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    // Swallow errors on the tail so one failed turn never wedges the chain.
    _tail = result.then((_) {}, onError: (_) {});
    return result;
  }

  Future<String> _transcribeSerialized(
    List<int> pcm16bit,
    int sampleRate,
  ) async {
    final stopwatch = Stopwatch()..start();
    try {
      _ensureWarmHandle();

      // Build the WAV and write it to a temp file in a background isolate so
      // the UI thread never touches the (potentially large) buffer. Only the
      // sendable samples/sample-rate are captured here — the warm handle stays
      // in the enclosing isolate (whisper_kit's transcribe spawns its own
      // isolate internally, so the Whisper object is never sent).
      final wavPath = await Isolate.run<String>(() async {
        final wavBytes = pcm16ToWav(pcm16bit, sampleRate: sampleRate);
        final file = File(
          '${Directory.systemTemp.path}'
          '/whisper_${DateTime.now().microsecondsSinceEpoch}_$pid.wav',
        );
        await file.writeAsBytes(wavBytes, flush: true);
        return file.path;
      });

      try {
        final text = await _transcriber!.transcribe(wavPath);
        return text.trim();
      } catch (e) {
        throw EngineInferenceError('Whisper inference failed: $e');
      } finally {
        // Best-effort cleanup: whisper.cpp has finished reading the file once
        // transcribe returns, so the temp WAV can go.
        try {
          final file = File(wavPath);
          if (await file.exists()) {
            await file.delete();
          }
        } catch (_) {
          // Temp file cleanup must never mask the transcription result.
        }
      }
    } on EngineError {
      rethrow;
    } finally {
      _transcribeCount++;
      _lastTranscribeDuration = stopwatch.elapsed;
      if (kDebugMode) {
        debugPrint(
          'WhisperSttEngine: turn #$_transcribeCount done '
          'in ${stopwatch.elapsedMilliseconds}ms '
          '(modelInitCount=$modelInitCount)',
        );
      }
    }
  }

  /// Memoises the model file-existence check, then lazily creates the single
  /// warm handle on first use.
  void _ensureWarmHandle() {
    if (!_modelChecked) {
      if (!hasModel) {
        throw const EngineModelNotFoundError();
      }
      _modelChecked = true;
    }
    _transcriber ??= _transcriberFactory(File(modelPath).parent.path);
  }
}

/// Builds a real whisper-backed [WhisperTranscriber] for [modelDir].
WhisperTranscriber _nativeTranscriberFactory(String modelDir) =>
    _NativeWhisperTranscriber(modelDir);

/// Real whisper-backed handle: holds a single [Whisper] and reuses it.
class _NativeWhisperTranscriber implements WhisperTranscriber {
  _NativeWhisperTranscriber(this._modelDir);

  final String _modelDir;
  Whisper? _whisper;
  int _modelInitCount = 0;

  @override
  int get modelInitCount => _modelInitCount;

  @override
  Future<String> transcribe(String wavPath) {
    // Construct the shared Whisper handle once and keep it warm. whisper_kit
    // re-runs its native context init per request internally (see class docs),
    // but on the Dart side the handle — and its _initModel() file check — are
    // now reused rather than rebuilt per utterance.
    if (_whisper == null) {
      _whisper = Whisper(
        model: WhisperModel.tiny,
        modelDir: _modelDir,
      );
      _modelInitCount++;
    }

    return _whisper!
        .transcribe(
          transcribeRequest: TranscribeRequest(
            audio: wavPath,
            language: 'en',
            isNoTimestamps: true,
            threads: 1,
          ),
        )
        .then((result) => result.text);
  }
}
