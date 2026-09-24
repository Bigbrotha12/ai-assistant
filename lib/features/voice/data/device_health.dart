import 'dart:async';
import 'dart:io' show ProcessInfo;

import 'package:flutter/foundation.dart';

enum ThermalStatus {
  unknown,
  nominal,
  light,
  fair,
  moderate,
  serious,
  severe,
  critical,
  emergency,
  shutdown,
}

ThermalStatus thermalStatusFromPlatformName(String? value) {
  switch (value?.trim().toLowerCase()) {
    case 'none':
    case 'nominal':
      return ThermalStatus.nominal;
    case 'light':
      return ThermalStatus.light;
    case 'fair':
      return ThermalStatus.fair;
    case 'moderate':
      return ThermalStatus.moderate;
    case 'serious':
      return ThermalStatus.serious;
    case 'severe':
      return ThermalStatus.severe;
    case 'critical':
      return ThermalStatus.critical;
    case 'emergency':
      return ThermalStatus.emergency;
    case 'shutdown':
      return ThermalStatus.shutdown;
    default:
      return ThermalStatus.unknown;
  }
}

class DeviceHealthSnapshot {
  const DeviceHealthSnapshot({
    this.physicalMemoryBytes,
    this.freeStorageBytes,
    this.thermalStatus = ThermalStatus.unknown,
    this.systemLowMemory,
    this.processRssBytes,
    this.processMemoryLimitBytes,
    this.captureSupported,
  });

  const DeviceHealthSnapshot.unknown()
    : physicalMemoryBytes = null,
      freeStorageBytes = null,
      thermalStatus = ThermalStatus.unknown,
      systemLowMemory = null,
      processRssBytes = null,
      processMemoryLimitBytes = null,
      captureSupported = null;

  final int? physicalMemoryBytes;
  final int? freeStorageBytes;
  final ThermalStatus thermalStatus;
  final bool? systemLowMemory;
  final int? processRssBytes;
  final int? processMemoryLimitBytes;
  final bool? captureSupported;

  bool get hasPhysicalMemory => physicalMemoryBytes != null;
  bool get hasFreeStorage => freeStorageBytes != null;
  bool get hasThermalSignal => thermalStatus != ThermalStatus.unknown;
  bool get hasProcessMemory => processRssBytes != null;

  DeviceHealthSnapshot copyWith({
    Object? physicalMemoryBytes = _unset,
    Object? freeStorageBytes = _unset,
    Object? thermalStatus = _unset,
    Object? systemLowMemory = _unset,
    Object? processRssBytes = _unset,
    Object? processMemoryLimitBytes = _unset,
    Object? captureSupported = _unset,
  }) => DeviceHealthSnapshot(
    physicalMemoryBytes: identical(physicalMemoryBytes, _unset)
        ? this.physicalMemoryBytes
        : physicalMemoryBytes as int?,
    freeStorageBytes: identical(freeStorageBytes, _unset)
        ? this.freeStorageBytes
        : freeStorageBytes as int?,
    thermalStatus: identical(thermalStatus, _unset)
        ? this.thermalStatus
        : thermalStatus as ThermalStatus,
    systemLowMemory: identical(systemLowMemory, _unset)
        ? this.systemLowMemory
        : systemLowMemory as bool?,
    processRssBytes: identical(processRssBytes, _unset)
        ? this.processRssBytes
        : processRssBytes as int?,
    processMemoryLimitBytes: identical(processMemoryLimitBytes, _unset)
        ? this.processMemoryLimitBytes
        : processMemoryLimitBytes as int?,
    captureSupported: identical(captureSupported, _unset)
        ? this.captureSupported
        : captureSupported as bool?,
  );

  static const Object _unset = Object();

  @override
  bool operator ==(Object other) =>
      other is DeviceHealthSnapshot &&
      other.physicalMemoryBytes == physicalMemoryBytes &&
      other.freeStorageBytes == freeStorageBytes &&
      other.thermalStatus == thermalStatus &&
      other.systemLowMemory == systemLowMemory &&
      other.processRssBytes == processRssBytes &&
      other.processMemoryLimitBytes == processMemoryLimitBytes &&
      other.captureSupported == captureSupported;

  @override
  int get hashCode => Object.hash(
    physicalMemoryBytes,
    freeStorageBytes,
    thermalStatus,
    systemLowMemory,
    processRssBytes,
    processMemoryLimitBytes,
    captureSupported,
  );
}

abstract interface class DeviceHealthSource {
  Future<DeviceHealthSnapshot> read();

