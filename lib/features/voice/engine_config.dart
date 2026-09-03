/// Default configuration constants for voice engine features.
class EngineConfig {
  EngineConfig._();

  static const String whisperTinyId = 'whisper_tiny';
  static const String whisperTinyUrl =
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';

  // ---------------------------------------------------------------------------
  // Kokoro 82M (on-device TTS)
  // ---------------------------------------------------------------------------

  static const String kokoro82mId = 'kokoro_82m';

  /// Downloader/state keys for Kokoro's secondary (non-primary) artifacts.
  static const String kokoro82mVoicesId = 'kokoro_82m_voices';
  static const String kokoro82mTokenizerId = 'kokoro_82m_tokenizer';

  /// Primary ONNX graph URL for the Kokoro 82M synthesis model.
  ///
  /// We use the **int8-quantized** export (`model_quantized.onnx`, ~92 MB)
  /// rather than the full fp32 `model.onnx` (~300 MB): Kokoro is intended to
  /// run on-device, and the quantized graph is far smaller with only a small
  /// quality trade-off (io node names are identical). Both the quantized and
  /// full exports live in the `onnx-community/Kokoro-82M-v1.0-ONNX` repo.
  ///
  /// Inputs are `input_ids` (int64), `style` (float32, `[1, 256]`), `speed`
  /// (float32, `[1]`); the output tensor is `audio` (float32, ~24 kHz mono).
  /// The engine maps io names generically via `session.inputNames` /
  /// `session.outputNames`, so this tolerates the model naming shown above.
  static const String kokoro82mUrl =
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/'
      'resolve/main/onnx/model_quantized.onnx';

  /// Voice/style embedding artifact.
  ///
  /// The packed `voices/af.bin` file is a flat `float32` array holding one
  /// 256-dim style vector per valid token-count, reshaped row-major as
  /// `[n_vectors, 1, 256]` (e.g. `af.bin` is 524288 bytes = 512 rows). The
  /// style vector for a phoneme sequence is `voices[tokens.length]`.
  static const String kokoro82mVoicesUrl =
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/'
      'resolve/main/voices/af.bin';

  /// Phoneme → token-id vocabulary (`tokenizer.json`).
  ///
  /// This downloadable file is the canonical, data-driven source for the
  /// IPA→integer mapping (see `KokoroTokenizer`). It matches the
  /// `hexgrad/Kokoro-82M` `config.json` vocab at the pinned commit
  /// `785407d1adfa7ae8fbef8ffd85f34ca127da3039`. A built-in fallback copy of
  /// the same map is shipped in the tokenizer so the engine degrades
  /// gracefully if this artifact is missing.
  static const String kokoro82mTokenizerUrl =
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/'
      'resolve/main/tokenizer.json';

  /// Fallback local file name of the voices artifact on disk (must match
  /// [kokoro82mVoicesUrl]'s landing name used by [EngineManager]).
  static const String kokoro82mVoicesFileName = 'kokoro_82m_voices.bin';
  static const String kokoro82mTokenizerFileName = 'kokoro_82m_tokenizer.json';

  static const int defaultSampleRate = 16000;
  static const String modelStorageDir = '.voice_models';

  /// Whether a real, downloadable Kokoro artifact set is configured.
  ///
  /// All three URLs above point to files verified to exist in the
  /// `onnx-community/Kokoro-82M-v1.0-ONNX` repo: the quantized ONNX graph,
  /// the packed `af.bin` voices, and the `tokenizer.json` vocab. The engine's
  /// synthesis pipeline is real (phoneme tokenizer → ONNX → PCM), so the
  /// download UI may offer the model.
  ///
  /// Keep this `false` ONLY if an artifact cannot be downloaded or the
  /// pipeline is known-broken on-device. On-device validation is still
  /// strongly recommended (see the M0b report notes) before shipping; if
  /// synthesis turns out to produce no audible audio, flip this back to
  /// `false` to hide the broken download.
  static bool get kokoro82mDownloadAvailable =>
      kokoro82mUrl.isNotEmpty &&
      kokoro82mUrl != 'PLACEHOLDER_URL' &&
      kokoro82mVoicesUrl.isNotEmpty &&
      kokoro82mTokenizerUrl.isNotEmpty;
}
