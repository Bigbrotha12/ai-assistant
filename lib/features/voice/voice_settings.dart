/// Voice configuration settings persisted by the user.
///
/// Plain class (not Freezed) with [copyWith] for immutability, following the
/// same pattern as [BackendSettings] and [ConversationState].
class VoiceSettings {
  const VoiceSettings({
    this.sttEngine = 'whisper_tiny',
    this.ttsEngine = 'kokoro_82m',
    this.vadSensitivity = 0.5,
    this.preferredLanguage = 'en',
  });

  final String sttEngine;
  final String ttsEngine;
  final double vadSensitivity;
  final String preferredLanguage;

  /// True when both engine identifiers are non-blank.
  bool get isValid =>
      sttEngine.trim().isNotEmpty && ttsEngine.trim().isNotEmpty;

  VoiceSettings copyWith({
    String? sttEngine,
    String? ttsEngine,
    double? vadSensitivity,
    String? preferredLanguage,
  }) => VoiceSettings(
    sttEngine: sttEngine ?? this.sttEngine,
    ttsEngine: ttsEngine ?? this.ttsEngine,
    vadSensitivity: vadSensitivity ?? this.vadSensitivity,
    preferredLanguage: preferredLanguage ?? this.preferredLanguage,
  );

  @override
  bool operator ==(Object other) =>
      other is VoiceSettings &&
      other.sttEngine == sttEngine &&
      other.ttsEngine == ttsEngine &&
      other.vadSensitivity == vadSensitivity &&
      other.preferredLanguage == preferredLanguage;

  @override
  int get hashCode =>
      Object.hash(sttEngine, ttsEngine, vadSensitivity, preferredLanguage);
}
