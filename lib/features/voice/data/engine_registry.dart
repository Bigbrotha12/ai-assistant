import './stt_engine.dart';
import './tts_engine.dart';

/// Registry for speech-to-text and text-to-speech engine instances.
///
/// Engines are registered by an opaque string identifier at initialisation
/// time and looked up by that id. A singleton instance ([engineRegistry]) is
/// provided for app-wide access.
class EngineRegistry {
  /// App-wide singleton.
  static final EngineRegistry instance = EngineRegistry._();

  EngineRegistry._();

  // Convenience alias to match the existing codebase's static-field style.
  static final engineRegistry = EngineRegistry.instance;

  final Map<String, SttEngine> _sttEngines = {};
  final Map<String, TtsEngine> _ttsEngines = {};

  /// Registers a speech-to-text engine under [id].
  ///
  /// If an engine with the same id already exists it is silently replaced.
  void registerSttEngine(String id, SttEngine engine) {
    _sttEngines[id] = engine;
  }

  /// Registers a text-to-speech engine under [id].
  ///
  /// If an engine with the same id already exists it is silently replaced.
  void registerTtsEngine(String id, TtsEngine engine) {
    _ttsEngines[id] = engine;
  }

  /// Returns the registered STT engine for [engineId], or null.
  SttEngine? getSttEngine(String engineId) => _sttEngines[engineId];

  /// Returns the registered TTS engine for [engineId], or null.
  TtsEngine? getTtsEngine(String engineId) => _ttsEngines[engineId];

  /// All registered STT engine identifiers.
  Iterable<String> get sttEngineIds => _sttEngines.keys;

  /// All registered TTS engine identifiers.
  Iterable<String> get ttsEngineIds => _ttsEngines.keys;
}
