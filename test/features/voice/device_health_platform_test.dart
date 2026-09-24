import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/device_health.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const methodChannel = MethodChannel(deviceHealthMethodChannelName);
  const thermalChannel = EventChannel(deviceHealthThermalEventChannelName);
  const lowMemoryChannel = EventChannel(deviceHealthLowMemoryEventChannelName);

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(methodChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(thermalChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(lowMemoryChannel, null);
  });

  test(
    'maps the snapshot method and forwards thermal and low-memory events',
    () async {
      final calls = <MethodCall>[];
      Object? thermalArguments;
      Object? lowMemoryArguments;
      late MockStreamHandlerEventSink thermalEvents;
      late MockStreamHandlerEventSink lowMemoryEvents;

      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) async {
            calls.add(call);
            return <String, Object?>{
              'physicalMemoryBytes': 8 * 1024 * 1024 * 1024,
              'freeStorageBytes': 123456789,
              'systemLowMemory': false,
              'thermalStatus': 'nominal',
            };
          });
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            thermalChannel,
            MockStreamHandler.inline(
              onListen: (arguments, events) {
                thermalArguments = arguments;
                thermalEvents = events;
              },
            ),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            lowMemoryChannel,
            MockStreamHandler.inline(
              onListen: (arguments, events) {
                lowMemoryArguments = arguments;
                lowMemoryEvents = events;
              },
            ),
          );

      final bridge = PlatformDeviceHealthBridge(
        methodChannel: methodChannel,
        thermalChannel: thermalChannel,
        lowMemoryChannel: lowMemoryChannel,
        eventStreamsEnabled: true,
      );
      final source = PlatformDeviceHealthSource(bridge);
      final thermal = PlatformThermalSignalSource(bridge);
      final snapshots = <DeviceHealthSnapshot>[];
      final thermalStatuses = <ThermalStatus>[];
      final snapshotSubscription = source.changes.listen(snapshots.add);
      final thermalSubscription = thermal.changes.listen(thermalStatuses.add);
      addTearDown(() async {
        await snapshotSubscription.cancel();
        await thermalSubscription.cancel();
        bridge.dispose();
      });

      final snapshot = await source.read();
      await pumpEventQueue();

      expect(calls, hasLength(1));
      expect(calls.single.method, 'getSnapshot');
      expect(calls.single.arguments, isNull);
      expect(snapshot.physicalMemoryBytes, 8 * 1024 * 1024 * 1024);
      expect(snapshot.freeStorageBytes, 123456789);
      expect(snapshot.systemLowMemory, isFalse);
      expect(snapshot.thermalStatus, ThermalStatus.nominal);
      expect(thermal.currentStatus, ThermalStatus.nominal);
      expect(thermalArguments, isA<int>());
      expect(lowMemoryArguments, thermalArguments);

      thermalEvents.success('SERIOUS');
      lowMemoryEvents.success(true);
      await pumpEventQueue();

      expect(thermal.currentStatus, ThermalStatus.serious);
      expect(thermalStatuses, contains(ThermalStatus.serious));
      expect(snapshots.last.systemLowMemory, isTrue);
      expect(snapshots.last.thermalStatus, ThermalStatus.serious);

      lowMemoryEvents.success(false);
      await pumpEventQueue();
      expect(snapshots.last.systemLowMemory, isFalse);
    },
  );

  test('missing method handler resolves to unknown without throwing', () async {
    final bridge = PlatformDeviceHealthBridge(eventStreamsEnabled: false);
    final source = PlatformDeviceHealthSource(bridge);
    final thermal = PlatformThermalSignalSource(bridge);
    addTearDown(bridge.dispose);

    final snapshot = await source.read();

    expect(snapshot.physicalMemoryBytes, isNull);
    expect(snapshot.freeStorageBytes, isNull);
    expect(snapshot.systemLowMemory, isNull);
    expect(snapshot.thermalStatus, ThermalStatus.unknown);
    expect(thermal.currentStatus, ThermalStatus.unknown);
  });

  test('event errors downgrade their signal to unknown', () async {
    late MockStreamHandlerEventSink thermalEvents;
    late MockStreamHandlerEventSink lowMemoryEvents;

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          methodChannel,
          (call) async => <String, Object?>{
            'physicalMemoryBytes': 8 * 1024 * 1024 * 1024,
            'freeStorageBytes': 123456789,
            'systemLowMemory': false,
            'thermalStatus': 'nominal',
          },
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(
          thermalChannel,
          MockStreamHandler.inline(
            onListen: (arguments, events) => thermalEvents = events,
          ),
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(
          lowMemoryChannel,
          MockStreamHandler.inline(
            onListen: (arguments, events) => lowMemoryEvents = events,
          ),
        );

    final bridge = PlatformDeviceHealthBridge(
      methodChannel: methodChannel,
      thermalChannel: thermalChannel,
      lowMemoryChannel: lowMemoryChannel,
      eventStreamsEnabled: true,
    );
    final source = PlatformDeviceHealthSource(bridge);
    final thermal = PlatformThermalSignalSource(bridge);
    var latestSnapshot = const DeviceHealthSnapshot.unknown();
    final snapshotSubscription = source.changes.listen((next) {
      latestSnapshot = next;
    });
    final thermalSubscription = thermal.changes.listen((_) {});
    addTearDown(() async {
      await snapshotSubscription.cancel();
      await thermalSubscription.cancel();
      bridge.dispose();
    });

    await source.read();
    await pumpEventQueue();
    thermalEvents.error(code: 'thermal_unavailable');
    lowMemoryEvents.error(code: 'memory_unavailable');
    await pumpEventQueue();

    expect(thermal.currentStatus, ThermalStatus.unknown);
    expect(latestSnapshot.thermalStatus, ThermalStatus.unknown);
    expect(latestSnapshot.systemLowMemory, isNull);
  });
}
