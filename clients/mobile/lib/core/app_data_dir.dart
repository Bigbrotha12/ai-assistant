import 'dart:io';

import 'package:flutter/foundation.dart' show debugPrint, kIsWeb;
import 'package:path_provider/path_provider.dart';

/// Root directory for every on-disk artefact the app owns.
///
/// One root, so a local dev build keeps its entire footprint inside the repo:
/// the drift database, downloaded voice models, the attachment cache, and
/// account exports all hang off the directory returned by [resolve].
///
/// **Override (desktop dev builds only).** `--dart-define=APP_DATA_DIR=<abs>`
/// — which `dev.sh` sets to `<repo>/data/app` — replaces the platform default.
/// It is deliberately ignored on Android/iOS: the define holds a build-host
/// absolute path (e.g. `/home/<user>/Projects/...`), which is meaningless on a
/// phone, so those platforms always use `getApplicationDocumentsDirectory()`.
///
/// With no define, [resolve] falls back to
/// `getApplicationDocumentsDirectory()` — which on Linux desktop is XDG's
/// `~/Documents`, scattering app-owned files into a user-content folder.
class AppDataDir {
  const AppDataDir._();

  /// Compile-time override, set by `dev.sh` (see class docs). Empty when unset.
  static const String overrideDefine = String.fromEnvironment('APP_DATA_DIR');

  /// The directory every app-owned file lives under.
  ///
  /// Intentionally not memoized: each caller resolves once and caches its own
  /// derived path (the engine manager holds `_resolvedModelDir`, the cache and
  /// downloader hold their own futures), and an un-memoized lookup keeps tests
  /// that re-point `path_provider` at a fresh temp dir per case honest.
  static Future<Directory> resolve() async {
    final override = _overrideForThisPlatform();
    if (override != null) {
      final dir = Directory(override);
      // Create eagerly: the drift database, the voice model tree, and the
      // attachment cache all assume their parent already exists.
      await dir.create(recursive: true);
      return dir;
    }
    return getApplicationDocumentsDirectory();
  }

  static String? _overrideForThisPlatform() => validateOverride(
    overrideDefine,
    isDesktop: !kIsWeb &&
        (Platform.isLinux || Platform.isMacOS || Platform.isWindows),
  );

  /// The data root to use for [define] on a target that [isDesktop], else null
  /// (meaning: use the platform documents directory).
  ///
  /// Guards three ways, because a silently misapplied host path would either
  /// write app data somewhere unexpected or fail deep inside a plugin call:
  /// mobile/web targets are ignored outright, a blank define is ignored, and a
  /// non-absolute path is rejected rather than resolved against a CWD that
  /// differs between `flutter run`, the packaged binary, and tests.
  ///
  /// POSIX-absolute only (a leading `/`). `dev.sh` is a bash script, so it can
  /// only produce POSIX paths for a Windows host anyway (git-bash `/c/...` or
  /// WSL `/mnt/c/...`, neither of which a native Windows build understands) —
  /// a Windows dev build should pass a native `C:\...` path through
  /// `APP_DATA_DIR` directly and skip `dev.sh` for this.
  static String? validateOverride(String define, {required bool isDesktop}) {
    if (!isDesktop) return null;
    final value = define.trim();
    if (value.isEmpty) return null;
    if (!value.startsWith('/')) {
      debugPrint(
        'AppDataDir: ignoring non-absolute APP_DATA_DIR "$value"; '
        'expected an absolute path (dev.sh supplies one).',
      );
      return null;
    }
    return value;
  }
}