/// Silence-envelope analysis of PCM16 buffers, used by the debug-only speak
/// queue diagnostics to distinguish model-baked trailing silence from an
/// actual inter-chunk latency gap.
library;

import 'dart:math';

/// Buffer [samples] statistics in milliseconds and amplitude units.
typedef PcmEnvelopeMetrics = ({
  int samples,
  int speechMs,
  int leadingSilenceMs,
  int trailingSilenceMs,
  double peak,
  double rmsDb,
});

/// Trims leading/trailing silence from a mono PCM16 buffer, keeping a small
/// natural pre/post-roll so speech edges are not clipped abruptly.
///
/// A frame counts as silence when its |amplitude| stays below
/// [amplitudeThreshold]. Only the EDGE runs are removed — silence inside the
/// utterance (breaths, clause pauses) is preserved. The kept margins
/// ([keepLeadingMs], [keepTrailingMs]) preserve a natural onset/offset; a run
/// shorter than its margin is left untouched. Returns [samples] unchanged
/// when nothing qualifies for a trim (including fully silent buffers).
List<int> trimPcm16Silence(
  List<int> samples, {
  int sampleRate = 16000,
  int amplitudeThreshold = 80,
  int keepLeadingMs = 40,
  int keepTrailingMs = 150,
}) {
  final n = samples.length;
  if (n == 0) return samples;

  var start = 0;
  while (start < n && samples[start].abs() < amplitudeThreshold) {
    start++;
  }
  if (start == n) return samples; // all silence: leave untouched.

  var end = n;
  while (end > start && samples[end - 1].abs() < amplitudeThreshold) {
    end--;
  }

  final keepLead = sampleRate * keepLeadingMs ~/ 1000;
  final keepTrail = sampleRate * keepTrailingMs ~/ 1000;
  final from = start > keepLead ? start - keepLead : 0;
  final to = end + keepTrail < n ? end + keepTrail : n;
  if (from == 0 && to == n) return samples;
  return samples.sublist(from, to);
}

/// Computes the silence envelope of a mono PCM16 buffer.
///
/// Scans both ends of [samples] for runs where |sample| stays below
/// [amplitudeThreshold] (in raw int16 units) — those are the perceived
/// pre/post-utterance silence baked into the chunk. A frame above the
/// threshold ends the run, so quiet speech is not mistaken for silence.
///
/// Returns leading/trailing silence and speech durations in milliseconds
/// (derived from [sampleRate]), plus the peak amplitude (`0..1`) and whole-
/// buffer RMS in dBFS for level sanity checks.
PcmEnvelopeMetrics analyzePcm16Envelope(
  List<int> samples, {
  int sampleRate = 16000,
  int amplitudeThreshold = 80,
}) {
  if (samples.isEmpty) {
    return (
      samples: 0,
      speechMs: 0,
      leadingSilenceMs: 0,
      trailingSilenceMs: 0,
      peak: 0,
      rmsDb: double.negativeInfinity,
    );
  }

  var leading = 0;
  while (leading < samples.length &&
      samples[leading].abs() < amplitudeThreshold) {
    leading++;
  }

  var trailing = 0;
  while (trailing < samples.length - leading &&
      samples[samples.length - 1 - trailing].abs() < amplitudeThreshold) {
    trailing++;
  }

  var peak = 0;
  var sumSquares = 0.0;
  for (final sample in samples) {
    final abs = sample.abs();
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }

  final msPerSample = 1000.0 / sampleRate;
  final rms = sqrt(sumSquares / samples.length);
  final speech = samples.length - leading - trailing;
  return (
    samples: samples.length,
    speechMs: (speech * msPerSample).round(),
    leadingSilenceMs: (leading * msPerSample).round(),
    trailingSilenceMs: (trailing * msPerSample).round(),
    peak: peak / 32767.0,
    rmsDb: 20 * log((rms > 0 ? rms : 1e-9) / 32767.0) / ln10,
  );
}