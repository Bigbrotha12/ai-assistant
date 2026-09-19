import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_client.dart';
import '../../auth/data/auth_client_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../../core/backend_probe.dart';
import '../../../core/backend_settings.dart';
import '../../../core/backend_validation.dart';
import '../../../core/config.dart';
import '../../attachments/data/files_providers.dart';
import '../../attachments/data/files_service.dart';
import '../data/prefs_options.dart';
import '../data/prefs_providers.dart';
import '../data/prefs_store.dart';
import '../../../core/probe_providers.dart';
import '../data/settings_providers.dart';
import '../../../app/theme_providers.dart';
import '../../../app/widgets/app_logo.dart';
import '../../../app/widgets/probe_status_row.dart';
import '../../voice/data/voice_settings.dart';
import '../../voice/ui/voice_settings_providers.dart';
import '../../voice/ui/voice_settings_screen.dart';
import '../../attachments/ui/files_screen.dart';
import '../../auth/ui/auth_flow.dart';
import '../../plugins/ui/plugins_screen.dart';

/// App home screen: configure the gateway host for account services and
/// verify connectivity (auth on the gateway; inference/vision against the
/// build-time LLM_* API — see AGENTS.md).
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _hostController = TextEditingController();
  final _mcpSecretController = TextEditingController();
  final _filesSecretController = TextEditingController();
  final _storageUrlController = TextEditingController();

  bool _obscureMcpSecret = true;
  bool _obscureFilesSecret = true;
  bool _probing = false;
  bool _didAutoProbe = false;
  BackendStatus? _status;

  /// Dev vs production environment; saved together with the backend form and
  /// drives the http/https scheme used by every derived backend URI.
  BackendEnvironment _environment = BackendConfig.defaultEnvironment;

  /// Whether the account re-auth form ([AuthFlow]) is revealed in the Account
  /// section, and (when it is) whether it was opened by "Rotate key".
  bool _authFlowVisible = false;
  bool _authFlowForRotation = false;

  /// The key id / session token of the credentials being rotated, captured
  /// when "Rotate key" is tapped so the superseded key can be revoked once the
  /// rotation succeeds (the fresh session replaces them in the store).
  String? _rotationOldKeyId;
  String? _rotationOldSessionToken;

  /// Guards controller listeners until after [initState], when a setState()
  /// triggered by the initial field population is no longer needed.
  bool _formListenersActive = false;

  @override
  void initState() {
    super.initState();
    _hostController.addListener(_onFormChanged);
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
    _mcpSecretController.removeListener(_onFormChanged);
    _filesSecretController.removeListener(_onFormChanged);
    _storageUrlController.removeListener(_onFormChanged);
    _hostController.dispose();
    _mcpSecretController.dispose();
    _filesSecretController.dispose();
    _storageUrlController.dispose();
    super.dispose();
  }

  /// Fills the text controllers from [settings] unless the user already
  /// started editing.
  void _populateControllers(BackendSettings settings) {
    if (_hostController.text.isEmpty) {
      _hostController.text = settings.host;
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
      environment: _environment,
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

  /// Confirms and clears all saved settings (host, MCP, files token, storage URL).
  Future<void> _clearSettings() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear settings'),
        content: const Text('Clear saved host, MCP token, files token, and storage URL?'),
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
    try {
      await ref.read(authCredentialsProvider.notifier).clear();
      if (!mounted) return;
      await ref.read(settingsProvider.notifier).clear();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Could not finish clearing settings. Try again.'),
          action: SnackBarAction(label: 'Retry', onPressed: _clearSettings),
        ),
      );
      return;
    }
    if (!mounted) return;
    setState(() {
      _hostController.clear();
      _mcpSecretController.clear();
      _filesSecretController.clear();
      _storageUrlController.clear();
    });
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
      environment: BackendConfig.defaultEnvironment,
    );
    value.when(
      data: (settings) {
        _populateControllers(settings ?? fallback);
        _environment = (settings ?? fallback).environment;
        _maybeAutoProbe(settings);
      },
      error: (_, _) {
        _populateControllers(fallback);
        _environment = fallback.environment;
      },
      loading: () {},
    );
  }

  /// Shared AuthFlow completion handler for both "Sign in" and "Rotate key".
  /// The key was already minted and persisted by [AuthFlow]; here we only
  /// revoke the superseded key (rotation), collapse the form and confirm.
  Future<void> _onAuthSuccess(AuthSession session) async {
    final wasRotation = _authFlowForRotation;
    final oldKeyId = _rotationOldKeyId;
    final oldSessionToken = _rotationOldSessionToken;
    setState(() {
      _authFlowVisible = false;
      _authFlowForRotation = false;
      _rotationOldKeyId = null;
      _rotationOldSessionToken = null;
    });
    if (wasRotation) {
      // Best-effort server cleanup: revoke the superseded key (using the
      // fresh session, which belongs to the same account) and sign the old
      // session out. The new key is already persisted and usable, so a
      // failure here must not surface.
      final auth = ref.read(authClientProvider);
      try {
        if (oldKeyId != null) {
          await auth.revokeApiKey(sessionToken: session.token, keyId: oldKeyId);
        }
        if (oldSessionToken != null) {
          await auth.signOut(sessionToken: oldSessionToken);
        }
      } catch (_) {
        // Swallow: the old key stays server-side but is no longer used.
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(wasRotation ? 'New API key minted' : 'Signed in'),
      ),
    );
  }

  /// Client-side sign-out. Revokes the stored API key and signs the session
  /// out on the server (best-effort, so an unreachable gateway still signs
  /// out locally), then clears the persisted credentials. The clear is
  /// fail-closed: if local cleanup fails the user is offered a retry and no
  /// stale account state lingers.
  Future<void> _signOut() async {
    setState(() => _authFlowVisible = false);
    final creds = ref.read(authCredentialsProvider).value;
    // Snapshot the client (and creds) before any await: if the backend origin
    // changes mid-flight, the old key must never be sent to the new origin.
    final auth = ref.read(authClientProvider);
    if (creds != null) {
      final sessionToken = creds.sessionToken;
      final keyId = creds.keyId;
      try {
        if (sessionToken != null && keyId != null) {
          await auth.revokeApiKey(sessionToken: sessionToken, keyId: keyId);
        }
        if (sessionToken != null) {
          await auth.signOut(sessionToken: sessionToken);
        }
      } catch (_) {
        // Best-effort: revocation must not block local sign-out.
      }
    }
    try {
      await ref.read(authCredentialsProvider.notifier).clear();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Could not finish local sign-out. Try again.'),
          action: SnackBarAction(label: 'Retry', onPressed: _signOut),
        ),
      );
      return;
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Signed out')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    ref.listen(settingsProvider, _onSettingsChanged);

    final isLoading = settingsAsync.isLoading;
    final hostText = _hostController.text;
    final hostError = validateHost(hostText);
    final storageUrlError = validateStorageUrl(_storageUrlController.text);
    // Test and Save both require a structurally valid host and storage URL.
    final canTest = !isLoading && !_probing && hostError == null && storageUrlError == null;
    final canSave = canTest;

    return Scaffold(
      appBar: AppBar(title: const BrandAppBarTitle()),
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
                Text('Environment', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 8),
                SegmentedButton<BackendEnvironment>(
                  segments: const [
                    ButtonSegment(
                      value: BackendEnvironment.dev,
                      label: Text('Dev'),
                      icon: Icon(Icons.code),
                    ),
                    ButtonSegment(
                      value: BackendEnvironment.production,
                      label: Text('Production'),
                      icon: Icon(Icons.cloud_outlined),
                    ),
                  ],
                  selected: {_environment},
                  onSelectionChanged: (selection) {
                    setState(() => _environment = selection.first);
                  },
                ),
                const SizedBox(height: 4),
                Text(
                  'Controls the http/https scheme used by backend endpoints.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
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
                    errorText: validateStorageUrl(_storageUrlController.text),
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
                const SizedBox(height: 32),
                _buildGeneral(context),
                const SizedBox(height: 32),
                _buildAccount(context),
                const SizedBox(height: 32),
                _buildVoice(context),
                const SizedBox(height: 32),
                ListTile(
                  key: const Key('settings-plugins'),
                  leading: const Icon(Icons.extension_outlined),
                  title: const Text('Plugins'),
                  subtitle: const Text('Staged model and tool configuration'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const PluginsScreen()),
                  ),
                ),
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
                ProbeStatusRow(result: result, label: check.label),
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

  /// "General" section: preferred language (stored in voice settings) and date
  /// format (stored in prefs), symmetric with the Appearance section. Appended
  /// at the end of the list so the text-field indices used by the settings
  /// tests stay stable.
  Widget _buildGeneral(BuildContext context) {
    final theme = Theme.of(context);
    final voice =
         ref.watch(voiceSettingsProvider).value ?? VoiceSettings.defaults;
    final prefs = ref.watch(appPrefsProvider).value ?? const AppPrefs();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('General', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        InputDecorator(
          decoration: const InputDecoration(
            labelText: 'Language',
            helperText: 'Spoken language for voice conversations',
            border: OutlineInputBorder(),
          ),
          child: DropdownButton<String>(
            key: const Key('settings-language'),
            value: voice.preferredLanguage,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final (code, name) in languageOptions(voice.preferredLanguage))
                DropdownMenuItem(value: code, child: Text(name)),
            ],
            onChanged: (value) {
              if (value == null) return;
              ref.read(voiceSettingsProvider.notifier).save(
                    voice.copyWith(preferredLanguage: value),
                  );
            },
          ),
        ),
        const SizedBox(height: 16),
        InputDecorator(
          decoration: const InputDecoration(
            labelText: 'Date format',
            border: OutlineInputBorder(),
          ),
          child: DropdownButton<String>(
            key: const Key('settings-date-format'),
            value: prefs.dateFormat,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final (code, label) in dateFormatOptions(prefs.dateFormat))
                DropdownMenuItem(value: code, child: Text(label)),
            ],
            onChanged: (value) {
              if (value == null) return;
              ref.read(appPrefsProvider.notifier).save(
                    prefs.copyWith(dateFormat: value),
                  );
            },
          ),
        ),
      ],
    );
  }

  /// "Account" section: signed-in email (or a sign-in prompt) with Sign out /
  /// Rotate key actions. The shared [AuthFlow] mints and persists a fresh API
  /// key on success, so this section only reacts to the stored credentials.
  /// Appended at the end of the list so the text-field indices used by the
  /// settings tests stay stable.
  Widget _buildAccount(BuildContext context) {
    final theme = Theme.of(context);
    final creds = ref.watch(authCredentialsProvider).value;
    final signedIn = creds != null && creds.apiKey.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Account', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        if (signedIn) ...[
          Text(
            creds.email != null ? 'Signed in as ${creds.email}' : 'Signed in',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _signOut,
                  child: const Text('Sign out'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton(
                  onPressed: () {
                    final creds =
                        ref.read(authCredentialsProvider).value;
                    setState(() {
                      _authFlowForRotation = true;
                      _authFlowVisible = true;
                      // Remember what is being replaced so the superseded key
                      // can be revoked once the rotation completes.
                      _rotationOldKeyId = creds?.keyId;
                      _rotationOldSessionToken = creds?.sessionToken;
                    });
                  },
                  child: const Text('Rotate key'),
                ),
              ),
            ],
          ),
        ] else ...[
          Text(
            'Not signed in',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: () => setState(() {
              _authFlowForRotation = false;
              _authFlowVisible = true;
            }),
            child: const Text('Sign in'),
          ),
        ],
        if (_authFlowVisible) ...[
          const SizedBox(height: 16),
          if (signedIn)
            Text(
              'Sign in again to mint a new key.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          AuthFlow(onSuccess: _onAuthSuccess),
        ],
      ],
    );
  }

  /// "Voice" section: entry point to the voice conversation settings screen
  /// (the voice/chat home screens no longer carry settings in their top
  /// bars). Appended at the end of the list so the text-field indices used
  /// by the settings tests stay stable.
  Widget _buildVoice(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Voice', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        ListTile(
          key: const Key('settings-voice'),
          contentPadding: const EdgeInsets.symmetric(vertical: 4),
          leading: const Icon(Icons.mic),
          title: const Text('Voice conversation settings'),
          subtitle: const Text('Engines, VAD sensitivity, language'),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const VoiceSettingsScreen()),
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