import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_onnxruntime/flutter_onnxruntime.dart';

import '../engine_errors.dart';

/// A thin, testable seam over the ONNX Runtime session used for Kokoro
/// synthesis.
///
/// [KokoroTtsEngine] depends on this abstraction (constructed via an injectable
/// [KokoroSessionFactory]) so unit tests can exercise the synthesis pipeline
/// with a fake backend instead of a real ~92 MB `.onnx` file.
abstract interface class KokoroOnnxSession {
  /// Runs inference and returns raw mono float audio at the model's native
  /// sample rate (24 kHz for Kokoro).
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  });

  /// Releases native resources held by the session.
  void release();
}

/// Returns a [KokoroOnnxSession] backed by the real ONNX Runtime plugin.
///
/// This is the production factory; tests inject their own.
typedef KokoroSessionFactory = KokoroOnnxSession Function(File modelFile);

/// Default production session factory backed by ONNX Runtime.
KokoroOnnxSession createKokoroOnnxSession(File modelFile) =>
    KokoroOnnxSessionImpl(modelFile);

/// Real ONNX Runtime-backed [KokoroOnnxSession].
///
/// Wraps an `OrtSession` created from [modelFile] via `flutter_onnxruntime`
/// (ONNX Runtime 1.23 native runtime behind a platform channel), resolves the
/// io node names generically from `session.inputNames` / `session.outputNames`,
/// feeds the typed tensors (with the correct dtypes — see critical notes
/// below) and flattens the float audio output.
///
/// ## ONNX dtype gotcha
///
/// `OrtValue.fromList` maps the Dart element type onto the ONNX dtype:
/// `Int64List` → **int64** (required for `input_ids`), `Float32List` →
/// **float32** (required for the `style`/`speed` inputs), while a plain
/// `List<num>` is auto-sniffed (float32/int32/int64) and must be avoided for
/// inputs whose dtype the graph fixes.
///
/// ## Resource lifecycle
///
/// Every allocated `OrtValue` (inputs + outputs) is disposed after the run so
/// native buffers are not leaked. `release()` closes the session; it is called
/// by the engine after each utterance (session-per-utterance lifecycle).
class KokoroOnnxSessionImpl implements KokoroOnnxSession {
  KokoroOnnxSessionImpl(this._modelFile);

  final File _modelFile;

  OrtSession? _session;
  Future<OrtSession>? _loading;
  bool _released = false;

