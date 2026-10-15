import 'dart:io';

/// Resolves a repository-root-relative path to a [File].
///
/// `flutter test` runs with the package root (`clients/mobile`) as CWD, but the
/// sentinel and plugin-contract golden fixtures live at the repository root and
/// are shared with the server test suite. Walking up to the repository marker
/// lets these tests resolve the same files regardless of the launch directory.
File repoFile(String relativePath) {
  var directory = Directory.current;
  while (true) {
    if (File('${directory.path}/server/src/sentinel/rules.v1.json').existsSync()) {
      return File('${directory.path}/$relativePath');
    }
    final parent = directory.parent;
    if (parent.path == directory.path) {
      throw StateError(
        'repository root not found from ${Directory.current.path}: no '
        'server/src/sentinel/rules.v1.json in any ancestor directory',
      );
    }
    directory = parent;
  }
}
