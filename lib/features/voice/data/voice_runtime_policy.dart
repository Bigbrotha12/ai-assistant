import 'dart:async';

import 'package:flutter/foundation.dart';

import './device_health.dart';
import './engine_config.dart';
import './engine_manager.dart';

const int voiceMinimumPhysicalMemoryBytes = 4 * 1024 * 1024 * 1024;
const double voiceProcessMemoryWarningRatio = 0.85;

enum VoiceRuntimeLevel { ready, reduced, blocked }

enum VoiceRuntimeReason {
  unsupportedPlatform,
  invalidPhysicalMemory,
  insufficientPhysicalMemory,
  invalidFreeStorage,
  lowFreeStorage,
  sttModelUnavailable,
  ttsModelUnavailable,
  invalidProcessMemory,
  highProcessMemory,
  systemLowMemory,
  sustainedLoad,
  thermalFair,
  thermalSerious,
  sttInferenceFailure,
  ttsInferenceFailure,
}

extension VoiceRuntimeReasonCode on VoiceRuntimeReason {
  String get code => switch (this) {
    VoiceRuntimeReason.unsupportedPlatform => 'unsupported_platform',
    VoiceRuntimeReason.invalidPhysicalMemory => 'invalid_physical_memory',
    VoiceRuntimeReason.insufficientPhysicalMemory =>
      'insufficient_physical_memory',
    VoiceRuntimeReason.invalidFreeStorage => 'invalid_free_storage',
    VoiceRuntimeReason.lowFreeStorage => 'low_free_storage',
    VoiceRuntimeReason.sttModelUnavailable => 'stt_model_unavailable',
    VoiceRuntimeReason.ttsModelUnavailable => 'tts_model_unavailable',
    VoiceRuntimeReason.invalidProcessMemory => 'invalid_process_memory',
    VoiceRuntimeReason.highProcessMemory => 'high_process_memory',
    VoiceRuntimeReason.systemLowMemory => 'system_low_memory',
    VoiceRuntimeReason.sustainedLoad => 'sustained_load',
    VoiceRuntimeReason.thermalFair => 'thermal_fair',
    VoiceRuntimeReason.thermalSerious => 'thermal_serious',
    VoiceRuntimeReason.sttInferenceFailure => 'stt_inference_failure',
    VoiceRuntimeReason.ttsInferenceFailure => 'tts_inference_failure',
  };
}

class VoiceRuntimeInputs {
  const VoiceRuntimeInputs({
    this.physicalMemoryBytes,
    this.freeStorageBytes,
    this.requiredDownloadBytes,
    this.captureSupported,
    this.sttReady,
    this.ttsReady,
    this.thermalStatus = ThermalStatus.unknown,
    this.systemLowMemory,
    this.processRssBytes,
    this.processMemoryLimitBytes,
    this.sustainedLoad,
    this.recentSttInferenceFailures,
    this.recentTtsInferenceFailures,
  });

  final int? physicalMemoryBytes;
  final int? freeStorageBytes;
  final int? requiredDownloadBytes;
  final bool? captureSupported;
  final bool? sttReady;
  final bool? ttsReady;
  final ThermalStatus thermalStatus;
  final bool? systemLowMemory;
  final int? processRssBytes;
  final int? processMemoryLimitBytes;
  final bool? sustainedLoad;
  final int? recentSttInferenceFailures;
  final int? recentTtsInferenceFailures;
}

class VoiceRuntimeDecision {
  const VoiceRuntimeDecision({
    required this.allowCapture,
    required this.allowTts,
    required this.allowModelDownload,
    required this.level,
    this.reasons = const [],
  });

  static const ready = VoiceRuntimeDecision(
    allowCapture: true,
    allowTts: true,
    allowModelDownload: true,
    level: VoiceRuntimeLevel.ready,
  );

  final bool allowCapture;
  final bool allowTts;
  final bool allowModelDownload;
  final VoiceRuntimeLevel level;
  final List<VoiceRuntimeReason> reasons;

  bool get isReady => level == VoiceRuntimeLevel.ready;
  bool get isReduced => level == VoiceRuntimeLevel.reduced;
  bool get isBlocked => level == VoiceRuntimeLevel.blocked;
  bool get textChatAvailable => true;

