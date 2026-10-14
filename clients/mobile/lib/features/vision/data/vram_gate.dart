import 'dart:io' show File;

/// Simple VRAM headroom gate. Checks a text file path for an integer (MB).
/// Returns true only when the measured headroom >= [threshold] MB.
/// If the file is missing, unreadable, or contains a value below threshold, returns false.
abstract interface class VRAMGate {
  Future<bool> hasHeadroom({int thresholdMB = 4096});
}

/// Reads `/proc/meminfo` to estimate free system memory as a proxy for VRAM headroom.
/// Real VRAM measurement is a backend concern; this is a client-side safety valve.
class LinuxVRAMGate implements VRAMGate {
  LinuxVRAMGate({this.meminfoPath = '/proc/meminfo'});

  final String meminfoPath;

  @override
  Future<bool> hasHeadroom({int thresholdMB = 4096}) async {
    try {
      final file = File(meminfoPath);
      if (!await file.exists()) return false;
      final lines = await file.readAsLines();
      for (final line in lines) {
        if (line.startsWith('MemAvailable:')) {
          final parts = line.split(RegExp(r'\s+'));
          if (parts.length >= 2) {
            final kb = int.tryParse(parts[1]);
            if (kb != null) {
              final mb = kb / 1024;
              return mb >= thresholdMB;
            }
          }
        }
      }
    } catch (_) {
      // Fall through to false.
    }
    return false;
  }
}

/// Always-true gate for development / web.
class NoOpVRAMGate implements VRAMGate {
  const NoOpVRAMGate();
  @override
  Future<bool> hasHeadroom({int thresholdMB = 4096}) async => true;
}