  @override
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  }) async {
    final session = await _ensureSession();
    final names = _resolveNames(session);

    final inputIdsTensor = await OrtValue.fromList(
      Int64List.fromList(inputIds),
      [1, inputIds.length],
    );
    final styleTensor = await OrtValue.fromList(style, [1, style.length]);
    final speedTensor = await OrtValue.fromList(speed, [speed.length]);
    final inputs = <String, OrtValue>{
      names.inputIds: inputIdsTensor,
      names.style: styleTensor,
      names.speed: speedTensor,
    };

    Map<String, OrtValue> outputs = const {};
    try {
      outputs = await session.run(inputs);
      final audioValue = outputs[names.audioOutput] ??
          (outputs.isNotEmpty ? outputs.values.first : null);
      if (audioValue == null) {
        throw const EngineInferenceError(
          'Kokoro model did not return an audio output',
        );
      }
      final flat = await audioValue.asFlattenedList();
      return [for (final e in flat) (e as num).toDouble()];
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineInferenceError('Kokoro inference failed: $e');
    } finally {
      // Dispose every output OrtValue returned by the run (including the
      // audio tensor we read above) so their native buffers are freed.
      // Failing to dispose these is a per-utterance native memory leak.
      for (final v in outputs.values) {
        await v.dispose();
      }
      for (final v in inputs.values) {
        await v.dispose();
      }
    }
  }

  /// Resolves the logical `input_ids` / `style` / `speed` inputs and the audio
  /// output from the session's reported io node names, tolerating either the
  /// `onnx-community` naming (`input_ids`/`style`/`speed` → `audio`) or
  /// another export's naming (`tokens`/`ref_s`/… pattern).
  _ResolvedNames _resolveNames(OrtSession session) {
    final inputs = session.inputNames;
    final outputs = session.outputNames;

    String? findInput(Iterable<String> needles) {
      for (final n in inputs) {
        final lower = n.toLowerCase();
        if (needles.any(lower.contains)) return n;
      }
      return null;
    }

    final inputIds = findInput(const ['input_ids', 'input', 'tokens']) ??
        (inputs.isEmpty ? null : inputs.first);
    final style = findInput(const ['style', 'ref', 'voice', 'embedding']);
    final speed = findInput(const ['speed']);

    final audioOutput = outputs.isEmpty
        ? null
        : outputs.firstWhere(
            (o) {
              final lower = o.toLowerCase();
              return lower.contains('audio') || lower.contains('waveform');
            },
            orElse: () => outputs.first,
          );

    if (inputIds == null || style == null || speed == null || audioOutput == null) {
      throw EngineModelLoadError(
        'Kokoro ONNX graph io names could not be resolved. '
        'inputs=$inputs outputs=$outputs',
      );
    }

    return _ResolvedNames(
      inputIds: inputIds,
      style: style,
      speed: speed,
      audioOutput: audioOutput,
    );
  }

  /// Loads the session once; concurrent callers share the in-flight load.
  Future<OrtSession> _ensureSession() {
    final existing = _session;
    if (existing != null) return Future.value(existing);
    if (_released) {
      throw const EngineModelLoadError('Session was already released');
    }
    return _loading ??= _createSession();
  }

  Future<OrtSession> _createSession() async {
    try {
      final options = OrtSessionOptions(
        // On-device: CPU provider is always available; a single intra-op
        // thread keeps memory small and avoids oversubscription of the
        // device's cores during a single utterance.
        providers: const [OrtProvider.CPU],
        intraOpNumThreads: 1,
      );
      final session =
          await OnnxRuntime().createSession(_modelFile.path, options: options);
      if (_released) {
        // release() raced the load; tear the fresh session back down.
        await session.close();
        throw const EngineModelLoadError('Session was already released');
      }
      return _session = session;
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineModelLoadError('Failed to load Kokoro ONNX model: $e');
    } finally {
      _loading = null;
    }
  }

  @override
  void release() {
    if (_released) return;
    _released = true;
    final session = _session;
    _session = null;
    _loading = null;
    if (session != null) {
      // Fire-and-forget teardown: the engine only releases after a run has
      // fully settled, so the session is idle here.
      unawaited(session.close().onError((_, _) {}));
    }
  }
}

class _ResolvedNames {
  const _ResolvedNames({
    required this.inputIds,
    required this.style,
    required this.speed,
    required this.audioOutput,
  });
  final String inputIds;
  final String style;
  final String speed;
  final String audioOutput;
}

/// Resamples mono float audio from [inputRate] to [outputRate] using linear
/// interpolation, then converts the floats to 16-bit signed PCM.
///
/// [input] holds raw float samples in the range roughly `[-1, 1]`. Output is a
/// `List<int>` of int16 samples at [outputRate] Hz (mono), suitable for
/// `TtsEngine.synthesize`'s contract. Clamps to the int16 range.
List<int> resamplePcm16(
  List<double> input, {
  required int inputRate,
  required int outputRate,
}) {
  if (input.isEmpty) return const [];
  if (outputRate == inputRate) {
    return input.map(_floatToPcm16).toList(growable: false);
  }

  final ratio = inputRate / outputRate;
  final outLength = (input.length / ratio).ceil();
  final out = List<int>.filled(outLength, 0, growable: false);
  for (var i = 0; i < outLength; i++) {
    final srcPos = i * ratio;
    final lo = srcPos.floor();
    final hi = (lo + 1).clamp(0, input.length - 1);
    final frac = srcPos - lo;
    final sample =
        input[lo] * (1 - frac) + input[hi] * frac;
    out[i] = _floatToPcm16(sample);
  }
  return out;
}

/// Converts a float sample in the range `[-1, 1]` to a 16-bit signed integer,
/// clamped to the int16 range.
int _floatToPcm16(double sample) {
  final v = (sample * 32767).round();
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}
