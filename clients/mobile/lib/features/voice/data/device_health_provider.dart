import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import './device_health.dart';

final platformDeviceHealthBridgeProvider = Provider<PlatformDeviceHealthBridge>(
  (ref) {
    final bridge = PlatformDeviceHealthBridge();
    ref.onDispose(bridge.dispose);
    return bridge;
  },
);

final thermalSignalSourceProvider = Provider<ThermalSignalSource>(
  (ref) => PlatformThermalSignalSource(
    ref.watch(platformDeviceHealthBridgeProvider),
  ),
);

final deviceHealthSourceProvider = Provider<DeviceHealthSource>(
  (ref) =>
      PlatformDeviceHealthSource(ref.watch(platformDeviceHealthBridgeProvider)),
);

final deviceHealthProvider = ChangeNotifierProvider<DeviceHealthMonitor>((ref) {
  return DeviceHealthMonitor(
    source: ref.watch(deviceHealthSourceProvider),
    thermalSource: ref.watch(thermalSignalSourceProvider),
  );
});
