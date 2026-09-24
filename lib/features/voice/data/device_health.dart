import 'dart:async';
import 'dart:io' show Platform, ProcessInfo;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const String deviceHealthMethodChannelName =
    'dev.bigbrotha.ai_assistant/voice/device_health';
const String deviceHealthThermalEventChannelName =
    '$deviceHealthMethodChannelName/thermal';
const String deviceHealthLowMemoryEventChannelName =
    '$deviceHealthMethodChannelName/low_memory';

enum DeviceHealthTelemetryField {
  physicalMemory,
  freeStorage,
  systemLowMemory,
  thermal,
}

const Set<DeviceHealthTelemetryField> voiceCriticalTelemetryFields = {
  DeviceHealthTelemetryField.physicalMemory,
  DeviceHealthTelemetryField.freeStorage,
  DeviceHealthTelemetryField.systemLowMemory,
};

// A short grace keeps a slow native channel from disabling voice on every launch;
// after it, an unknown critical signal is safer to treat as unsafe than as proof
// that the device can safely capture or download.
const Duration voiceTelemetryGracePeriod = Duration(seconds: 2);

/// Platform health reads use the same two-second bound as telemetry grace.
///
/// A timeout returns a degraded snapshot, so text remains available while
/// voice capture and model downloads become fail-closed once grace expires.
const Duration deviceHealthSnapshotTimeout = voiceTelemetryGracePeriod;

Duration get defaultVoiceTelemetryGracePeriod => voiceTelemetryGracePeriod;

bool get voiceTelemetryPlatformSupported =>
    Platform.isAndroid || Platform.isIOS;

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

  Set<DeviceHealthTelemetryField> get unknownCriticalTelemetry {
    final unknown = <DeviceHealthTelemetryField>{};
    for (final field in voiceCriticalTelemetryFields) {
      final isUnknown = switch (field) {
        DeviceHealthTelemetryField.physicalMemory =>
          physicalMemoryBytes == null,
        DeviceHealthTelemetryField.freeStorage => freeStorageBytes == null,
        DeviceHealthTelemetryField.systemLowMemory => systemLowMemory == null,
        DeviceHealthTelemetryField.thermal =>
          thermalStatus == ThermalStatus.unknown,
      };
      if (isUnknown) unknown.add(field);
    }
    return unknown;
  }

  bool get hasUnknownCriticalTelemetry => unknownCriticalTelemetry.isNotEmpty;

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

class PlatformDeviceHealthBridge {
  PlatformDeviceHealthBridge({
    MethodChannel? methodChannel,
    EventChannel? thermalChannel,
    EventChannel? lowMemoryChannel,
    bool? eventStreamsEnabled,
    Duration? snapshotTimeout,
  }) : _methodChannel =
           methodChannel ?? const MethodChannel(deviceHealthMethodChannelName),
       _thermalChannel =
           thermalChannel ??
           const EventChannel(deviceHealthThermalEventChannelName),
       _lowMemoryChannel =
           lowMemoryChannel ??
           const EventChannel(deviceHealthLowMemoryEventChannelName),
       _eventStreamsEnabled =
           eventStreamsEnabled ?? (Platform.isAndroid || Platform.isIOS),
       snapshotTimeout = snapshotTimeout ?? deviceHealthSnapshotTimeout {
    _snapshotController = StreamController<DeviceHealthSnapshot>.broadcast(
      onListen: _ensureEventSubscriptions,
      onCancel: _maybeStopEventSubscriptions,
    );
    _thermalController = StreamController<ThermalStatus>.broadcast(
      onListen: _ensureEventSubscriptions,
      onCancel: _maybeStopEventSubscriptions,
    );
  }

  final MethodChannel _methodChannel;
  final EventChannel _thermalChannel;
  final EventChannel _lowMemoryChannel;
  final bool _eventStreamsEnabled;
  final Duration snapshotTimeout;

  late final StreamController<DeviceHealthSnapshot> _snapshotController;
  late final StreamController<ThermalStatus> _thermalController;

