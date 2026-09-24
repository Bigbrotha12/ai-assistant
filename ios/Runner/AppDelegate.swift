import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var deviceHealthChannelHandler: DeviceHealthChannelHandler?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    deviceHealthChannelHandler?.dispose()
    deviceHealthChannelHandler = DeviceHealthChannelHandler(
      messenger: engineBridge.applicationRegistrar.messenger()
    )
  }

  deinit {
    deviceHealthChannelHandler?.dispose()
  }
}

private final class DeviceHealthChannelHandler: NSObject {
  private let methodChannel: FlutterMethodChannel
  private let thermalChannel: FlutterEventChannel
  private let lowMemoryChannel: FlutterEventChannel
  private var thermalStreamHandler: DeviceHealthEventStreamHandler!
  private var lowMemoryStreamHandler: DeviceHealthEventStreamHandler!
  private var thermalSink: FlutterEventSink?
  private var lowMemorySink: FlutterEventSink?
  private var thermalSubscriptionGeneration: Int?
  private var lowMemorySubscriptionGeneration: Int?
  private var observers: [NSObjectProtocol] = []
  private var systemLowMemory = false
  // iOS has no readable low-memory flag; a snapshot or short reset re-evaluates
  // the warning latch, matching Android's fresh memory read.
  private let lowMemoryResetDelay: TimeInterval = 2.0
  private var lowMemoryResetWorkItem: DispatchWorkItem?
  private var disposed = false

  init(messenger: FlutterBinaryMessenger) {
    methodChannel = FlutterMethodChannel(
      name: "dev.bigbrotha.ai_assistant/voice/device_health",
      binaryMessenger: messenger
    )
    thermalChannel = FlutterEventChannel(
      name: "dev.bigbrotha.ai_assistant/voice/device_health/thermal",
      binaryMessenger: messenger
    )
    lowMemoryChannel = FlutterEventChannel(
      name: "dev.bigbrotha.ai_assistant/voice/device_health/low_memory",
      binaryMessenger: messenger
    )
    super.init()

    methodChannel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard call.method == "getSnapshot" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(self.snapshot())
    }
    thermalStreamHandler = DeviceHealthEventStreamHandler(
      onListen: { [weak self] arguments, eventSink in
        guard let self, !self.disposed else { return }
        self.thermalSubscriptionGeneration = self.subscriptionGeneration(arguments)
        self.thermalSink = eventSink
        eventSink(self.thermalStatusName())
      },
      onCancel: { [weak self] arguments in
        guard let self, !self.disposed else { return }
        guard self.thermalSubscriptionGeneration
          == self.subscriptionGeneration(arguments) else { return }
        self.thermalSink = nil
        self.thermalSubscriptionGeneration = nil
      }
    )
    lowMemoryStreamHandler = DeviceHealthEventStreamHandler(
      onListen: { [weak self] arguments, eventSink in
        guard let self, !self.disposed else { return }
        self.lowMemorySubscriptionGeneration = self.subscriptionGeneration(arguments)
        self.lowMemorySink = eventSink
        eventSink(self.systemLowMemory)
      },
      onCancel: { [weak self] arguments in
        guard let self, !self.disposed else { return }
        guard self.lowMemorySubscriptionGeneration
          == self.subscriptionGeneration(arguments) else { return }
        self.lowMemorySink = nil
        self.lowMemorySubscriptionGeneration = nil
      }
    )
    thermalChannel.setStreamHandler(thermalStreamHandler)
    lowMemoryChannel.setStreamHandler(lowMemoryStreamHandler)
    installObservers()
  }

  deinit {
    dispose()
  }

  func dispose() {
    guard !disposed else { return }
    disposed = true
    methodChannel.setMethodCallHandler(nil)
    thermalChannel.setStreamHandler(nil)
    lowMemoryChannel.setStreamHandler(nil)
    thermalSink = nil
    lowMemorySink = nil
    thermalSubscriptionGeneration = nil
    lowMemorySubscriptionGeneration = nil
    lowMemoryResetWorkItem?.cancel()
    lowMemoryResetWorkItem = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
  }

  private func installObservers() {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        self.systemLowMemory = true
        self.lowMemorySink?(true)
        self.scheduleLowMemoryReset()
      }
    )
    if #available(iOS 11.0, *) {
      observers.append(
        center.addObserver(
          forName: ProcessInfo.thermalStateDidChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          guard let self else { return }
          self.thermalSink?(self.thermalStatusName())
        }
      )
    }
  }

  private func subscriptionGeneration(_ arguments: Any?) -> Int? {
    if let value = arguments as? Int {
      return value
    }
    if let value = arguments as? NSNumber {
      return value.intValue
    }
    return nil
  }

  private func scheduleLowMemoryReset() {
    lowMemoryResetWorkItem?.cancel()
    let workItem = DispatchWorkItem { [weak self] in
      self?.clearLowMemory()
    }
    lowMemoryResetWorkItem = workItem
    DispatchQueue.main.asyncAfter(
      deadline: .now() + lowMemoryResetDelay,
      execute: workItem
    )
  }

  private func clearLowMemory() {
    guard !disposed else { return }
    lowMemoryResetWorkItem?.cancel()
    lowMemoryResetWorkItem = nil
    guard systemLowMemory else { return }
    systemLowMemory = false
    lowMemorySink?(false)
  }

  private func snapshot() -> [String: Any] {
    clearLowMemory()
    var values: [String: Any] = [
      "physicalMemoryBytes": Int(ProcessInfo.processInfo.physicalMemory),
      "systemLowMemory": systemLowMemory,
      "thermalStatus": thermalStatusName(),
    ]
    if let freeStorageBytes = availableStorageBytes() {
      values["freeStorageBytes"] = freeStorageBytes
    }
    return values
  }

  private func availableStorageBytes() -> Int? {
    guard #available(iOS 11.0, *) else { return nil }
    let documentsURL = FileManager.default.urls(
      for: .documentDirectory,
      in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSHomeDirectory())
    do {
      let values = try documentsURL.resourceValues(
        forKeys: [.volumeAvailableCapacityForImportantUsageKey]
      )
      guard let capacity = values.volumeAvailableCapacityForImportantUsage else {
        return nil
      }
      return Int(capacity)
    } catch {
      return nil
    }
  }

  private func thermalStatusName() -> String {
    guard #available(iOS 11.0, *) else { return "unknown" }
    return currentThermalStatusName()
  }

  @available(iOS 11.0, *)
  private func currentThermalStatusName() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal:
      return "nominal"
    case .fair:
      return "fair"
    case .serious:
      return "serious"
    case .critical:
      return "critical"
    @unknown default:
      return "unknown"
    }
  }
}

private final class DeviceHealthEventStreamHandler: NSObject, FlutterStreamHandler {
  private let onListen: (Any?, FlutterEventSink) -> Void
  private let onCancelHandler: (Any?) -> Void

  init(
    onListen: @escaping (Any?, FlutterEventSink) -> Void,
    onCancel: @escaping (Any?) -> Void
  ) {
    self.onListen = onListen
    self.onCancelHandler = onCancel
    super.init()
  }

  func onListen(
    withArguments arguments: Any?,
    eventSink: @escaping FlutterEventSink
  ) -> FlutterError? {
    onListen(arguments, eventSink)
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    onCancelHandler(arguments)
    return nil
  }
}
