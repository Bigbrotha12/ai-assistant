import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa_onnx;

import '../engine_config.dart';
import '../engine_errors.dart';
import '../pcm_resample.dart';
import '../tts_engine.dart';

/// The model's native sample rate (Hz). Supertonic 3 synthesises 44.1 kHz
/// mono audio.
const int kSupertonic3SampleRate = 44100;

/// Absolute paths of the seven Supertonic 3 artifacts inside the model
/// directory (`<appDocs>/.voice_models/supertonic_3/`).
///
/// Supertonic ships its own text processing (unicode indexer + `tts.json`
/// config), so no external G2P/tokenizer pipeline is needed — the runtime
/// consumes raw natural-language text.
class SupertonicModelPaths {
  const SupertonicModelPaths({required this.modelDir});

  /// Directory holding all model files (…/.voice_models/supertonic_3).
  final String modelDir;

  String get durationPredictor =>
      '$modelDir/${EngineConfig.supertonic3DurationPredictorFile}';
  String get textEncoder =>
      '$modelDir/${EngineConfig.supertonic3TextEncoderFile}';
  String get vectorEstimator =>
      '$modelDir/${EngineConfig.supertonic3VectorEstimatorFile}';
  String get vocoder => '$modelDir/${EngineConfig.supertonic3VocoderFile}';
  String get ttsJson => '$modelDir/${EngineConfig.supertonic3TtsJsonFile}';
  String get unicodeIndexer =>
      '$modelDir/${EngineConfig.supertonic3UnicodeIndexerFile}';
  String get voiceStyle => '$modelDir/${EngineConfig.supertonic3VoiceFile}';

  /// Every file that must exist for the model to be usable.
  List<String> get allFiles => [
        durationPredictor,
        textEncoder,
        vectorEstimator,
        vocoder,
        ttsJson,
        unicodeIndexer,
        voiceStyle,
      ];
}

/// Test seam over the native synthesis backend.
///
/// [SupertonicTtsEngine] depends on this abstraction (constructed via an
/// injectable [SupertonicSynthesizerFactory]) so unit tests can exercise the
/// synthesis pipeline with a fake returning canned samples instead of loading
/// the real ~145 MB artifact set or touching the FFI bindings.
abstract class SupertonicSynthesizer {
  /// Synthesises [text] into raw mono float samples in `[-1, 1]` at the
  /// model's native sample rate (44.1 kHz).
  Future<({Float32List samples, int sampleRate})> generate(String text);

  /// Releases native resources held by the backend (idempotent).
  void free();
}

/// Creates a [SupertonicSynthesizer] backed by the real sherpa-onnx runtime.
///
/// This is the production factory; tests inject their own.
typedef SupertonicSynthesizerFactory = SupertonicSynthesizer Function(
  SupertonicModelPaths paths,
);

SupertonicSynthesizer createSupertonicSynthesizer(SupertonicModelPaths paths) =>
    SupertonicIsolateSynthesizer(paths);

