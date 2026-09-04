/// Default configuration constants for voice engine features.
class EngineConfig {
  EngineConfig._();

  static const String whisperTinyId = 'whisper_tiny';
  static const String whisperTinyUrl =
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';

  // ---------------------------------------------------------------------------
  // Supertonic 3 (on-device TTS, sherpa-onnx)
  // ---------------------------------------------------------------------------

  static const String supertonic3Id = 'supertonic_3';

  /// Subdirectory of [modelStorageDir] holding the seven Supertonic 3
  /// artifacts (`<appDocs>/.voice_models/supertonic_3/`).
  static const String supertonic3ModelDir = 'supertonic_3';

  /// Base URL of the sherpa-onnx Supertonic 3 int8 model repository.
  ///
  /// The repo mirrors the official `sherpa-onnx-supertonic-3-tts-int8-2026-05-11`
  /// release (Supertone/supertonic-3 quantized by k2-fsa). Each artifact is
  /// downloaded per-file via [ModelDownloader] (single-file API), so the 7
  /// URLs below must all resolve.
  static const String supertonic3UrlBase =
      'https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11'
      '/resolve/main';

  // Per-artifact constants: downloader/state key, on-disk file name and URL.
  // Together the 7 artifacts total ~145 MB (~139 MB of model weights plus
  // the bundled README/LICENSE).

  static const String supertonic3TextEncoderId = 'supertonic_3_text_encoder';
  static const String supertonic3TextEncoderFile = 'text_encoder.int8.onnx';
  static const String supertonic3TextEncoderUrl =
      '$supertonic3UrlBase/$supertonic3TextEncoderFile';

  static const String supertonic3VectorEstimatorId =
      'supertonic_3_vector_estimator';
  static const String supertonic3VectorEstimatorFile =
      'vector_estimator.int8.onnx';
  static const String supertonic3VectorEstimatorUrl =
      '$supertonic3UrlBase/$supertonic3VectorEstimatorFile';

  static const String supertonic3VocoderId = 'supertonic_3_vocoder';
  static const String supertonic3VocoderFile = 'vocoder.int8.onnx';
  static const String supertonic3VocoderUrl =
      '$supertonic3UrlBase/$supertonic3VocoderFile';

  static const String supertonic3DurationPredictorId =
      'supertonic_3_duration_predictor';
  static const String supertonic3DurationPredictorFile =
      'duration_predictor.int8.onnx';
  static const String supertonic3DurationPredictorUrl =
      '$supertonic3UrlBase/$supertonic3DurationPredictorFile';

  static const String supertonic3TtsJsonId = 'supertonic_3_tts_json';
  static const String supertonic3TtsJsonFile = 'tts.json';
  static const String supertonic3TtsJsonUrl =
      '$supertonic3UrlBase/$supertonic3TtsJsonFile';

  static const String supertonic3UnicodeIndexerId =
      'supertonic_3_unicode_indexer';
  static const String supertonic3UnicodeIndexerFile = 'unicode_indexer.bin';
  static const String supertonic3UnicodeIndexerUrl =
      '$supertonic3UrlBase/$supertonic3UnicodeIndexerFile';

  static const String supertonic3VoiceId = 'supertonic_3_voice';
  static const String supertonic3VoiceFile = 'voice.bin';
  static const String supertonic3VoiceUrl =
      '$supertonic3UrlBase/$supertonic3VoiceFile';

  static const int defaultSampleRate = 16000;
  static const String modelStorageDir = '.voice_models';

  /// Whether a real, downloadable Supertonic 3 artifact set is configured.
  ///
  /// All URLs above were verified against the
  /// `csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11` repo
  /// (HTTP 200, exact byte sizes). The engine's synthesis pipeline is real
  /// (sherpa-onnx OfflineTts in a worker isolate → PCM), so the download UI
  /// may offer the model.
  ///
  /// Flip to `false` ONLY if an artifact cannot be downloaded or the
  /// pipeline is known-broken on-device.
  static const bool supertonic3DownloadAvailable = true;
}
