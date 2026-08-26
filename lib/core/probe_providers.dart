import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'backend_probe.dart';

/// Provides the concrete [BackendProbe] used to verify connectivity to the
/// backend stack from the settings screen.
final backendProbeProvider = Provider<BackendProbe>(
  (ref) => DioBackendProbe(),
);