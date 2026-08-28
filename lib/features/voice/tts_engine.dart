/// Text-to-speech engine interface.
abstract interface class TtsEngine {
  /// Synthesises [text] into raw PCM samples — 16-bit signed, mono — at
  /// [sampleRate] Hz.
  Future<List<int>> synthesize(String text, {required int sampleRate});

  /// Human-readable identifier for this engine implementation.
  String get name;
}
