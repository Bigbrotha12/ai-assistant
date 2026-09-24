import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import './device_health.dart';

final thermalSignalSourceProvider = Provider<ThermalSignalSource>(
  (ref) => const NoopThermalSignalSource(),
);

final deviceHealthSourceProvider = Provider<DeviceHealthSource>((ref) {
  final source = DartRuntimeHealthSource();
  ref.onDispose(source.dispose);
  return source;
});

final deviceHealthProvider = ChangeNotifierProvider<DeviceHealthMonitor>((ref) {
  return DeviceHealthMonitor(
    source: ref.watch(deviceHealthSourceProvider),
    thermalSource: ref.watch(thermalSignalSourceProvider),
  );
});