  String? get notice {
    if (!allowCapture) {
      return 'Voice capture is unavailable on this device. Continue in text.';
    }
    if (!allowTts) {
      return 'Voice replies are paused while the device recovers. '
          'Replies remain available as text.';
    }
    if (!allowModelDownload) {
      return 'Not enough storage to download a voice model. '
          'Installed models remain usable.';
    }
    return null;
  }

  String? get captureNotice => !allowCapture ? notice : null;
  String? get ttsNotice => allowCapture && !allowTts ? notice : null;
  String? get downloadNotice =>
      allowCapture && allowTts && !allowModelDownload ? notice : null;

  bool hasReason(VoiceRuntimeReason reason) => reasons.contains(reason);

  bool get hasTransientDenial => reasons.any(
    (reason) => const {
      VoiceRuntimeReason.thermalFair,
      VoiceRuntimeReason.thermalSerious,
      VoiceRuntimeReason.systemLowMemory,
      VoiceRuntimeReason.highProcessMemory,
      VoiceRuntimeReason.sustainedLoad,
      VoiceRuntimeReason.sttInferenceFailure,
      VoiceRuntimeReason.ttsInferenceFailure,
    }.contains(reason),
  );

  @override
  bool operator ==(Object other) =>
      other is VoiceRuntimeDecision &&
      other.allowCapture == allowCapture &&
      other.allowTts == allowTts &&
      other.allowModelDownload == allowModelDownload &&
      other.level == level &&
      listEquals(other.reasons, reasons);

  @override
  int get hashCode => Object.hash(
    allowCapture,
    allowTts,
    allowModelDownload,
    level,
    Object.hashAll(reasons),
  );
}

class VoiceRuntimePolicy {
  const VoiceRuntimePolicy({
    this.minimumPhysicalMemoryBytes = voiceMinimumPhysicalMemoryBytes,
    this.downloadSafetyMarginBytes =
        EngineConfig.modelDownloadSafetyMarginBytes,
    this.processMemoryWarningRatio = voiceProcessMemoryWarningRatio,
  });

  final int minimumPhysicalMemoryBytes;
  final int downloadSafetyMarginBytes;
  final double processMemoryWarningRatio;

  VoiceRuntimeDecision evaluate(VoiceRuntimeInputs inputs) {
    var allowCapture = true;
    var allowTts = true;
    var allowModelDownload = true;
    final reasons = <VoiceRuntimeReason>[];

    void add(VoiceRuntimeReason reason) {
      if (!reasons.contains(reason)) reasons.add(reason);
    }

    if (inputs.captureSupported == false) {
      allowCapture = false;
      add(VoiceRuntimeReason.unsupportedPlatform);
    }

    final physicalMemory = inputs.physicalMemoryBytes;
    if (physicalMemory != null) {
      if (physicalMemory < 0) {
        allowCapture = false;
        add(VoiceRuntimeReason.invalidPhysicalMemory);
      } else if (physicalMemory < minimumPhysicalMemoryBytes) {
        allowCapture = false;
        add(VoiceRuntimeReason.insufficientPhysicalMemory);
      }
    }
    final freeStorage = inputs.freeStorageBytes;
    final missingBytes = inputs.requiredDownloadBytes;
    if (missingBytes != null && missingBytes < 0) {
      allowCapture = false;
      allowModelDownload = false;
      add(VoiceRuntimeReason.invalidFreeStorage);
    }
    final requiredDownload = missingBytes == null || missingBytes > 0
        ? (missingBytes ?? 0) + downloadSafetyMarginBytes
        : 0;

    if (freeStorage != null) {
      if (freeStorage < 0) {
        allowCapture = false;
        allowModelDownload = false;
        add(VoiceRuntimeReason.invalidFreeStorage);
      } else if (freeStorage < requiredDownload) {
        allowModelDownload = false;
        add(VoiceRuntimeReason.lowFreeStorage);
      }
    }

    if (inputs.sttReady == false) {
      allowCapture = false;
      add(VoiceRuntimeReason.sttModelUnavailable);
    }
    if (inputs.ttsReady == false) {
      allowTts = false;
      add(VoiceRuntimeReason.ttsModelUnavailable);
    }

    switch (inputs.thermalStatus) {
      case ThermalStatus.fair:
      case ThermalStatus.moderate:
        allowTts = false;
        add(VoiceRuntimeReason.thermalFair);
      case ThermalStatus.serious:
      case ThermalStatus.severe:
      case ThermalStatus.critical:
      case ThermalStatus.emergency:
      case ThermalStatus.shutdown:
        allowCapture = false;
        allowTts = false;
        add(VoiceRuntimeReason.thermalSerious);
      case ThermalStatus.unknown:
      case ThermalStatus.nominal:
      case ThermalStatus.light:
        break;
    }

    if (inputs.systemLowMemory == true) {
      allowCapture = false;
      allowTts = false;
      add(VoiceRuntimeReason.systemLowMemory);
    }

    final rss = inputs.processRssBytes;
    final limit = inputs.processMemoryLimitBytes;
    if ((rss != null && rss < 0) || (limit != null && limit < 0)) {
      allowCapture = false;
      add(VoiceRuntimeReason.invalidProcessMemory);
    } else if (rss != null && limit != null && limit > 0) {
      if (rss / limit >= processMemoryWarningRatio) {
        allowTts = false;
        add(VoiceRuntimeReason.highProcessMemory);
      }
    }

    if (inputs.sustainedLoad == true) {
      allowTts = false;
      add(VoiceRuntimeReason.sustainedLoad);
    }
    if ((inputs.recentSttInferenceFailures ?? 0) > 0) {
      allowCapture = false;
      add(VoiceRuntimeReason.sttInferenceFailure);
    }
    if ((inputs.recentTtsInferenceFailures ?? 0) > 0) {
      allowTts = false;
      add(VoiceRuntimeReason.ttsInferenceFailure);
    }

    final level = !allowCapture
        ? VoiceRuntimeLevel.blocked
        : !allowTts
        ? VoiceRuntimeLevel.reduced
        : VoiceRuntimeLevel.ready;
    return VoiceRuntimeDecision(
      allowCapture: allowCapture,
      allowTts: allowTts,
      allowModelDownload: allowModelDownload,
      level: level,
      reasons: reasons,
    );
  }

