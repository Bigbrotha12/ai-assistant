import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/backend_probe.dart';
import '../../core/backend_settings.dart';
import '../../core/config.dart';
import '../../core/files_providers.dart';
import '../../core/files_service.dart';
import '../../core/probe_providers.dart';
import '../../core/settings_providers.dart';
import '../../core/theme_providers.dart';
import '../attachments/files_screen.dart';

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
  final _mcpSecretController = TextEditingController();
  final _filesSecretController = TextEditingController();
  final _storageUrlController = TextEditingController();

  bool _obscureSecret = true;
  bool _obscureMcpSecret = true;
  bool _obscureFilesSecret = true;
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
    _mcpSecretController.addListener(_onFormChanged);
    _filesSecretController.addListener(_onFormChanged);
    _storageUrlController.addListener(_onFormChanged);
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
    _mcpSecretController.removeListener(_onFormChanged);
    _filesSecretController.removeListener(_onFormChanged);
    _storageUrlController.removeListener(_onFormChanged);
    _hostController.dispose();
    _secretController.dispose();
    _mcpSecretController.dispose();
    _filesSecretController.dispose();
    _storageUrlController.dispose();
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

  String? _storageUrlError(String url) {
    final trimmed = url.trim();
    if (trimmed.isEmpty) return null;
    try {
      final uri = Uri.parse(trimmed);
      if (uri.scheme.isEmpty || uri.host.isEmpty) {
        return 'Enter a full URL (e.g. http://host:port)';
      }
    } catch (_) {
      return 'Invalid URL';
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
    if (_mcpSecretController.text.isEmpty) {
      _mcpSecretController.text = settings.mcpSecret ?? '';
    }
    if (_filesSecretController.text.isEmpty) {
      _filesSecretController.text = settings.filesSecret ?? '';
    }
    if (_storageUrlController.text.isEmpty) {
      _storageUrlController.text = settings.storageUrl ?? '';
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
    await _runProbe(_settingsFromForm());
  }

  BackendSettings _settingsFromForm() => BackendSettings(
        host: _hostController.text,
        secret: _secretController.text,
        mcpSecret: _mcpSecretController.text,
        filesSecret: _filesSecretController.text,
        storageUrl: _storageUrlController.text,
      );

  Future<void> _save() async {
    final settings = _settingsFromForm();
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

  /// Confirms and clears all saved settings (host, secret, MCP, files token, storage URL).
  Future<void> _clearSettings() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear settings'),
        content: const Text('Clear saved host, secret, MCP token, files token, and storage URL?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
      setState(() {
        _hostController.clear();
        _secretController.clear();
        _mcpSecretController.clear();
        _filesSecretController.clear();
        _storageUrlController.clear();
      });
    await ref.read(settingsProvider.notifier).clear();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Settings cleared')),
    );
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
    final storageUrlError = _storageUrlError(_storageUrlController.text);
    final formValid =
        BackendSettings(host: hostText, secret: secretText).isValid;
    final canTest = !isLoading && !_probing && hostError == null && storageUrlError == null;
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
                const SizedBox(height: 16),
                TextField(
                  controller: _mcpSecretController,
                  enabled: !isLoading,
                  obscureText: _obscureMcpSecret,
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: TextInputType.visiblePassword,
                  decoration: InputDecoration(
                    labelText: 'MCP token (optional)',
                    hintText: 'voice-mcp bearer token (Phase 4)',
                    border: const OutlineInputBorder(),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureMcpSecret
                            ? Icons.visibility_off
                            : Icons.visibility,
                      ),
                      tooltip: _obscureMcpSecret
                          ? 'Show MCP token'
                          : 'Hide MCP token',
                      onPressed: () =>
                          setState(() => _obscureMcpSecret = !_obscureMcpSecret),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _filesSecretController,
                  enabled: !isLoading,
                  obscureText: _obscureFilesSecret,
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: TextInputType.visiblePassword,
                  decoration: InputDecoration(
                    labelText: 'Files token (optional)',
                    hintText: 'files service bearer token',
                    border: const OutlineInputBorder(),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureFilesSecret
                            ? Icons.visibility_off
                            : Icons.visibility,
                      ),
                      tooltip: _obscureFilesSecret
                          ? 'Show files token'
                          : 'Hide files token',
                      onPressed: () => setState(
                          () => _obscureFilesSecret = !_obscureFilesSecret),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text('Storage', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 8),
                TextField(
                  controller: _storageUrlController,
                  enabled: !isLoading,
                  decoration: InputDecoration(
                    labelText: 'Storage service URL (optional)',
                    hintText: 'e.g. http://minio:9000',
                    border: const OutlineInputBorder(),
                    helperText: 'Leave blank to use <host>:17603',
                    errorText: _storageUrlError(_storageUrlController.text),
                  ),
                  keyboardType: TextInputType.url,
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
                const SizedBox(height: 32),
                _buildFiles(context),
                const SizedBox(height: 32),
                _buildDangerZone(context),
                const SizedBox(height: 32),
                _buildAppearance(context),
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
        ExpansionTile(
          initiallyExpanded: false,
          title: Text(
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
          children: [
            for (final check in BackendCheck.values)
              if (status.resultFor(check) case final result?)
                _CheckRow(result: result, label: check.label),
          ],
        ),
      ],
    );
  }

  /// "Files" section: connection status, file browser navigation, and cache
  /// management (plan §3.14).
  Widget _buildFiles(BuildContext context) {
    final filesService = ref.watch(filesServiceProvider);
    final connected = filesService is! NoOpFilesClient;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Files', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        Row(
          children: [
            Icon(
              connected ? Icons.cloud_done : Icons.cloud_off,
              size: 20,
              color: connected
                  ? Colors.green.shade600
                  : Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                connected
                    ? 'Files service connected'
                    : 'Files service not configured',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: connected
                          ? Colors.green.shade700
                          : Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: _openFileBrowser,
                icon: const Icon(Icons.folder_open),
                label: const Text('File Browser'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _clearCache,
                icon: const Icon(Icons.delete_sweep_outlined),
                label: const Text('Clear Cache'),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// Pushes the [FilesScreen] file browser.
  void _openFileBrowser() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const FilesScreen()),
    );
  }

  /// Confirms and evicts expired cached files, then reports the result.
  Future<void> _clearCache() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear Cache'),
        content: const Text('Remove expired files from this device?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await ref.read(fileCacheProvider).evictExpired();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Cache cleared')),
    );
  }

  /// "Danger Zone" section: clears all saved settings after confirmation.
  Widget _buildDangerZone(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Danger Zone', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _clearSettings,
          icon: Icon(Icons.delete_outline, color: scheme.error),
          label: Text('Clear settings', style: TextStyle(color: scheme.error)),
        ),
      ],
    );
  }

  /// "Appearance" section: visual tier toggle (standard core vs premium
  /// paper-and-gold). Adding the section at the *end* of the list keeps the
  /// text-field indices used by the settings tests stable.
  Widget _buildAppearance(BuildContext context) {
    final theme = Theme.of(context);
    final tier = ref.watch(appTierProvider).value ?? AppTier.standard;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Appearance', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Text(
          'Premium: warm paper surfaces, gold accents, serif headlines.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        SegmentedButton<AppTier>(
          segments: const [
            ButtonSegment(
              value: AppTier.standard,
              label: Text('Standard'),
              icon: Icon(Icons.light_mode_outlined),
            ),
            ButtonSegment(
              value: AppTier.premium,
              label: Text('Premium'),
              icon: Icon(Icons.auto_awesome_outlined),
            ),
          ],
          selected: {tier},
          onSelectionChanged: (selection) {
            ref.read(appTierProvider.notifier).setTier(selection.first);
          },
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