/// On-device text-to-speech engine for Supertonic 3 (int8) via sherpa-onnx.
///
/// Replaces the custom Kokoro-82M pipeline (G2P → tokenizer → ONNX → PCM)
/// with a single-text-processing engine: Supertonic consumes natural-language
/// text directly (its `tts.json` + `unicode_indexer.bin` handle text
/// normalisation and character→token mapping internally).
///
/// ```text
/// text (natural language)
///   → SupertonicSynthesizer (worker isolate, sherpa-onnx OfflineTts)
///   → float32 audio (44.1 kHz mono, [-1, 1])
///   → linear resample to the requested sampleRate
///   → 16-bit signed PCM (mono)
/// ```
///
/// ## Thread-safety
///
/// sherpa-onnx generation is a synchronous, blocking FFI call. The
/// [OfflineTts] instance therefore lives inside a dedicated long-lived worker
/// isolate (created lazily on the first utterance and kept alive — model load
/// takes seconds) created by [SupertonicIsolateSynthesizer]. The main isolate
/// only exchanges sendable messages (strings / typed data) with it.
///
/// ## Unverified-on-device assumptions
///
/// The artifact set, config block and generation options follow the official
/// sherpa-onnx Supertonic 3 int8 release (v1.13.7). The pipeline could not be
/// executed in this environment — validate audible output on the device.
class SupertonicTtsEngine implements TtsEngine {
  /// Creates a Supertonic 3 TTS engine.
  ///
  /// [modelDir] must be the directory holding the seven downloaded artifacts
  /// (see [EngineConfig.supertonic3ModelDir] for the canonical layout).
  ///
  /// [synthesizerFactory] is an injectable seam for tests; omit to use the
  /// real isolate-backed sherpa-onnx backend.
  SupertonicTtsEngine({
    required String modelDir,
    SupertonicSynthesizerFactory? synthesizerFactory,
  })  : _modelDir = modelDir,
        _paths = SupertonicModelPaths(modelDir: modelDir),
        _synthesizerFactory = synthesizerFactory ?? createSupertonicSynthesizer;

  @override
  final String name = EngineConfig.supertonic3Id;

  final String _modelDir;
  final SupertonicModelPaths _paths;
  final SupertonicSynthesizerFactory _synthesizerFactory;

  /// Memoised backend; created lazily so no isolate or model load happens
  /// before the first utterance.
  SupertonicSynthesizer? _synthesizer;

  /// Sync (enclosing isolate) check that every artifact file exists.
  bool get hasModel => _paths.allFiles.every((f) => File(f).existsSync());

  @override
  Future<List<int>> synthesize(String text, {required int sampleRate}) async {
    if (!hasModel) {
      throw EngineModelNotFoundError(
        'Supertonic 3 model files not found under $_modelDir; '
        'download them first.',
      );
    }

    try {
      final synthesizer = _synthesizer ??= _synthesizerFactory(_paths);
      final audio = await synthesizer.generate(text);
      if (audio.samples.isEmpty) {
        throw const EngineInferenceError(
          'Supertonic produced empty audio for this utterance.',
        );
      }

      // Defensive: a zero sample rate means the backend never reported one;
      // fall back to the model's documented native rate instead of dividing
      // by zero inside the resampler.
      final inputRate =
          audio.sampleRate > 0 ? audio.sampleRate : kSupertonic3SampleRate;
      return resamplePcm16(
        audio.samples,
        inputRate: inputRate,
        outputRate: sampleRate,
      );
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineInferenceError('Supertonic synthesis failed: $e');
    } on Object catch (e, stackTrace) {
      // Non-Exception throwables (e.g. TypeError from the disposed /
      // port-closed race) must also be wrapped so only EngineError escapes
      // the engine boundary. Genuine bugs are not blanket-swallowed: the
      // original error and stack are reported in debug builds.
      if (kDebugMode) {
        debugPrint('SupertonicTtsEngine: synthesis failed: $e\n$stackTrace');
      }
      throw EngineInferenceError('Supertonic synthesis failed: $e');
    }
  }

  /// Releases the native backend (if it was created). Idempotent.
  void dispose() {
    _synthesizer?.free();
    _synthesizer = null;
  }
}

// ---------------------------------------------------------------------------
// Worker-isolate backend
// ---------------------------------------------------------------------------

/// Messages main → worker. All payload types are sendable.
sealed class _WorkerRequest {
  const _WorkerRequest();
}

class _InitRequest extends _WorkerRequest {
  _InitRequest(this.paths);
  final SupertonicModelPaths paths;
}

class _GenerateRequest extends _WorkerRequest {
  _GenerateRequest(this.id, this.text);
  final int id;
  final String text;
}

class _DisposeRequest extends _WorkerRequest {
  const _DisposeRequest();
}

/// Acknowledges a [_DisposeRequest] once the native model was released.
class _DisposeAck extends _WorkerResponse {
  const _DisposeAck();
}