  static VoiceRuntimeDecision classify(
    VoiceRuntimeInputs inputs, {
    int minimumPhysicalMemoryBytes = voiceMinimumPhysicalMemoryBytes,
    int downloadSafetyMarginBytes = EngineConfig.modelDownloadSafetyMarginBytes,
    double processMemoryWarningRatio = voiceProcessMemoryWarningRatio,
  }) => VoiceRuntimePolicy(
    minimumPhysicalMemoryBytes: minimumPhysicalMemoryBytes,
    downloadSafetyMarginBytes: downloadSafetyMarginBytes,
    processMemoryWarningRatio: processMemoryWarningRatio,
  ).evaluate(inputs);
}

enum VoiceToolSource { manifest, mcp }

enum VoiceToolClassification {
  readOnlyManifest,
  mutatingManifest,
  unclassifiedManifest,
  unclassifiedMcp,
}

class VoiceToolDescriptor {
  const VoiceToolDescriptor({
    required this.id,
    required this.source,
    this.readOnly,
    this.hasRiskMetadata = false,
  });

  final String id;
  final VoiceToolSource source;
  final bool? readOnly;
  final bool hasRiskMetadata;
}

class VoiceToolCapabilityClassifier {
  const VoiceToolCapabilityClassifier();

  VoiceToolClassification classify(VoiceToolDescriptor tool) {
    if (tool.source == VoiceToolSource.mcp) {
      return VoiceToolClassification.unclassifiedMcp;
    }
    if (!tool.hasRiskMetadata || tool.readOnly == null) {
      return VoiceToolClassification.unclassifiedManifest;
    }
    return tool.readOnly!
        ? VoiceToolClassification.readOnlyManifest
        : VoiceToolClassification.mutatingManifest;
  }

  List<VoiceToolClassification> classifyAll(
    Iterable<VoiceToolDescriptor> tools,
  ) => tools.map(classify).toList(growable: false);
}

abstract interface class VoiceRuntimePolicySource {
  VoiceRuntimeDecision get decision;

  void addListener(VoidCallback listener);

  void removeListener(VoidCallback listener);

  Future<void> refreshHealth();

  void recordLoadStarted();

  void recordLoadFinished();

  void recordSttInferenceFailure();

  void recordSttInferenceSuccess();

  void recordTtsInferenceFailure();

  void recordTtsInferenceSuccess();
}