  DeviceHealthSnapshot _snapshot = const DeviceHealthSnapshot.unknown();
  StreamSubscription<dynamic>? _thermalSubscription;
  StreamSubscription<dynamic>? _lowMemorySubscription;
  bool _eventSubscriptionsWanted = false;
  bool _eventSubscriptionsActive = false;
  int? _activeEventSubscriptionGeneration;
  bool _platformAvailable = false;
  bool _disposed = false;
  int _eventSubscriptionGeneration = 0;
  int _thermalEventGeneration = 0;
  int _lowMemoryEventGeneration = 0;
  Future<void>? _eventSubscriptionTransition;
  Future<DeviceHealthSnapshot>? _readInFlight;

  Stream<DeviceHealthSnapshot> get snapshotChanges =>
      _snapshotController.stream;

  Stream<ThermalStatus> get thermalChanges => _thermalController.stream;

  ThermalStatus get currentThermalStatus => _snapshot.thermalStatus;

  Future<DeviceHealthSnapshot> read() {
    if (_disposed) return Future<DeviceHealthSnapshot>.value(_snapshot);
    final inFlight = _readInFlight;
    if (inFlight != null) return inFlight;
    final operation = _read();
    _readInFlight = operation;
    unawaited(
      operation.then<void>(
        (_) => _clearReadInFlight(operation),
        onError: (Object _, StackTrace _) => _clearReadInFlight(operation),
      ),
    );
    return operation;
  }

  void _clearReadInFlight(Future<DeviceHealthSnapshot> operation) {
    if (identical(_readInFlight, operation)) _readInFlight = null;
  }

  Future<DeviceHealthSnapshot> _read() async {
    if (_disposed) return _snapshot;
    final rss = _readProcessRss();
    if (!_eventStreamsEnabled && !voiceTelemetryPlatformSupported) {
      final next = DeviceHealthSnapshot(processRssBytes: rss);
      _setSnapshot(next);
      return next;
    }

    final thermalGeneration = _thermalEventGeneration;
    final lowMemoryGeneration = _lowMemoryEventGeneration;
    try {
      final raw = await _methodChannel
          .invokeMethod<Object?>('getSnapshot')
          .timeout(snapshotTimeout);
      if (_disposed) return _snapshot;
      final platformSnapshot = _snapshotFromPlatform(raw, rss);
      final next = _mergePlatformSnapshot(
        platformSnapshot,
        thermalGeneration,
        lowMemoryGeneration,
      );
      _platformAvailable = true;
      _ensureEventSubscriptions();
      _setSnapshot(next);
      return next;
    } catch (_) {
      if (_disposed) return _snapshot;
      _platformAvailable = false;
      final next = _degradedSnapshot(
        rss,
        thermalGeneration,
        lowMemoryGeneration,
      );
      _setSnapshot(next);
      return next;
    }
  }

  DeviceHealthSnapshot _mergePlatformSnapshot(
    DeviceHealthSnapshot platformSnapshot,
    int thermalGeneration,
    int lowMemoryGeneration,
  ) => platformSnapshot.copyWith(
    thermalStatus: thermalGeneration == _thermalEventGeneration
        ? platformSnapshot.thermalStatus
        : _snapshot.thermalStatus,
    systemLowMemory: lowMemoryGeneration == _lowMemoryEventGeneration
        ? platformSnapshot.systemLowMemory
        : _snapshot.systemLowMemory,
  );

  DeviceHealthSnapshot _degradedSnapshot(
    int? rss,
    int thermalGeneration,
    int lowMemoryGeneration,
  ) => DeviceHealthSnapshot(
    thermalStatus: thermalGeneration == _thermalEventGeneration
        ? ThermalStatus.unknown
        : _snapshot.thermalStatus,
    systemLowMemory: lowMemoryGeneration == _lowMemoryEventGeneration
        ? null
        : _snapshot.systemLowMemory,
    processRssBytes: rss,
    processMemoryLimitBytes: _snapshot.processMemoryLimitBytes,
    captureSupported: _snapshot.captureSupported,
  );

  void _ensureEventSubscriptions() {
    if (!_canStartEventSubscriptions) return;
    _eventSubscriptionsWanted = true;
    _scheduleEventSubscriptionTransition();
  }

