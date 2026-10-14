import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_file/open_file.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../auth/data/account_deleted_handler.dart';
import '../../auth/data/account_deleted_state.dart';
import '../../auth/data/account_lifecycle.dart';
import '../../auth/data/auth_client.dart';
import '../../auth/data/auth_client_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../../core/backend_probe.dart';
import '../../../core/backend_settings.dart';
import '../../../core/backend_validation.dart';
import '../../../core/config.dart';
import '../../attachments/data/files_providers.dart';
import '../../attachments/data/files_service.dart';
import '../../chat/data/database_providers.dart';
import '../data/account_export.dart';
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
import '../../auth/ui/sign_in_screen.dart';
import '../../auth/ui/verify_email_card.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_http.dart';
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
  final _filesSecretController = TextEditingController();
  final _storageUrlController = TextEditingController();

  /// Resolved once and reused by the About footer.
  final Future<PackageInfo> _packageInfo = PackageInfo.fromPlatform();

  bool _obscureFilesSecret = true;
  bool _probing = false;
  bool _didAutoProbe = false;
  bool _exporting = false;
  BackendStatus? _status;

  /// Dev vs production environment; saved together with the backend form and
  /// drives the http/https scheme used by every derived backend URI.
  BackendEnvironment _environment = BackendConfig.defaultEnvironment;

  /// Guards controller listeners until after [initState], when a setState()
  /// triggered by the initial field population is no longer needed.
  bool _formListenersActive = false;

  @override
  void initState() {
    super.initState();
    _hostController.addListener(_onFormChanged);
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
    _filesSecretController.removeListener(_onFormChanged);
    _storageUrlController.removeListener(_onFormChanged);
    _hostController.dispose();
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
    _didAutoProbe = true;
    if (!mounted) return;
    setState(() {
      _probing = true;
      _status = null;
    });
    const failureStatus = BackendStatus(
      checks: [
        CheckResult(
          check: BackendCheck.auth,
          status: ProbeStatus.error,
          detail: 'probe failed',
        ),
        CheckResult(
          check: BackendCheck.inference,
          status: ProbeStatus.error,
          detail: 'probe failed',
        ),
        CheckResult(
          check: BackendCheck.vision,
          status: ProbeStatus.error,
          detail: 'probe failed',
        ),
        CheckResult(
          check: BackendCheck.health,
          status: ProbeStatus.error,
          detail: 'probe failed',
        ),
      ],
    );
    var status = failureStatus;
    try {
      status = await ref.read(backendProbeProvider).probe(settings);
      if (status.hasAuthenticatedAccountDeletedSignal) {
        await ref
            .read(accountDeletedHandlerProvider)
            .handle(
              const PluginClientException(
                ManagedErrorCodes.accountDeleted,
                statusCode: 403,
              ),
            );
      }
    } catch (_) {
      status = failureStatus;
    } finally {
      if (mounted) {
        setState(() {
          _probing = false;
          _status = status;
        });
      }
    }
  }

  Future<void> _testConnection() async {
    await _runProbe(_settingsFromForm());
  }

  BackendSettings _settingsFromForm() => BackendSettings(
    host: _hostController.text,
    environment: _environment,
    // The MCP token is deliberately not collected any more: it was stored but
    // read by nothing (the gateway owns MCP server-side), i.e. dead config.
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
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Could not save settings')));
      return;
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Settings saved')));
    await _runProbe(settings);
  }

  /// Confirms and clears all saved settings (host, MCP, files token, storage URL).
  Future<void> _clearSettings() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear settings'),
        content: const Text(
          'Clear saved host, files token, and storage URL?',
        ),
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
      _filesSecretController.clear();
      _storageUrlController.clear();
    });
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Settings cleared')));
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

  Future<void> _openAccount({required bool rotation}) async {
    final oldCredentials = rotation
        ? ref.read(authCredentialsProvider).value
        : null;
    final session = await Navigator.of(context).push<AuthSession>(
      MaterialPageRoute(builder: (_) => SignInScreen(rotation: rotation)),
    );
    if (session == null || !mounted) return;
    await _onAuthSuccess(
      session,
      wasRotation: rotation,
      oldCredentials: oldCredentials,
    );
  }

  Future<void> _onAuthSuccess(
    AuthSession session, {
    required bool wasRotation,
    AuthCredentials? oldCredentials,
  }) async {
    var warning = false;
    if (wasRotation) {
      final auth = ref.read(authClientProvider);
      final oldSessionToken = oldCredentials?.sessionToken;
      try {
        final oldKeyId = await _resolveRotationKeyId(
          auth,
          sessionToken: session.token,
          oldCredentials: oldCredentials,
        );
        if (oldKeyId == null ||
            oldKeyId == ref.read(authCredentialsProvider).value?.keyId) {
          warning = true;
        } else {
          await auth.revokeApiKey(sessionToken: session.token, keyId: oldKeyId);
        }
      } catch (_) {
        warning = true;
      }
      try {
        if (oldSessionToken != null) {
          await auth.signOut(sessionToken: oldSessionToken);
        }
      } catch (_) {}
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          warning
              ? 'New API key minted, but the old key could not be identified '
                    'or revoked.'
              : wasRotation
              ? 'New API key minted'
              : 'Signed in',
        ),
      ),
    );
  }

  Future<String?> _resolveRotationKeyId(
    AuthClient auth, {
    required String sessionToken,
    required AuthCredentials? oldCredentials,
  }) async {
    if (oldCredentials == null) return null;
    final storedKeyId = oldCredentials.keyId;
    if (storedKeyId != null && storedKeyId.isNotEmpty) return storedKeyId;
    final keys = await auth.listApiKeys(sessionToken: sessionToken);
    final match = matchStoredApiKey(oldCredentials, keys);
    if (match.ambiguous) {
      debugPrint(
        'Settings: legacy API key match is ambiguous; old key not revoked.',
      );
    }
    return match.entry?.id;
  }

  /// Client-side sign-out. Revokes the stored API key and signs the session
  /// out on the server (best-effort, so an unreachable gateway still signs
  /// out locally), then clears the persisted credentials. The clear is
  /// fail-closed: if local cleanup fails the user is offered a retry and no
  /// stale account state lingers.
  Future<void> _signOut() async {
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
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Signed out')));
  }

  /// Client-side conversation export (M12): serializes the active account's
  /// conversations to a timestamped JSON document under
  /// `<documents>/exports/`, then opens it with the platform opener. The
  /// snackbar reports the path either way so the file is never lost behind a
  /// failed open.
  Future<void> _exportData() async {
    if (_exporting) return;
    setState(() => _exporting = true);
    try {
      final creds = ref.read(authCredentialsProvider).value;
      final conversations = await ref
          .read(chatStoreProvider)
          .watchConversations()
          .first;
      if (!mounted) return;
      final exporter = ref.read(accountExporterProvider);
      final result = await exporter.export(
        conversations: conversations,
        backendOrigin:
            creds?.backendOrigin ?? ref.read(authBackendOriginProvider),
        userId: creds?.ownerId,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Export saved to ${result.path}')));
      // Best-effort: never block the snackbar (or the busy flag) on the
      // platform opener — a hung/missing channel must not hide the path.
      unawaited(OpenFile.open(result.path).then((_) {}, onError: (_) {}));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not export conversations')),
      );
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  /// Opens the password-confirmation dialog for account deletion. The dialog
  /// returns the message to show in a snackbar (null = cancelled).
  Future<void> _confirmDeleteAccount() async {
    final message = await showDialog<String>(
      context: context,
      builder: (_) => _DeleteAccountDialog(onDelete: _deleteAccount),
    );
    if (message == null || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// Runs after the server confirmed deletion (invoked by the dialog).
  ///
  /// Fail-closed: local wipe only runs AFTER a confirmed 200 — a network
  /// failure must not destroy local data while the account still exists
  /// server-side.
  Future<void> _deleteAccount(String password) async {
    final creds = ref.read(authCredentialsProvider).value;
    final scope = creds?.accountScope;
    if (scope == null) {
      throw StateError('Authenticated account scope unavailable');
    }
    final auth = ref.read(authClientProvider);
    final sessionToken = creds?.sessionToken ?? '';
    try {
      await auth.deleteAccount(sessionToken: sessionToken, password: password);
    } on AuthAccountDeleted catch (error) {
      await ref.read(accountDeletedHandlerProvider).handle(error);
      rethrow;
    }
    await wipeLocalAccountData(
      scope: scope,
      lifecycle: ref.read(accountLifecycleProvider),
      clearCredentials: () =>
          ref.read(authCredentialsProvider.notifier).clear(),
      fileStore: ref.read(filesStoreProvider),
      memoryStore: ref.read(memoryStoreProvider),
      fileCache: ref.read(fileCacheProvider),
    );
  }

  @override
  Widget build(BuildContext context) {
    final settingsAsync = ref.watch(settingsProvider);
    ref.listen(settingsProvider, _onSettingsChanged);

    final isLoading = settingsAsync.isLoading;

    return Scaffold(
      appBar: AppBar(title: const BrandAppBarTitle()),
      body: Column(
        children: [
          if (isLoading) const LinearProgressIndicator(minHeight: 2),
          if (settingsAsync.hasError) const _SettingsLoadErrorBanner(),
          Expanded(
            child: SafeArea(
              // The About footer must not sit under the gesture bar; the App
              // Bar already handles the top inset.
              top: false,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                _buildAccount(context),
                const SizedBox(height: 32),
                _buildAppearance(context),
                const SizedBox(height: 32),
                _buildGeneral(context),
                const SizedBox(height: 32),
                _buildAiAndVoice(context),
                const SizedBox(height: 32),
                _buildFiles(context),
                const SizedBox(height: 32),
                _buildConnectivity(context),
                const SizedBox(height: 32),
                _buildDangerZone(context),
                const SizedBox(height: 32),
                _buildAbout(context),
                // Extra room under the version footer so it never touches the
                // device gesture bar even before the SafeArea inset applies.
                const SizedBox(height: 40),
              ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// "Advanced" section: the backend/connectivity form, collapsed under an
  /// expansion tile. Demoted from the top of the screen — the deployed gateway
  /// is the default, so this surface exists for self-hosting and debugging.
  /// The probe results render directly beneath the form that produced them.
  Widget _buildConnectivity(BuildContext context) {
    final theme = Theme.of(context);
    final hostError = validateHost(_hostController.text);
    final storageUrlError = validateStorageUrl(_storageUrlController.text);
    final canEdit = !ref.watch(settingsProvider).isLoading;
    final canRun = canEdit && !_probing && hostError == null &&
        storageUrlError == null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Advanced', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          clipBehavior: Clip.antiAlias,
          child: ExpansionTile(
            key: const Key('settings-advanced'),
            title: const Text('Backend & connectivity'),
            subtitle: const Text('Host, environment, files token, storage'),
            leading: const Icon(Icons.dns_outlined),
            shape: const Border(),
            collapsedShape: const Border(),
            childrenPadding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            children: [
              TextField(
                key: const Key('settings-host'),
                controller: _hostController,
                enabled: canEdit,
                decoration: InputDecoration(
                  labelText: 'Backend host',
                  hintText: 'tailnet IP or MagicDNS name',
                  border: const OutlineInputBorder(),
                  errorText: hostError,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Environment',
                style: theme.textTheme.titleSmall,
              ),
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
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('settings-files-token'),
                controller: _filesSecretController,
                enabled: canEdit,
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
                      () => _obscureFilesSecret = !_obscureFilesSecret,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('Storage', style: theme.textTheme.titleSmall),
              const SizedBox(height: 8),
              TextField(
                key: const Key('settings-storage-url'),
                controller: _storageUrlController,
                enabled: canEdit,
                decoration: InputDecoration(
                  labelText: 'Storage service URL (optional)',
                  hintText: 'e.g. http://minio:9000',
                  border: const OutlineInputBorder(),
                  helperText: 'Leave blank to use <host>:17603',
                  errorText: storageUrlError,
                ),
                keyboardType: TextInputType.url,
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      onPressed: canRun ? _testConnection : null,
                      child: const Text('Test connection'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: canRun ? _save : null,
                      child: const Text('Save'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              _buildResults(context),
            ],
          ),
        ),
      ],
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
        if (status.overall == ProbeStatus.emailNotVerified)
          VerifyEmailCard(
            email: ref.watch(authCredentialsProvider).value?.email,
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
        Text('Files & data', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        Text(
          // Short enough to be skipped, plain enough to answer "what goes
          // here": files attached in conversations, stored on your gateway.
          'Files you attach in conversations live here on your gateway.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
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
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const FilesScreen()));
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
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Cache cleared')));
  }

  /// "Danger Zone" section: clears all saved settings after confirmation,
  /// and (when signed in) deletes the account after a password confirmation.
  Widget _buildDangerZone(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final signedIn =
        (ref.watch(authCredentialsProvider).value?.apiKey.isNotEmpty ?? false);
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
        if (signedIn) ...[
          const SizedBox(height: 8),
          OutlinedButton.icon(
            key: const Key('settings-delete-account'),
            onPressed: _confirmDeleteAccount,
            icon: Icon(Icons.no_accounts_outlined, color: scheme.error),
            label: Text(
              'Delete account',
              style: TextStyle(color: scheme.error),
            ),
          ),
        ],
      ],
    );
  }

  /// "Appearance" section: visual tier toggle (standard core vs premium
  /// paper-and-gold). Plays a preference row near the top — identity first,
  /// then how the app looks, then the more technical surfaces below.
  Widget _buildAppearance(BuildContext context) {
    final theme = Theme.of(context);
    final tier = ref.watch(appTierProvider).value ?? AppTier.standard;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Appearance', style: theme.textTheme.titleSmall),
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
  /// format (stored in prefs), symmetric with the Appearance section.
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
            border: OutlineInputBorder(),
          ),
          child: DropdownButton<String>(
            key: const Key('settings-language'),
            value: voice.preferredLanguage,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final (code, name) in languageOptions(
                voice.preferredLanguage,
              ))
                DropdownMenuItem(value: code, child: Text(name)),
            ],
            onChanged: (value) {
              if (value == null) return;
              ref
                  .read(voiceSettingsProvider.notifier)
                  .save(voice.copyWith(preferredLanguage: value));
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
              ref
                  .read(appPrefsProvider.notifier)
                  .save(prefs.copyWith(dateFormat: value));
            },
          ),
        ),
      ],
    );
  }

  /// "Account" section: identity first — signed-in email (or a sign-in
  /// prompt) with Sign out / Rotate key / Export actions. Signing in and
  /// rotating keys open the dedicated [SignInScreen]; the shared [AuthFlow]
  /// inside it mints and persists a fresh API key on success, so this section
  /// only reacts to the stored credentials.
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
          if (ref.watch(keyExpiryWarningProvider)) ...[
            const SizedBox(height: 8),
            Text(
              'API key expiring soon — sign in again to rotate it.',
              key: const Key('settings-key-expiry-warning'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
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
                  onPressed: () => _openAccount(rotation: true),
                  child: const Text('Rotate key'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            key: const Key('settings-export-data'),
            onPressed: _exporting ? null : _exportData,
            icon: const Icon(Icons.download_outlined),
            label: Text(_exporting ? 'Exporting…' : 'Export my data'),
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
            onPressed: () => _openAccount(rotation: false),
            child: const Text('Sign in'),
          ),
        ],
      ],
    );
  }

  /// "AI & voice" section: the two capability entries — voice settings and
  /// the plugins screen (models & tools). Grouped as one block so feature
  /// entry points sit together, distinct from preferences above and
  /// connectivity below.
  Widget _buildAiAndVoice(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('AI & voice', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              ListTile(
                key: const Key('settings-voice'),
                leading: const Icon(Icons.mic),
                title: const Text('Voice conversation settings'),
                subtitle: const Text('Engines, VAD sensitivity, language'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const VoiceSettingsScreen(),
                  ),
                ),
              ),
              const Divider(height: 1),
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
    );
  }

  /// "About" section: app identity and version. Deliberately the final
  /// section, below the danger zone, mirroring the OS convention of a quiet
  /// version footer at the very end.
  Widget _buildAbout(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('About', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        FutureBuilder<PackageInfo>(
          future: _packageInfo,
          builder: (context, snapshot) {
            final info = snapshot.data;
            return Text(
              '${'Voice Assist'}'
              '${info == null ? '' : ' · ${info.version} (${info.buildNumber})'}',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            );
          },
        ),
        const SizedBox(height: 4),
        Text(
          'Connect your own AI Assistant gateway, models and tools.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// Password-confirmation dialog for account deletion (M12): collects the
/// password, runs [onDelete] (server delete + local wipe), and surfaces an
/// INVALID_PASSWORD rejection inline so the dialog stays open for a retry.
/// Every other failure — network, session, partial local wipe — is returned
/// to the caller as the snackbar message.
class _DeleteAccountDialog extends StatefulWidget {
  const _DeleteAccountDialog({required this.onDelete});

  /// Runs the server delete + local wipe for [password]; throws on failure.
  final Future<void> Function(String password) onDelete;

  @override
  State<_DeleteAccountDialog> createState() => _DeleteAccountDialogState();
}

class _DeleteAccountDialogState extends State<_DeleteAccountDialog> {
  final _passwordController = TextEditingController();
  bool _busy = false;
  String? _fieldError;

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final password = _passwordController.text;
    if (password.isEmpty) {
      setState(() => _fieldError = 'Enter your password');
      return;
    }
    setState(() {
      _busy = true;
      _fieldError = null;
    });
    try {
      await widget.onDelete(password);
      if (!mounted) return;
      Navigator.of(context).pop('Account deleted');
    } on AuthApiError catch (e) {
      if (!mounted) return;
      if (e.code == 'INVALID_PASSWORD') {
        setState(() {
          _busy = false;
          _fieldError = 'Incorrect password';
        });
        return;
      }
      Navigator.of(context).pop(_failureMessage(e));
    } on PartialAccountWipe {
      if (!mounted) return;
      Navigator.of(context)
          .pop('Account deleted, but some local data could not be cleared.');
    } catch (_) {
      if (!mounted) return;
      Navigator.of(context).pop('Could not delete the account. Try again.');
    }
  }

  static String _failureMessage(AuthApiError e) {
    if (e is AuthAccountDeleted) return accountDeletedNotice;
    if (e is AuthUnauthorized || e.code == 'SESSION_EXPIRED') {
      return 'Your session has expired. Sign in again to delete your account.';
    }
    if (e is AuthNetworkError) {
      return 'Could not reach the server. The account was not deleted — try again.';
    }
    return 'Could not delete the account. Try again.';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: const Text('Delete account'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Permanently deletes this account and its data on the server, '
            'plus conversations, files, and memories on this device. '
            'This cannot be undone.',
          ),
          const Text(
            'Only this account’s conversations, attachments, memories, and '
            'cached files are removed. Data belonging to other accounts on '
            'this device is kept.',
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('delete-account-password'),
            controller: _passwordController,
            obscureText: true,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            enabled: !_busy,
            decoration: InputDecoration(
              labelText: 'Password',
              border: const OutlineInputBorder(),
              errorText: _fieldError,
            ),
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          key: const Key('delete-account-submit'),
          onPressed: _busy ? null : _submit,
          child: _busy
              ? SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: scheme.error,
                  ),
                )
              : const Text('Delete'),
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