class StaticVoiceRuntimePolicySource extends ChangeNotifier
    implements VoiceRuntimePolicySource {
  StaticVoiceRuntimePolicySource([this._decision = VoiceRuntimeDecision.ready]);

  VoiceRuntimeDecision _decision;

  @override
  VoiceRuntimeDecision get decision => _decision;

  void setDecision(VoiceRuntimeDecision next) {
    if (next == _decision) return;
    _decision = next;
    notifyListeners();
  }

  @override
  Future<void> refreshHealth() async {}

  @override
  void recordLoadStarted() {}

  @override
  void recordLoadFinished() {}

  @override
  void recordSttInferenceFailure() {}

  @override
  void recordSttInferenceSuccess() {}

  @override
  void recordTtsInferenceFailure() {}

  @override
  void recordTtsInferenceSuccess() {}
}

class VoiceRuntimePolicyController extends ChangeNotifier
    implements VoiceRuntimePolicySource {
  VoiceRuntimePolicyController({
    required this.healthMonitor,
    required this.engineManager,
    this.evaluator = const VoiceRuntimePolicy(),
    this.recoveryDuration = const Duration(minutes: 2),
    this.sustainedLoadThreshold = const Duration(seconds: 30),
  }) : _healthSnapshot = healthMonitor.snapshot,
       _modelReadiness = engineManager.modelReadiness,
       _decision = evaluator.evaluate(
         VoiceRuntimeInputs(
           physicalMemoryBytes: healthMonitor.snapshot.physicalMemoryBytes,
           freeStorageBytes: healthMonitor.snapshot.freeStorageBytes,
           captureSupported: healthMonitor.snapshot.captureSupported,
           sttReady: engineManager.modelReadiness?.sttReady,
           ttsReady: engineManager.modelReadiness?.ttsReady,
           thermalStatus: healthMonitor.snapshot.thermalStatus,
           systemLowMemory: healthMonitor.snapshot.systemLowMemory,
           processRssBytes: healthMonitor.snapshot.processRssBytes,
           processMemoryLimitBytes:
               healthMonitor.snapshot.processMemoryLimitBytes,
           requiredDownloadBytes:
               engineManager.modelReadiness?.requiredDownloadBytes,
         ),
       ) {
    healthMonitor.addListener(_healthChanged);
    engineManager.addListener(_engineChanged);
  }

  final DeviceHealthMonitor healthMonitor;
  final EngineManager engineManager;
  final VoiceRuntimePolicy evaluator;
  final Duration recoveryDuration;
  final Duration sustainedLoadThreshold;

  DeviceHealthSnapshot _healthSnapshot;
  VoiceModelReadiness? _modelReadiness;
  late VoiceRuntimeDecision _decision;
  VoiceRuntimeDecision? _pendingRecovery;
  VoiceRuntimeDecision? _lastRawDecision;
  Timer? _recoveryTimer;
  Timer? _sttFailureTimer;
  Timer? _ttsFailureTimer;
  Timer? _sustainedLoadTimer;
  bool _sustainedLoad = false;
  int _activeLoadCount = 0;
  int _sttFailures = 0;
  int _ttsFailures = 0;
  bool? _forcedSustainedLoad;
  bool _disposed = false;

  @override
  VoiceRuntimeDecision get decision => _decision;

  VoiceRuntimeDecision get currentDecision => _decision;

  VoiceModelReadiness? get modelReadiness => _modelReadiness;

  @override
  Future<void> refreshHealth() => healthMonitor.refresh();

  void _healthChanged() {
    _healthSnapshot = healthMonitor.snapshot;
    _recompute();
  }

  void _engineChanged() {
    _modelReadiness = engineManager.modelReadiness;
    _recompute();
  }

  void updateHealthSnapshot(DeviceHealthSnapshot snapshot) {
    _healthSnapshot = snapshot;
    _recompute();
  }

  void updateModelReadiness(VoiceModelReadiness? readiness) {
    _modelReadiness = readiness;
    _recompute();
  }

  void _recompute() {
    if (_disposed) return;
    final next = evaluator.evaluate(
      VoiceRuntimeInputs(
        physicalMemoryBytes: _healthSnapshot.physicalMemoryBytes,
        freeStorageBytes: _healthSnapshot.freeStorageBytes,
        captureSupported: _healthSnapshot.captureSupported,
        sttReady: _modelReadiness?.sttReady,
        ttsReady: _modelReadiness?.ttsReady,
        thermalStatus: _healthSnapshot.thermalStatus,
        systemLowMemory: _healthSnapshot.systemLowMemory,
        processRssBytes: _healthSnapshot.processRssBytes,
        processMemoryLimitBytes: _healthSnapshot.processMemoryLimitBytes,
        requiredDownloadBytes: _modelReadiness?.requiredDownloadBytes,
        sustainedLoad: _forcedSustainedLoad ?? _sustainedLoad,
        recentSttInferenceFailures: _sttFailures,
        recentTtsInferenceFailures: _ttsFailures,
      ),
    );
    if (_lastRawDecision == next) return;
    _lastRawDecision = next;
    if (next == _decision) {
      _recoveryTimer?.cancel();
      _recoveryTimer = null;
      _pendingRecovery = null;
      return;
    }
    if (next.level == VoiceRuntimeLevel.ready &&
        _decision.level != VoiceRuntimeLevel.ready &&
        (_decision.hasTransientDenial || next.hasTransientDenial)) {
      _scheduleRecovery(next);
      return;
    }
    _recoveryTimer?.cancel();
    _recoveryTimer = null;
    _pendingRecovery = null;
    _setDecision(next);
  }

  void _scheduleRecovery(VoiceRuntimeDecision next) {
    _pendingRecovery = next;
    _recoveryTimer?.cancel();
    if (recoveryDuration <= Duration.zero) {
      _setDecision(next);
      return;
    }
    _recoveryTimer = Timer(recoveryDuration, () {
      _recoveryTimer = null;
      final pending = _pendingRecovery;
      _pendingRecovery = null;
      if (!_disposed && pending != null) _setDecision(pending);
    });
  }

  void _setDecision(VoiceRuntimeDecision next) {
    if (_disposed || next == _decision) return;
    _decision = next;
    notifyListeners();
  }

  void setSustainedLoad(bool value) {
    _forcedSustainedLoad = value;
    _recompute();
  }

  @override
  void recordLoadStarted() {
    if (_disposed) return;
    _activeLoadCount++;
    if (_activeLoadCount == 1) {
      if (sustainedLoadThreshold <= Duration.zero) {
        _sustainedLoad = true;
      } else {
        _sustainedLoadTimer = Timer(sustainedLoadThreshold, () {
          _sustainedLoadTimer = null;
          if (_disposed || _activeLoadCount == 0) return;
          _sustainedLoad = true;
          _recompute();
        });
      }
    }
    _recompute();
  }

  @override
  void recordLoadFinished() {
    if (_disposed) return;
    if (_activeLoadCount > 0) _activeLoadCount--;
    if (_activeLoadCount == 0) {
      _sustainedLoadTimer?.cancel();
      _sustainedLoadTimer = null;
      _sustainedLoad = false;
    }
    _recompute();
  }

  @override
  void recordSttInferenceFailure() {
    _sttFailures++;
    _sttFailureTimer?.cancel();
    _sttFailureTimer = Timer(recoveryDuration, () {
      _sttFailureTimer = null;
      if (_disposed) return;
      _sttFailures = 0;
      _recompute();
    });
    _recompute();
  }

  @override
  void recordSttInferenceSuccess() {
    _sttFailureTimer?.cancel();
    _sttFailureTimer = null;
    _sttFailures = 0;
    _recompute();
  }

  @override
  void recordTtsInferenceFailure() {
    _ttsFailures++;
    _ttsFailureTimer?.cancel();
    _ttsFailureTimer = Timer(recoveryDuration, () {
      _ttsFailureTimer = null;
      if (_disposed) return;
      _ttsFailures = 0;
      _recompute();
    });
    _recompute();
  }

  @override
  void recordTtsInferenceSuccess() {
    _ttsFailureTimer?.cancel();
    _ttsFailureTimer = null;
    _ttsFailures = 0;
    _recompute();
  }

  void recoverNow() {
    _recoveryTimer?.cancel();
    _recoveryTimer = null;
    final pending = _pendingRecovery;
    _pendingRecovery = null;
    if (pending != null) _setDecision(pending);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _recoveryTimer?.cancel();
    _sttFailureTimer?.cancel();
    _ttsFailureTimer?.cancel();
    _sustainedLoadTimer?.cancel();
    healthMonitor.removeListener(_healthChanged);
    engineManager.removeListener(_engineChanged);
    super.dispose();
  }
}
