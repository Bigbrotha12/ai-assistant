import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Non-secret application preferences (stored in plain shared_preferences).
class AppPrefs {
  const AppPrefs({
    this.dateFormat = 'en-US',
    this.onboardingComplete = false,
    this.goalLastSeen = const {},
  });

  /// Locale string used to format dates throughout the UI.
  final String dateFormat;

  /// Whether the user has completed the onboarding flow.
  final bool onboardingComplete;

  /// Per-account marker for the last time the owner viewed the goals list,
  /// keyed by `AuthAccountScope.storageId` and valued with a UTC ISO-8601
  /// timestamp. Phase 7.3's goal-attention dot compares each paused/failed
  /// goal's `updatedAt` against this. Additive: a missing entry means the
  /// account has never viewed the list (or the record predates 7.3).
  ///
  /// Accepted limitation (L6): entries are never pruned, so this grows with the
  /// number of distinct scopes ever signed in on the device. The payload stays
  /// tiny (one short string per account) and a signed-out account's marker is
  /// harmless; a future cleanup pass can drop entries no longer reachable.
  final Map<String, String> goalLastSeen;

  AppPrefs copyWith({
    String? dateFormat,
    bool? onboardingComplete,
    Map<String, String>? goalLastSeen,
  }) {
    return AppPrefs(
      dateFormat: dateFormat ?? this.dateFormat,
      onboardingComplete: onboardingComplete ?? this.onboardingComplete,
      goalLastSeen: goalLastSeen ?? this.goalLastSeen,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AppPrefs &&
      other.dateFormat == dateFormat &&
      other.onboardingComplete == onboardingComplete &&
      _stringMapEquals(other.goalLastSeen, goalLastSeen);

  @override
  int get hashCode => Object.hash(
    dateFormat,
    onboardingComplete,
    Object.hashAllUnordered(
      goalLastSeen.entries.map((e) => Object.hash(e.key, e.value)),
    ),
  );
}

bool _stringMapEquals(Map<String, String> a, Map<String, String> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (final entry in a.entries) {
    if (b[entry.key] != entry.value) return false;
  }
  return true;
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
      goalLastSeen: map['goalLastSeen'] is Map<String, String>
          ? map['goalLastSeen'] as Map<String, String>
          : const {},
    );
  }

  @override
  Future<void> save(AppPrefs prefs) async {
    final storage = await SharedPreferences.getInstance();
    await storage.setString(_kKey, _encode(prefs));
  }

  /// Encodes as `<dateFormat-length>:<dateFormat>:<flag>[:<lastSeen>]` where
  /// `lastSeen` is URL-safe base64 of the marker map's JSON (so it can never
  /// contain the `:` separator) and is omitted when the map is empty. The
  /// first three fields are byte-for-byte the pre-7.3 format, so an upgrade
  /// reads old records unchanged (pre-7.3 parity: `_decode` tolerates both
  /// the two-segment old shape and the three-segment new one).
  static String _encode(AppPrefs prefs) {
    final flag = prefs.onboardingComplete ? '1' : '0';
    final base = '${prefs.dateFormat.length}:${prefs.dateFormat}:$flag';
    if (prefs.goalLastSeen.isEmpty) return base;
    final encoded = base64Url.encode(
      utf8.encode(jsonEncode(prefs.goalLastSeen)),
    );
    return '$base:$encoded';
  }

  static Map<String, Object?> _decode(String raw) {
    final colon = raw.indexOf(':');
    if (colon <= 0) return const {};
    final len = int.tryParse(raw.substring(0, colon));
    if (len == null || colon + 1 + len > raw.length) return const {};
    final dateFormat = raw.substring(colon + 1, colon + 1 + len);
    var rest = raw.substring(colon + 1 + len);
    // `rest` starts with the flag's leading ':' in every known format.
    if (rest.startsWith(':')) rest = rest.substring(1);
    final sep = rest.indexOf(':');
    final flag = sep == -1 ? rest : rest.substring(0, sep);
    final lastSeen = sep == -1
        ? const <String, String>{}
        : _decodeLastSeen(rest.substring(sep + 1));
    return {
      'dateFormat': dateFormat,
      'onboardingComplete': flag == '1',
      'goalLastSeen': lastSeen,
    };
  }

  static Map<String, String> _decodeLastSeen(String raw) {
    if (raw.isEmpty) return const {};
    try {
      final decoded = utf8.decode(base64Url.decode(raw));
      final json = jsonDecode(decoded);
      if (json is! Map) return const {};
      return {
        for (final entry in json.entries)
          if (entry.value is String)
            entry.key.toString(): entry.value as String,
      };
    } catch (_) {
      // A malformed marker degrades to "never viewed", never a crash.
      return const {};
    }
  }
}
