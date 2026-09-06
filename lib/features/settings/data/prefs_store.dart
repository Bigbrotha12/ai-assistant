import 'package:shared_preferences/shared_preferences.dart';

/// Non-secret application preferences (stored in plain shared_preferences).
class AppPrefs {
  const AppPrefs({this.dateFormat = 'en-US', this.onboardingComplete = false});

  /// Locale string used to format dates throughout the UI.
  final String dateFormat;

  /// Whether the user has completed the onboarding flow.
  final bool onboardingComplete;

  AppPrefs copyWith({String? dateFormat, bool? onboardingComplete}) {
    return AppPrefs(
      dateFormat: dateFormat ?? this.dateFormat,
      onboardingComplete: onboardingComplete ?? this.onboardingComplete,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AppPrefs &&
      other.dateFormat == dateFormat &&
      other.onboardingComplete == onboardingComplete;

  @override
  int get hashCode => Object.hash(dateFormat, onboardingComplete);
}

/// Persistence for [AppPrefs].
abstract interface class AppPrefsStore {
  /// Returns the saved prefs, or defaults when nothing has been saved.
  Future<AppPrefs> load();

  /// Persists [prefs] for later retrieval.
  Future<void> save(AppPrefs prefs);
}

/// [SharedPreferences]-backed store. The instance is injectable so tests can
/// substitute an in-memory fake.
class SharedPrefsAppPrefsStore implements AppPrefsStore {
  SharedPrefsAppPrefsStore();

  static const _kKey = 'app_prefs';

  @override
  Future<AppPrefs> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kKey);
    if (raw == null) return const AppPrefs();
    final map = _decode(raw);
    return AppPrefs(
      dateFormat: map['dateFormat'] is String
          ? map['dateFormat'] as String
          : 'en-US',
      onboardingComplete: map['onboardingComplete'] is bool
          ? map['onboardingComplete'] as bool
          : false,
    );
  }

  @override
  Future<void> save(AppPrefs prefs) async {
    final storage = await SharedPreferences.getInstance();
    await storage.setString(_kKey, _encode(prefs));
  }

  /// Encodes as `<dateFormat-length>:<dateFormat>:<flag>` so the date format
  /// may contain any characters (including colons/newlines) without ambiguity.
  static String _encode(AppPrefs prefs) {
    final flag = prefs.onboardingComplete ? '1' : '0';
    return '${prefs.dateFormat.length}:${prefs.dateFormat}:$flag';
  }

  static Map<String, Object?> _decode(String raw) {
    final colon = raw.indexOf(':');
    if (colon <= 0) return const {};
    final len = int.tryParse(raw.substring(0, colon));
    if (len == null || colon + 1 + len > raw.length) return const {};
    final dateFormat = raw.substring(colon + 1, colon + 1 + len);
    final flag = raw.substring(colon + 1 + len);
    return {
      'dateFormat': dateFormat,
      'onboardingComplete': flag == ':1',
    };
  }
}
