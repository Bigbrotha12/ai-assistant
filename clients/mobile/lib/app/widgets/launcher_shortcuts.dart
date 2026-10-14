/// Launcher shortcut definitions and resolution.
///
/// Static launcher shortcuts are declared in
/// `android/app/src/main/res/xml/shortcuts.xml` (ids `open_chat`,
/// `open_voice`). Tapping one launches the activity with
/// `aiassistant://<target>` as the intent data; Flutter surfaces that as the
/// initial route via [PlatformDispatcher.defaultRouteName]. This file maps the
/// URI back to the screen to open.
library;

import 'package:flutter/foundation.dart';

/// Shortcut ids matching `res/xml/shortcuts.xml`.
const String kChatShortcutId = 'open_chat';
const String kVoiceShortcutId = 'open_voice';

const String kChatShortcutLabel = 'Chat';
const String kChatShortcutDescription = 'Open chat';
const String kVoiceShortcutLabel = 'Voice';
const String kVoiceShortcutDescription = 'Open voice conversation';

/// Screens reachable from a launcher shortcut.
enum LauncherShortcutTarget {
  chat,
  voice,
}

/// The `aiassistant://` URI prefix used by launcher shortcut intents.
const String _kUriPrefix = 'aiassistant://';

/// Maps a launcher-shortcut URI (from the intent data) to its target.
///
/// Returns null for unknown or malformed URIs so callers can fall back to the
/// default home screen.
LauncherShortcutTarget? targetForUri(String? uri) {
  final value = uri?.trim();
  if (value == null || !value.startsWith(_kUriPrefix)) return null;
  return switch (value.substring(_kUriPrefix.length)) {
    kChatShortcutId => LauncherShortcutTarget.chat,
    kVoiceShortcutId => LauncherShortcutTarget.voice,
    _ => null,
  };
}

/// The initial route Flutter received from the platform (the launcher
/// shortcut intent data, or `/` for a normal launch).
String? initialRoute() {
  final route = PlatformDispatcher.instance.defaultRouteName;
  if (route.isEmpty || route == '/') return null;
  return route;
}

/// Resolves the initial launcher target, or null for a normal launch.
LauncherShortcutTarget? resolveInitialTarget() => targetForUri(initialRoute());