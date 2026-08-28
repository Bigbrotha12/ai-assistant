/// Default configuration constants for voice engine features.
class EngineConfig {
  EngineConfig._();

  static const String whisperTinyId = 'whisper_tiny';
  static const String whisperTinyUrl =
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';
  static const String kokoro82mId = 'kokoro_82m';
  static const String kokoro82mUrl = 'PLACEHOLDER_URL';
  static const int defaultSampleRate = 16000;
  static const String modelStorageDir = '.voice_models';

  /// Whether a real, downloadable model URL is configured for Kokoro 82 M.
  ///
  /// `PLACEHOLDER_URL` means the model artifact (and the phoneme tokenizer
  /// [KokoroTtsEngine] needs) is not wired up yet. While this is false the
  /// engine is surfaced as *unavailable*: the download UI hides it instead of
  /// offering a download that always fails, and the engine reports an explicit
  /// unsupported error rather than emitting garbage audio.
  ///
  /// Flip this only when a stable Kokoro ONNX export AND the matching
  /// tokenizer have been integrated.
  static bool get kokoro82mDownloadAvailable =>
      kokoro82mUrl.isNotEmpty &&
      kokoro82mUrl != 'PLACEHOLDER_URL';
}
