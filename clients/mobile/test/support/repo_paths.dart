import 'dart:io';

/// Resolves a repository-root-relative path to a [File].
///
/// `flutter test` runs with the package root (`clients/mobile`) as CWD, but the
/// shared server artifacts live at the repository root — the plugin-contract
/// golden fixture (`test/fixtures/plugin_contract.json`) and the canonical
/// Sentinel rule source (`server/src/sentinel/rules.v1.json`), whose presence
/// marks the root. Walking up to the repository marker lets these tests resolve
/// the same files regardless of the launch directory.
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