  bool get _canStartEventSubscriptions =>
      !_disposed &&
      _eventStreamsEnabled &&
      _platformAvailable &&
      (_snapshotController.hasListener || _thermalController.hasListener);

  Future<void> _maybeStopEventSubscriptions() {
    if (_snapshotController.hasListener || _thermalController.hasListener) {
      return Future<void>.value();
    }
    _eventSubscriptionsWanted = false;
    _eventSubscriptionGeneration++;
    if (!_eventSubscriptionsActive && _eventSubscriptionTransition == null) {
      return Future<void>.value();
    }
    _scheduleEventSubscriptionTransition();
    return _eventSubscriptionTransition ?? Future<void>.value();
  }

  void _scheduleEventSubscriptionTransition() {
    if (_disposed || _eventSubscriptionTransition != null) return;
    late final Future<void> transition;
    transition = _runEventSubscriptionTransition();
    _eventSubscriptionTransition = transition;
    unawaited(
      transition.then<void>(
        (_) => _finishEventSubscriptionTransition(transition),
        onError: (Object _, StackTrace _) =>
            _finishEventSubscriptionTransition(transition),
      ),
    );
  }

  void _finishEventSubscriptionTransition(Future<void> transition) {
    if (!identical(_eventSubscriptionTransition, transition)) return;
    _eventSubscriptionTransition = null;
    if (_eventSubscriptionsWanted &&
        !_eventSubscriptionsActive &&
        _canStartEventSubscriptions) {
      _scheduleEventSubscriptionTransition();
    }
  }

  Future<void> _runEventSubscriptionTransition() async {
    if (_eventSubscriptionsActive &&
        _activeEventSubscriptionGeneration == _eventSubscriptionGeneration) {
      return;
    }
    if (_eventSubscriptionsActive) {
      await _cancelEventSubscriptions();
    }
    if (!_eventSubscriptionsWanted || !_canStartEventSubscriptions) return;

    final generation = ++_eventSubscriptionGeneration;
    // EventChannel forwards listen arguments to cancel; native handlers use
    // this additive generation token to ignore a late old cancellation.
    StreamSubscription<dynamic>? thermalSubscription;
    StreamSubscription<dynamic>? lowMemorySubscription;
    try {
      thermalSubscription = _thermalChannel
          .receiveBroadcastStream(generation)
          .listen(
            (event) => _handleThermalEvent(generation, event),
            onError: (Object error) => _handleThermalError(generation, error),
          );
      lowMemorySubscription = _lowMemoryChannel
          .receiveBroadcastStream(generation)
          .listen(
            (event) => _handleLowMemoryEvent(generation, event),
            onError: (Object error) => _handleLowMemoryError(generation, error),
          );
      if (_disposed ||
          !_eventSubscriptionsWanted ||
          !_canStartEventSubscriptions ||
          generation != _eventSubscriptionGeneration) {
        await _cancelSubscriptionPair(
          thermalSubscription,
          lowMemorySubscription,
        );
        return;
      }
      _thermalSubscription = thermalSubscription;
      _lowMemorySubscription = lowMemorySubscription;
      _eventSubscriptionsActive = true;
      _activeEventSubscriptionGeneration = generation;
    } catch (_) {
      await _cancelSubscriptionPair(thermalSubscription, lowMemorySubscription);
    }
  }

  void _handleThermalEvent(int generation, Object? event) {
    if (generation != _eventSubscriptionGeneration) return;
    _thermalEventGeneration++;
    final value = event is String
        ? event
        : event is Map
        ? event['status']
        : null;
    _setSnapshot(
      _snapshot.copyWith(
        thermalStatus: thermalStatusFromPlatformName(
          value is String ? value : null,
        ),
      ),
    );
  }

  void _handleLowMemoryEvent(int generation, Object? event) {
    if (generation != _eventSubscriptionGeneration) return;
    _lowMemoryEventGeneration++;
    final value = switch (event) {
      bool boolValue => boolValue,
      num number => number != 0,
      _ => null,
    };
    _setSnapshot(_snapshot.copyWith(systemLowMemory: value));
  }

