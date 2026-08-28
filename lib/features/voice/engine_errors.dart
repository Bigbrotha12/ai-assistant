/// Sealed error hierarchy for voice engine failures.
sealed class EngineError implements Exception {
  const EngineError(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// The required model file does not exist on disk.
final class EngineModelNotFoundError extends EngineError {
  const EngineModelNotFoundError([super.message = 'Model not found']);
}

/// The model file exists but could not be loaded into the runtime.
final class EngineModelLoadError extends EngineError {
  const EngineModelLoadError(super.message);
}

/// Inference failed after the model was loaded.
final class EngineInferenceError extends EngineError {
  const EngineInferenceError(super.message);
}

/// A model download failed.
final class EngineDownloadError extends EngineError {
  const EngineDownloadError(super.message);
}
