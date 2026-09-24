import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Root-app messenger key, wired onto `MaterialApp.scaffoldMessengerKey` in
/// `lib/main.dart`. Lets code without a BuildContext (e.g. the chat
/// StateNotifier's vision-fail notice) surface a snackbar. Declared `final`
/// rather than `const`: [GlobalKey] only exposes a factory constructor.
final scaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

/// Shows a non-blocking snackbar through the root messenger. Safe no-op when
/// the key is not attached — and also when there is no binding yet (plain
/// unit tests) or no Scaffold registered — so callers never guard and a
/// best-effort notice can never break the flow that surfaced it.
void showGlobalSnack(String message) {
  try {
    final messenger = scaffoldMessengerKey.currentState;
    if (messenger == null) return;
    messenger.showSnackBar(SnackBar(content: Text(message)));
  } catch (_) {
    // Fail-open: notice-only — never throw at the call site.
  }
}

/// Indirection seam for provider-layer call sites: defaults to
/// [showGlobalSnack], overridable in tests to count invocations.
final globalSnackProvider =
    Provider<void Function(String message)>((ref) => showGlobalSnack);
