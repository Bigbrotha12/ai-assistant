import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:onnxruntime/onnxruntime.dart';

import '../engine_errors.dart';

/// A thin, testable seam over the onnxruntime session used for Kokoro
/// synthesis.
///
/// [KokoroTtsEngine] depends on this abstraction (constructed via an injectable
/// [KokoroSessionFactory]) so unit tests can exercise the synthesis pipeline
/// with a fake backend instead of a real ~92 MB `.onnx` file.
abstract interface class KokoroOnnxSession {
  /// Input node names as reported by the loaded graph.
  ///
  /// Used to resolve the actual ONNX io node names generically (e.g. the
  /// `onnx-community` export names them `input_ids`, `style`, `speed`).
  List<String> get inputNames;

  /// Output node names as reported by the loaded graph.
  List<String> get outputNames;

  /// Runs inference and returns raw mono float audio at the model's native
  /// sample rate (24 kHz for Kokoro).
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  });

  /// Releases native/FFI resources held by the session.
  void release();
}

/// Returns a [KokoroOnnxSession] backed by the real onnxruntime plugin.
///
/// This is the production factory; tests inject their own.
typedef KokoroSessionFactory = KokoroOnnxSession Function(File modelFile);

/// Default production session factory backed by onnxruntime.
KokoroOnnxSession createKokoroOnnxSession(File modelFile) =>
    KokoroOnnxSessionImpl(modelFile);

/// Real onnxruntime-backed [KokoroOnnxSession].
///
/// Wraps an [OrtSession] created from [modelFile], resolves the io node names
/// generically from `session.inputNames` / `session.outputNames`, feeds the
/// typed tensors (with the correct dtypes — see critical notes below) and
/// flattens the float audio output.
///
/// ## ONNX dtype gotcha
///
/// `OrtValueTensor.createTensorWithDataList` infers the ONNX dtype from the
/// Dart element type: a plain `List<int>` maps to **int64** (correct for
/// `input_ids`), but a plain `List<double>` maps to **float64** (wrong for
/// the `style`/`speed` float32 inputs). Those must be passed as `Float32List`.
///
/// ## Resource lifecycle
///
/// Every allocated `OrtValue` (inputs + outputs) and the `OrtRunOptions` are
/// released after the run so FFI buffers are not leaked.
class KokoroOnnxSessionImpl implements KokoroOnnxSession {
  KokoroOnnxSessionImpl(this._modelFile);

  final File _modelFile;

  OrtSession? _session;
  bool _released = false;

  @override
  List<String> get inputNames {
    final s = _ensureSession();
    return s.inputNames;
  }

  @override
  List<String> get outputNames {
    final s = _ensureSession();
    return s.outputNames;
  }

  OrtSession _ensureSession() {
    if (_session != null) return _session!;
    if (_released) {
      throw const EngineModelLoadError('Session was already released');
    }
    try {
      final options = OrtSessionOptions();
      try {
        // On-device: CPU provider is always available; a single intra-op
        // thread keeps memory small and avoids oversubscription of the
        // device's cores during a single utterance.
        options.appendCPUProvider(CPUFlags.useNone);
        options.setIntraOpNumThreads(1);
        _session = OrtSession.fromFile(_modelFile, options);
      } finally {
        options.release();
      }
      return _session!;
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineModelLoadError('Failed to load Kokoro ONNX model: $e');
    }
  }

  @override
  Future<List<double>> run({
    required List<int> inputIds,
    required Float32List style,
    required Float32List speed,
  }) async {
    final session = _ensureSession();
    final names = _resolveNames(session);

    final inputIdsTensor = OrtValueTensor.createTensorWithDataList(
      inputIds,
      [1, inputIds.length],
    );
    final styleTensor = OrtValueTensor.createTensorWithDataList(
      style,
      [1, style.length],
    );
    final speedTensor =
        OrtValueTensor.createTensorWithDataList(speed, [speed.length]);
    final inputs = <String, OrtValue>{
      names.inputIds: inputIdsTensor,
      names.style: styleTensor,
      names.speed: speedTensor,
    };

    final runOptions = OrtRunOptions();
    List<OrtValue?>? outputs;
    try {
      final out = await session.runAsync(runOptions, inputs, [
        names.audioOutput,
      ]);
      outputs = out ?? const [];
      final audioValue = outputs.isNotEmpty ? outputs.first : null;
      if (audioValue is! OrtValueTensor) {
        throw const EngineInferenceError(
          'Kokoro model did not return a tensor audio output',
        );
      }
      final dynamic value = audioValue.value;
      return _flattenDoubles(value);
    } on EngineError {
      rethrow;
    } on Exception catch (e) {
      throw EngineInferenceError('Kokoro inference failed: $e');
    } finally {
      // Release every output OrtValue returned by the run (including the
      // audio tensor we read above) so their native/FFI buffers are freed.
      // Failing to release these is a per-utterance native memory leak.
      if (outputs != null) {
        for (final v in outputs) {
          v?.release();
        }
      }
      for (final v in inputs.values) {
        v.release();
      }
      runOptions.release();
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

  /// Recursively flattens a nested tensor-shaped [List] of doubles into a
  /// single flat `List<double>`.
  static List<double> _flattenDoubles(dynamic value) {
    final out = <double>[];
    void walk(dynamic v) {
      if (v is double) {
        out.add(v);
      } else if (v is num) {
        out.add(v.toDouble());
      } else if (v is List) {
        for (final e in v) {
          walk(e);
        }
      }
    }

    walk(value);
    return out;
  }

  @override
  void release() {
    if (_released) return;
    _released = true;
    try {
      _session?.release();
    } finally {
      _session = null;
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
