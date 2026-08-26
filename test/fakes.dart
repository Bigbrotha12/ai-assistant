import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/settings_store.dart';

/// In-memory [SettingsStore] for widget tests.
class FakeSettingsStore implements SettingsStore {
  FakeSettingsStore({this.stored});

  BackendSettings? stored;

  /// When true, the next [save] throws and leaves [stored] unchanged.
  bool failNextSave = false;

  @override
  Future<BackendSettings?> load() async => stored;

  @override
  Future<void> save(BackendSettings settings) async {
    if (failNextSave) {
      failNextSave = false;
      throw StateError('storage unavailable');
    }
    stored = settings;
  }

  @override
  Future<void> clear() async {
    stored = null;
  }
}

/// Configurable [BackendProbe] that records invocations.
class FakeProbe implements BackendProbe {
  FakeProbe({this.status});

  /// The status returned by [probe]; defaults to an empty result.
  final BackendStatus? status;

  /// Number of times [probe] has been called.
  int calls = 0;

  /// The settings passed to the most recent [probe] call.
  BackendSettings? lastSettings;

  @override
  Future<BackendStatus> probe(BackendSettings settings) async {
    calls++;
    lastSettings = settings;
    return status ?? const BackendStatus(checks: []);
  }
}