/// Speech-to-text engine interface.
abstract interface class SttEngine {
  /// Transcribes [pcm16bit] — raw PCM-encoded 16-bit signed integer samples —
  /// recorded at [sampleRate] Hz, returning the recognised text.
  Future<String> transcribe(List<int> pcm16bit, {required int sampleRate});

  /// Human-readable identifier for this engine implementation.
  String get name;
}