/// Messages worker → main.
sealed class _WorkerResponse {
  const _WorkerResponse();
}

class _WorkerReady extends _WorkerResponse {
  _WorkerReady(this.sampleRate);
  final int sampleRate;
}

class _WorkerAudio extends _WorkerResponse {
  _WorkerAudio({required this.id, required this.samples, required this.sampleRate});
  final int id;
  final Float32List samples;
  final int sampleRate;
}

class _WorkerError extends _WorkerResponse {
  _WorkerError({required this.id, required this.message});

  /// Request id the error belongs to, or `null` for an init failure.
  final int? id;
  final String message;
}

/// Real [SupertonicSynthesizer] backed by sherpa-onnx in a dedicated
/// long-lived worker isolate.
///
/// The isolate is spawned lazily on the first [generate] call and kept alive
/// for the synthesizer's lifetime: the model load takes seconds, so re-creating
/// it per utterance would dominate synthesis time. [free] tears it down.
///
/// Per the sherpa-onnx isolate contract, [sherpa_onnx.initBindings] is called
/// inside the worker isolate (each isolate owns its FFI binding state); the
/// main isolate never touches the sherpa-onnx API.
class SupertonicIsolateSynthesizer implements SupertonicSynthesizer {
  SupertonicIsolateSynthesizer(this._paths);

  final SupertonicModelPaths _paths;

  Isolate? _isolate;
  SendPort? _sendPort;
  ReceivePort? _responses;
  ReceivePort? _errors;
  Future<void>? _starting;
  final Completer<void> _ready = Completer<void>();

  /// Completed by the worker after it released the native model in response
  /// to a [_DisposeRequest] (see [free]).
  final Completer<void> _disposeAck = Completer<void>();
  final Map<int, Completer<({Float32List samples, int sampleRate})>> _pending =
      {};
  int _nextId = 0;
  bool _disposed = false;

  @override
  Future<({Float32List samples, int sampleRate})> generate(String text) async {
    await _ensureStarted();
    // free() may have raced the boot: re-check so the send below always hits
    // a live port instead of orphaning the request (whose completer would
    // otherwise never complete and hang the caller).
    if (_disposed || _sendPort == null) {
      throw const EngineModelLoadError('engine disposed');
    }
    final id = _nextId++;
    final completer =
        Completer<({Float32List samples, int sampleRate})>();
    _pending[id] = completer;
    _sendPort!.send(_GenerateRequest(id, text));
    return completer.future;
  }

  @override
  void free() {
    if (_disposed) return;
    _disposed = true;
    // Outstanding requests must never hang: fail them before the isolate dies.
    for (final completer in _pending.values) {
      completer.completeError(
        const EngineInferenceError('Supertonic synthesizer was disposed'),
      );
    }
    _pending.clear();
    // A torn-down worker can never become ready; complete the boot future
    // normally (no awaiter-failure surprise) — in-flight generate calls fail
    // through their request completers above.
    if (!_ready.isCompleted) _ready.complete();
    final port = _sendPort;
    _sendPort = null;
    if (port == null) {
      // Never started (or a failed boot already reset everything): nothing
      // to release cooperatively.
      _closePorts();
      return;
    }
    // Cooperative teardown: the worker must release the native model BEFORE
    // the isolate is killed. `Isolate.kill(immediate)` would skip the queued
    // dispose message entirely and leak the ~145 MB model — sherpa-onnx
    // OfflineTts has no Dart finalizer. The kill is only a fallback for a
    // wedged worker (e.g. stuck in a blocking generate call).
    unawaited(_teardownWorker(port));
  }

  /// Waits (bounded) for the worker's dispose ack, then kills the isolate
  /// regardless so the teardown can never hang the app. Idempotency is
  /// guaranteed by [free]'s `_disposed` flag.
  Future<void> _teardownWorker(SendPort port) async {
    try {
      port.send(const _DisposeRequest());
    } catch (_) {
      // The isolate may already be gone; the kill below is best-effort anyway.
    }
    try {
      await _disposeAck.future.timeout(const Duration(seconds: 2));
    } on Object {
      // Ack timeout or a closed transport — fall through and kill the
      // isolate as the last resort (best-effort native release was missed).
    }
    _closePorts();
    _isolate?.kill(priority: Isolate.immediate);
    _isolate = null;
  }

