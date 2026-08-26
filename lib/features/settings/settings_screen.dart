import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/backend_probe.dart';
import '../../core/backend_settings.dart';
import '../../core/config.dart';
import '../../core/probe_providers.dart';
import '../../core/settings_providers.dart';

/// App home screen: configure and verify connectivity to the self-hosted
/// backend stack (token-mint, LiveKit, LLM proxy).
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _hostController = TextEditingController();
  final _secretController = TextEditingController();

  bool _obscureSecret = true;
  bool _probing = false;
  bool _didAutoProbe = false;
  BackendStatus? _status;

  /// Guards controller listeners until after [initState], when a setState()
  /// triggered by the initial field population is no longer needed.
  bool _formListenersActive = false;

  @override
  void initState() {
    super.initState();
    _hostController.addListener(_onFormChanged);
    _secretController.addListener(_onFormChanged);
    _handleSettings(ref.read(settingsProvider));
    _formListenersActive = true;
  }

  /// Rebuilds on text edits so host validation and button enabled states stay
  /// in sync with what the user typed.
  void _onFormChanged() {
    if (_formListenersActive) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    _hostController.removeListener(_onFormChanged);
    _secretController.removeListener(_onFormChanged);
    _hostController.dispose();
    _secretController.dispose();
    super.dispose();
  }

  /// Validates the host field, returning an error message or null when the
  /// host is usable as a URI authority (no scheme, path, whitespace, or other
  /// invalid characters).
  String? _hostError(String host) {
    final trimmed = host.trim();
    if (trimmed.isEmpty) {
      return 'Enter the backend host';
    }
    if (RegExp(r'\s').hasMatch(trimmed)) {
      return 'Host must not contain whitespace';
    }
    if (trimmed.contains('://') || trimmed.contains('/')) {
      return 'Enter a host name, not a URL';
    }
    if (RegExp(r'[^a-zA-Z0-9.\-:]').hasMatch(trimmed)) {
      return 'Host contains invalid characters';
    }
    return null;
  }

  /// Fills the text controllers from [settings] unless the user already
  /// started editing.
  void _populateControllers(BackendSettings settings) {
    if (_hostController.text.isEmpty) {
      _hostController.text = settings.host;
    }
    if (_secretController.text.isEmpty) {
      _secretController.text = settings.secret;
    }
  }

  /// Runs the probe once against the freshly loaded saved settings, unless a
  /// probe already ran (or the settings are unusable).
  void _maybeAutoProbe(BackendSettings? settings) {
    if (_didAutoProbe || settings == null || !settings.isValid) {
      return;
    }
    _didAutoProbe = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _runProbe(settings);
      }
    });
  }

  Future<void> _runProbe(BackendSettings settings) async {
    // Any user-initiated probe (Test or Save) suppresses the follow-up
    // auto-probe that the settings listener would otherwise schedule.
    _didAutoProbe = true;
    setState(() {
      _probing = true;
      _status = null;
    });
    final status = await ref.read(backendProbeProvider).probe(settings);
    if (!mounted) return;
    setState(() {
      _probing = false;
      _status = status;
    });
  }

  Future<void> _testConnection() async {
    await _runProbe(BackendSettings(
      host: _hostController.text,
      secret: _secretController.text,
    ));
  }

  Future<void> _save() async {
    final settings = BackendSettings(
      host: _hostController.text,
      secret: _secretController.text,
    );
    // Saving is a user-initiated probe; make sure the settings-listener's
    // follow-up auto-probe is suppressed even if it fires before [_runProbe].
    _didAutoProbe = true;
    try {
      await ref.read(settingsProvider.notifier).save(settings);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not save settings')),
      );
      return;
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Settings saved')),
    );
    await _runProbe(settings);
  }

  /// Reacts to the persisted-settings provider: prefills the form from saved
  /// values (falling back to the dart-define defaults) and auto-runs the probe.
  void _onSettingsChanged(
    AsyncValue<BackendSettings?>? previous,
    AsyncValue<BackendSettings?> next,
  ) {
    _handleSettings(next);
  }

  void _handleSettings(AsyncValue<BackendSettings?> value) {
    final fallback = BackendSettings(
      host: BackendConfig.defaultHost,
      secret: BackendConfig.defaultSecret,
    );
    value.when(
      data: (settings) {
        _populateControllers(settings ?? fallback);
        _maybeAutoProbe(settings);
      },
      error: (_, _) => _populateControllers(fallback),
      loading: () {},
    );
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    ref.listen(settingsProvider, _onSettingsChanged);

    final isLoading = settingsAsync.isLoading;
    final hostText = _hostController.text;
    final secretText = _secretController.text;
    final hostError = _hostError(hostText);
    final formValid =
        BackendSettings(host: hostText, secret: secretText).isValid;
    final canTest = !isLoading && !_probing && hostError == null;
    // Save requires a structurally valid host AND a non-blank secret, so an
    // invalid configuration is never persisted.
    final canSave = canTest && formValid;

    return Scaffold(
      appBar: AppBar(title: const Text('AI Assistant')),
      body: Column(
        children: [
          if (isLoading) const LinearProgressIndicator(minHeight: 2),
          if (settingsAsync.hasError) const _SettingsLoadErrorBanner(),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                TextField(
                  controller: _hostController,
                  enabled: !isLoading,
                  decoration: InputDecoration(
                    labelText: 'Backend host',
                    hintText: 'tailnet IP or MagicDNS name',
                    border: const OutlineInputBorder(),
                    errorText: hostError,
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _secretController,
                  enabled: !isLoading,
                  obscureText: _obscureSecret,
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: TextInputType.visiblePassword,
                  decoration: InputDecoration(
                    labelText: 'Shared secret',
                    border: const OutlineInputBorder(),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureSecret
                            ? Icons.visibility_off
                            : Icons.visibility,
                      ),
                      tooltip: _obscureSecret ? 'Show secret' : 'Hide secret',
                      onPressed: () =>
                          setState(() => _obscureSecret = !_obscureSecret),
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton(
                        onPressed: canTest ? _testConnection : null,
                        child: const Text('Test connection'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: canSave ? _save : null,
                        child: const Text('Save'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
                _buildResults(context),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Probe status section: spinner while running, per-check rows otherwise.
  Widget _buildResults(BuildContext context) {
    final theme = Theme.of(context);
    if (_probing) {
      return Column(
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 12),
          Text('Checking backend…', style: theme.textTheme.bodyMedium),
        ],
      );
    }
    final status = _status;
    if (status == null) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final check in BackendCheck.values)
          if (status.resultFor(check) case final result?)
            _CheckRow(result: result, label: check.label),
        const SizedBox(height: 12),
        Text(
          status.allOk
              ? 'All backend services reachable'
              : 'Some backend services are unavailable',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: status.allOk
                ? Colors.green.shade700
                : theme.colorScheme.error,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

/// Inline MaterialBanner-style notice shown when saved settings could not be
/// loaded (e.g. secure storage unavailable); the form stays usable.
class _SettingsLoadErrorBanner extends StatelessWidget {
  const _SettingsLoadErrorBanner();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Icon(Icons.error_outline, color: scheme.onErrorContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Could not load saved settings',
                style: TextStyle(color: scheme.onErrorContainer),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Single probe result row: status icon, check label, and detail text.
class _CheckRow extends StatelessWidget {
  const _CheckRow({required this.result, required this.label});

  final CheckResult result;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, color) = switch (result.status) {
      ProbeStatus.ok => (Icons.check_circle, Colors.green.shade600),
      ProbeStatus.error => (Icons.error, Colors.orange.shade800),
      ProbeStatus.unreachable => (Icons.cloud_off, Colors.grey.shade600),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: theme.textTheme.bodyLarge),
                Text(
                  result.detail,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}