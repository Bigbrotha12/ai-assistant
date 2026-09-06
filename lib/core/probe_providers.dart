import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/data/auth_credentials_providers.dart';
import 'backend_probe.dart';

/// Provides the concrete [BackendProbe] used to verify connectivity to the
/// backend gateway from the settings screen. Probe requests authenticate with
/// the persisted API key ([authCredentialsProvider]).
final backendProbeProvider = Provider<BackendProbe>(
  (ref) => DioBackendProbe(
    apiKeyReader: () async {
      final credentials = await ref.read(authCredentialsProvider.future);
      return credentials?.apiKey;
    },
  ),
);