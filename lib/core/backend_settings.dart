/// Runtime-entered backend configuration (host + shared secret).
class BackendSettings {
  const BackendSettings({required this.host, required this.secret});

  final String host;
  final String secret;

  /// True when both fields are non-blank.
  bool get isValid => host.trim().isNotEmpty && secret.trim().isNotEmpty;

  String get trimmedHost => host.trim();

  BackendSettings copyWith({String? host, String? secret}) =>
      BackendSettings(host: host ?? this.host, secret: secret ?? this.secret);

  @override
  bool operator ==(Object other) =>
      other is BackendSettings && other.host == host && other.secret == secret;

  @override
  int get hashCode => Object.hash(host, secret);
}