  void _closePorts() {
    _responses?.close();
    _responses = null;
    _errors?.close();
    _errors = null;
  }

  /// Boots the worker isolate once; concurrent callers share the in-flight
  /// start. Throws [EngineModelLoadError] when the model fails to load.
  Future<void> _ensureStarted() {
    if (_disposed) {
      throw const EngineModelLoadError('Supertonic synthesizer was disposed');
    }
    return _starting ??= _start();
  }

  Future<void> _start() async {
    final responses = ReceivePort();
    _responses = responses;
    responses.listen(_onResponse);
    // Uncaught worker errors (outside the request handlers, which already
    // report via _WorkerError) must fail the boot / pending requests instead
    // of leaving callers awaiting forever.
    final errors = ReceivePort();
    _errors = errors;
    errors.listen((message) {
      final description =
          message is List && message.isNotEmpty ? '$message' : 'unknown';
      _failAll(
        'Supertonic worker isolate crashed: $description',
        // A crash is an inference-time infrastructure failure, not a model
        // file problem — keep EngineModelLoadError for load failures only.
        const EngineInferenceError('Supertonic worker isolate crashed'),
      );
    });
    final Isolate isolate;
    try {
      isolate = await Isolate.spawn(
        _isolateMain,
        responses.sendPort,
        onError: errors.sendPort,
      );
    } catch (e) {
      // Boot failed: clear the memoised start so the next generate() can
      // reboot instead of replaying this failure forever.
      _starting = null;
      responses.close();
      errors.close();
      _responses = null;
      _errors = null;
      throw EngineModelLoadError(
        'Failed to start the Supertonic worker isolate: $e',
      );
    }
    if (_disposed) {
      // free() raced the spawn: tear the fresh isolate down instead of
      // leaking it (the worker never loaded the model yet).
      isolate.kill(priority: Isolate.immediate);
      responses.close();
      errors.close();
      _responses = null;
      _errors = null;
      return;
    }
    _isolate = isolate;
    // _isolateMain answers with its request port; we then send the init
    // request from _onResponse.
    return _ready.future;
  }

  /// Fails the boot future (if still pending) and every in-flight request.
  void _failAll(String logMessage, EngineError error) {
    if (kDebugMode) {
      debugPrint('SupertonicIsolateSynthesizer: $logMessage');
    }
    if (!_ready.isCompleted) _ready.completeError(error);
    for (final completer in _pending.values) {
      completer.completeError(error);
    }
    _pending.clear();
    _resetAfterFailure();
  }

  /// Tears the crashed/failed worker down and clears the memoised start so
  /// the next generate() boots a fresh isolate instead of hitting the dead
  /// one (or replaying a memoised failed boot forever).
  void _resetAfterFailure() {
    _starting = null;
    _isolate?.kill(priority: Isolate.immediate);
    _isolate = null;
    _sendPort = null;
    _closePorts();
  }

  void _onResponse(Object? message) {
    switch (message) {
      case final SendPort port:
        // First message: the worker's request port. Send the model paths to
        // trigger the (blocking) load inside the worker.
        _sendPort = port;
        port.send(_InitRequest(_paths));
      case _WorkerReady():
        _ready.complete();
      case _WorkerAudio(:final id, :final samples, :final sampleRate):
        _pending.remove(id)?.complete((samples: samples, sampleRate: sampleRate));
      case _WorkerError(:final id, :final message):
        if (!_ready.isCompleted) {
          // Boot-stage failure: the model could not be loaded (missing or
          // invalid artifacts). Reset the boot state so the next utterance
          // can start a fresh worker instead of replaying this failure.
          _ready.completeError(EngineModelLoadError(message));
          _resetAfterFailure();
        } else if (id != null) {
          _pending.remove(id)
              ?.completeError(EngineInferenceError(message));
        }
        // An error after ready with an unknown id is a protocol violation;
        // there is nothing safe to complete — drop it (logged in debug).
        else if (kDebugMode) {
          debugPrint('SupertonicIsolateSynthesizer: orphan error: $message');
        }
      case _DisposeAck():
        // The worker released the native model; the pending teardown in
        // _teardownWorker can now proceed (kill / close ports).
        if (!_disposeAck.isCompleted) _disposeAck.complete();
    }
  }
}