  void _handleThermalError(int generation, Object _) {
    if (generation != _eventSubscriptionGeneration) return;
    _thermalEventGeneration++;
    _setSnapshot(_snapshot.copyWith(thermalStatus: ThermalStatus.unknown));
  }

  void _handleLowMemoryError(int generation, Object _) {
    if (generation != _eventSubscriptionGeneration) return;
    _lowMemoryEventGeneration++;
    _setSnapshot(_snapshot.copyWith(systemLowMemory: null));
  }

  Future<void> _cancelEventSubscriptions() async {
    final thermalSubscription = _thermalSubscription;
    final lowMemorySubscription = _lowMemorySubscription;
    _thermalSubscription = null;
    _lowMemorySubscription = null;
    _eventSubscriptionsActive = false;
    _activeEventSubscriptionGeneration = null;
    _eventSubscriptionGeneration++;
    await _cancelSubscriptionPair(thermalSubscription, lowMemorySubscription);
  }

  Future<void> _cancelSubscriptionPair(
    StreamSubscription<dynamic>? thermalSubscription,
    StreamSubscription<dynamic>? lowMemorySubscription,
  ) async {
    await Future.wait<void>([
      if (thermalSubscription != null) _cancelSubscription(thermalSubscription),
      if (lowMemorySubscription != null)
        _cancelSubscription(lowMemorySubscription),
    ]);
  }

  Future<void> _cancelSubscription(
    StreamSubscription<dynamic> subscription,
  ) async {
    try {
      await subscription.cancel().timeout(snapshotTimeout);
    } catch (_) {}
  }

  void _setSnapshot(DeviceHealthSnapshot next) {
    if (_disposed) return;
    final previous = _snapshot;
    _snapshot = next;
    if (!_snapshotController.isClosed) _snapshotController.add(next);
    if (!_thermalController.isClosed &&
        previous.thermalStatus != next.thermalStatus) {
      _thermalController.add(next.thermalStatus);
    }
  }

  DeviceHealthSnapshot _snapshotFromPlatform(Object? raw, int? rss) {
    if (raw is! Map) return DeviceHealthSnapshot(processRssBytes: rss);
    final values = <String, Object?>{
      for (final entry in raw.entries) entry.key.toString(): entry.value,
    };
    return DeviceHealthSnapshot(
      physicalMemoryBytes: _asInt(values['physicalMemoryBytes']),
      freeStorageBytes: _asInt(values['freeStorageBytes']),
      systemLowMemory: _asBool(values['systemLowMemory']),
      thermalStatus: thermalStatusFromPlatformName(
        values['thermalStatus'] is String
            ? values['thermalStatus'] as String
            : null,
      ),
      processRssBytes: rss,
      captureSupported: _asBool(values['captureSupported']),
    );
  }

  int? _readProcessRss() {
    try {
      final value = ProcessInfo.currentRss;
      return value > 0 ? value : null;
    } catch (_) {
      return null;
    }
  }

  static int? _asInt(Object? value) {
    if (value is int) return value;
    if (value is num && value.isFinite) return value.toInt();
    return null;
  }

  static bool? _asBool(Object? value) => value is bool ? value : null;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _platformAvailable = false;
    _eventSubscriptionsWanted = false;
    _eventSubscriptionGeneration++;
    final transition = _eventSubscriptionTransition;
    Future<void> cleanup() async {
      if (transition != null) {
        try {
          await transition;
        } catch (_) {}
      }
      await _cancelEventSubscriptions();
    }

    unawaited(cleanup());
    unawaited(_snapshotController.close());
    unawaited(_thermalController.close());
  }
}

class PlatformDeviceHealthSource implements DeviceHealthSource {
  const PlatformDeviceHealthSource(this.bridge);

  final PlatformDeviceHealthBridge bridge;

  @override
  Future<DeviceHealthSnapshot> read() => bridge.read();

  @override
  Stream<DeviceHealthSnapshot> get changes => bridge.snapshotChanges;
}

