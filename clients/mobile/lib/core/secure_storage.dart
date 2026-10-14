import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Shared default [FlutterSecureStorage] construction used by every secure
/// store. The iOS keychain items are scoped to this device
/// (`first_unlock_this_device`) so they never sync across devices.
FlutterSecureStorage defaultSecureStorage() =>
    const FlutterSecureStorage(
      aOptions: AndroidOptions(),
      iOptions: IOSOptions(
        accessibility: KeychainAccessibility.first_unlock_this_device,
      ),
    );