  Stream<DeviceHealthSnapshot> get changes;
}

abstract interface class ThermalSignalSource {
  ThermalStatus get currentStatus;

  Stream<ThermalStatus> get changes;
}

class NoopDeviceHealthSource implements DeviceHealthSource {
  const NoopDeviceHealthSource();

  @override
  Future<DeviceHealthSnapshot> read() async =>
      const DeviceHealthSnapshot.unknown();

  @override
  Stream<DeviceHealthSnapshot> get changes => const Stream.empty();
}

class NoopThermalSignalSource implements ThermalSignalSource {
  const NoopThermalSignalSource();

  @override
  ThermalStatus get currentStatus => ThermalStatus.unknown;

  @override
  Stream<ThermalStatus> get changes => const Stream.empty();
}

class InMemoryDeviceHealthSource implements DeviceHealthSource {
  InMemoryDeviceHealthSource([
    this.snapshot = const DeviceHealthSnapshot.unknown(),
  ]);

  DeviceHealthSnapshot snapshot;
  final StreamController<DeviceHealthSnapshot> _controller =
      StreamController<DeviceHealthSnapshot>.broadcast();

  @override
  Future<DeviceHealthSnapshot> read() async => snapshot;

  @override
  Stream<DeviceHealthSnapshot> get changes => _controller.stream;

  void emit(DeviceHealthSnapshot next) {
    snapshot = next;
    if (!_controller.isClosed) _controller.add(next);
  }

  Future<void> dispose() => _controller.close();
}

class InMemoryThermalSignalSource implements ThermalSignalSource {
  InMemoryThermalSignalSource([this.currentStatus = ThermalStatus.unknown]);

  @override
  ThermalStatus currentStatus;

  final StreamController<ThermalStatus> _controller =
      StreamController<ThermalStatus>.broadcast();

  @override
  Stream<ThermalStatus> get changes => _controller.stream;

  void emit(ThermalStatus next) {
    currentStatus = next;
    if (!_controller.isClosed) _controller.add(next);
  }

  Future<void> dispose() => _controller.close();
}

class DartRuntimeHealthSource implements DeviceHealthSource {
  final StreamController<DeviceHealthSnapshot> _controller =
      StreamController<DeviceHealthSnapshot>.broadcast();

  @override
  Future<DeviceHealthSnapshot> read() async => _sample();

  @override
  Stream<DeviceHealthSnapshot> get changes => _controller.stream;

  DeviceHealthSnapshot _sample() {
    int? rss;
    try {
      final value = ProcessInfo.currentRss;
      if (value > 0) rss = value;
    } catch (_) {
      rss = null;
    }
    return DeviceHealthSnapshot(processRssBytes: rss);
  }

  void dispose() {
    unawaited(_controller.close());
  }
}

class DeviceHealthMonitor extends ChangeNotifier {
  DeviceHealthMonitor({
    required this.source,
    ThermalSignalSource? thermalSource,
  }) : thermalSource = thermalSource ?? const NoopThermalSignalSource() {
    _sourceSubscription = source.changes.listen(
      (snapshot) => _update(snapshot),
      onError: (Object _) => _update(const DeviceHealthSnapshot.unknown()),
    );
    _thermalSubscription = this.thermalSource.changes.listen(
      (status) => _update(_snapshot.copyWith(thermalStatus: status)),
      onError: (Object _) =>
          _update(_snapshot.copyWith(thermalStatus: ThermalStatus.unknown)),
    );
    unawaited(refresh());
  }

  final DeviceHealthSource source;
  final ThermalSignalSource thermalSource;
  late final StreamSubscription<DeviceHealthSnapshot> _sourceSubscription;
  late final StreamSubscription<ThermalStatus> _thermalSubscription;
  DeviceHealthSnapshot _snapshot = const DeviceHealthSnapshot.unknown();
  bool _disposed = false;

  DeviceHealthSnapshot get snapshot => _snapshot;

  Future<void> refresh() async {
    if (_disposed) return;
    try {
      final next = await source.read();
      if (_disposed) return;
      _update(next.copyWith(thermalStatus: thermalSource.currentStatus));
    } catch (_) {
      if (_disposed) return;
      _update(
        const DeviceHealthSnapshot.unknown().copyWith(
          thermalStatus: thermalSource.currentStatus,
        ),
      );
    }
  }

  void _update(DeviceHealthSnapshot next) {
    if (_disposed || next == _snapshot) return;
    _snapshot = next;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(_sourceSubscription.cancel());
    unawaited(_thermalSubscription.cancel());
    super.dispose();
  }
}