/// Worker isolate entry point. Must be a top-level function.
///
/// Loads the FFI bindings and the model, then serves generate/dispose
/// requests. Every failure is reported as a `_WorkerError` (strings cross
/// isolate boundaries cleanly; typed exceptions do not).
Future<void> _isolateMain(SendPort mainPort) async {
  final port = ReceivePort();
  mainPort.send(port.sendPort);

  sherpa_onnx.OfflineTts? tts;

  port.listen((message) {
    switch (message) {
      case _InitRequest(:final paths):
        try {
          // IMPORTANT: sherpa-onnx must be initialised in every isolate that
          // calls its Dart API. This is the only such isolate.
          sherpa_onnx.initBindings();
          tts = _createTts(paths);
          mainPort.send(_WorkerReady(tts!.sampleRate));
        } catch (e) {
          mainPort.send(
            _WorkerError(id: null, message: 'Failed to load the Supertonic 3 '
                'model: $e'),
          );
        }
      case _GenerateRequest(:final id, :final text):
        try {
          final engine = tts;
          if (engine == null) {
            throw StateError('Supertonic TTS engine is not initialised');
          }
          // Supertonic options (per the official int8 release):
          //   sid 0-9   — voice.bin ships 10 speakers; sid 0 is the default
          //   numSteps  — flow-matching steps (8 = release default)
          //   lang 'en' — text language carried via the extra payload
          //   speed     — duration-predictor scale; <1.0 restores the tail that
          //               the predictor under-estimates for symbol-heavy text
          final audio = engine.generateWithConfig(
            text: text,
            config: const sherpa_onnx.OfflineTtsGenerationConfig(
              sid: 0,
              numSteps: 8,
              speed: 0.9,
              extra: {'lang': 'en'},
            ),
          );
          mainPort.send(
            _WorkerAudio(
              id: id,
              samples: audio.samples,
              sampleRate: audio.sampleRate,
            ),
          );
        } catch (e) {
          mainPort.send(
            _WorkerError(id: id, message: 'Supertonic generation failed: $e'),
          );
        }
      case _DisposeRequest():
        // Cooperative teardown: release the native model BEFORE the main
        // isolate kills this one — `Isolate.kill(immediate)` skips queued
        // messages entirely, and sherpa-onnx OfflineTts has no finalizer, so
        // an unacknowledged kill would leak the model (~145 MB).
        tts?.free();
        tts = null;
        mainPort.send(const _DisposeAck());
        port.close();
    }
  });
}

/// Builds the sherpa-onnx config for the Supertonic 3 int8 artifact set.
sherpa_onnx.OfflineTts _createTts(SupertonicModelPaths paths) {
  final config = sherpa_onnx.OfflineTtsConfig(
    model: sherpa_onnx.OfflineTtsModelConfig(
      supertonic: sherpa_onnx.OfflineTtsSupertonicModelConfig(
        durationPredictor: paths.durationPredictor,
        textEncoder: paths.textEncoder,
        vectorEstimator: paths.vectorEstimator,
        vocoder: paths.vocoder,
        ttsJson: paths.ttsJson,
        unicodeIndexer: paths.unicodeIndexer,
        voiceStyle: paths.voiceStyle,
      ),
      numThreads: 2,
      debug: false,
      provider: 'cpu',
    ),
  );
  return sherpa_onnx.OfflineTts(config);
}
