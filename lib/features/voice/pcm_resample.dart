/// PCM resampling / conversion helpers shared by TTS engines.
library;

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

  // Integer length math: ceil(input.length * outputRate / inputRate) — exact
  // for the target duration instead of accumulating double rounding error
  // through `ratio`.
  final outLength =
      (input.length * outputRate + inputRate - 1) ~/ inputRate;
  final ratio = inputRate / outputRate;
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
/// clamped to the int16 range. NaN / ±Inf fold to silence instead of throwing
/// (`double.round()` on a NaN would raise an [UnsupportedError]).
int _floatToPcm16(double sample) {
  final v = sample.isFinite
      ? (sample * 32767).clamp(-32768.0, 32767.0).round()
      : 0;
  return v;
}