class PlatformThermalSignalSource implements ThermalSignalSource {
  const PlatformThermalSignalSource(this.bridge);

  final PlatformDeviceHealthBridge bridge;

  @override
  ThermalStatus get currentStatus => bridge.currentThermalStatus;

  @override
  Stream<ThermalStatus> get changes => bridge.thermalChanges;
}

class DeviceHealthMonitor extends ChangeNotifier {
  DeviceHealthMonitor({
    required this.source,
    ThermalSignalSource? thermalSource,
    DateTime? startedAt,
  }) : thermalSource = thermalSource ?? const NoopThermalSignalSource(),
       startedAt = startedAt ?? DateTime.now() {
    _sourceSubscription = source.changes.listen(
      _onSourceSnapshot,
      onError: (Object _) =>
          _onSourceSnapshot(const DeviceHealthSnapshot.unknown()),
    );
    _thermalSubscription = this.thermalSource.changes.listen(
      _onThermalStatus,
      onError: (Object _) => _onThermalStatus(ThermalStatus.unknown),
    );
    unawaited(refresh());
  }

  final DeviceHealthSource source;
  final ThermalSignalSource thermalSource;
  final DateTime startedAt;
  late final StreamSubscription<DeviceHealthSnapshot> _sourceSubscription;
  late final StreamSubscription<ThermalStatus> _thermalSubscription;
  DeviceHealthSnapshot _snapshot = const DeviceHealthSnapshot.unknown();
  DeviceHealthSnapshot _lastSourceEvent = const DeviceHealthSnapshot.unknown();
  ThermalStatus _lastThermalEvent = ThermalStatus.unknown;
  int _sourceEventGeneration = 0;
  int _thermalEventGeneration = 0;
  Future<void>? _refreshInFlight;
  bool _disposed = false;

  DeviceHealthSnapshot get snapshot => _snapshot;

  Future<void> refresh() {
    if (_disposed) return Future<void>.value();
    final inFlight = _refreshInFlight;
    if (inFlight != null) return inFlight;
    final operation = _performRefresh();
    _refreshInFlight = operation;
    unawaited(
      operation.then<void>(
        (_) => _clearRefreshInFlight(operation),
        onError: (Object _, StackTrace _) => _clearRefreshInFlight(operation),
      ),
    );
    return operation;
  }

  Future<void> _performRefresh() async {
    if (_disposed) return;
    final sourceGeneration = _sourceEventGeneration;
    final thermalGeneration = _thermalEventGeneration;
    try {
      final next = await source.read();
      if (_disposed) return;
      var resolved = sourceGeneration == _sourceEventGeneration
          ? next
          : _lastSourceEvent.copyWith(
              processRssBytes: next.processRssBytes,
              processMemoryLimitBytes: next.processMemoryLimitBytes,
              captureSupported: next.captureSupported,
              thermalStatus: next.thermalStatus,
            );
      resolved = resolved.copyWith(
        thermalStatus: thermalGeneration != _thermalEventGeneration
            ? _lastThermalEvent
            : sourceGeneration != _sourceEventGeneration
            ? _lastSourceEvent.thermalStatus
            : thermalSource.currentStatus,
      );
      _update(resolved);
    } catch (_) {
      if (_disposed || sourceGeneration != _sourceEventGeneration) return;
      _update(
        const DeviceHealthSnapshot.unknown().copyWith(
          thermalStatus: thermalGeneration == _thermalEventGeneration
              ? thermalSource.currentStatus
              : _lastThermalEvent,
        ),
      );
    }
  }

  void _onSourceSnapshot(DeviceHealthSnapshot snapshot) {
    if (_disposed) return;
    _sourceEventGeneration++;
    _lastSourceEvent = snapshot;
    _update(snapshot);
  }

  void _onThermalStatus(ThermalStatus status) {
    if (_disposed) return;
    _thermalEventGeneration++;
    _lastThermalEvent = status;
    _update(_snapshot.copyWith(thermalStatus: status));
  }

  void _clearRefreshInFlight(Future<void> operation) {
    if (identical(_refreshInFlight, operation)) _refreshInFlight = null;
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
