import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_client.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../../core/backend_settings.dart';
import '../../../core/config.dart';
import '../../settings/data/prefs_options.dart';
import '../../settings/data/prefs_providers.dart';
import '../../settings/data/prefs_store.dart';
import '../../settings/data/settings_providers.dart';
import '../../../app/theme.dart';
import '../../auth/ui/auth_flow.dart';
import '../../voice/data/engine_config.dart';
import '../../voice/data/engine_manager.dart';
import '../../voice/data/engine_manager_provider.dart';
import '../../voice/data/model_downloader.dart';
import '../../voice/ui/voice_settings.dart';
import '../../voice/ui/voice_settings_providers.dart';

/// Onboarding flow (plan §3.5): a themed vertical [Stepper] that walks the
/// user through Account → Language & region → Voice & models → Finish, then
/// persists everything in the §3.6 order (voice settings, prefs, backend
/// settings last — the backend settings are derived from compile-time defaults
/// since the Backend step was removed: --dart-define values carry the host).
///
/// All form state — controllers, per-step selections — is hoisted on this
/// screen and disposed here (no `ref` in `dispose`, Riverpod v3 convention).
/// Back/Next preserve state because the controllers and selections live on
/// the state, not inside the steps.
///
/// The gate mounts `const OnboardingScreen()` with no arguments; this widget
/// keeps that exact contract.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  // -------------------------------------------------------------------------
  // Hoisted step state
  // -------------------------------------------------------------------------

  int _currentStep = 0;

  // Account.
  bool _accountReady = false;
  String? _accountEmail;

  // Region.
  String _language = 'en';
  bool _languageTouched = false;
  String _dateFormat = 'en-US';
  bool _dateFormatTouched = false;

  // Models.
  bool _downloading = false;

  // Finish.
  bool _saving = false;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _language = _inferLanguage();
    _dateFormat = _inferDateLocale();
    _checkStoredCredentials();
  }

  @override
  void dispose() {
    super.dispose();
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  Future<void> _checkStoredCredentials() async {
    final creds = await ref.read(authCredentialsStoreProvider).load();
    if (!mounted || creds == null || _accountReady) return;
    setState(() {
      _accountReady = true;
      _accountEmail = creds.email;
    });
  }

  String _inferLanguage() {
    final locale = WidgetsBinding.instance.platformDispatcher.locale;
    return locale.languageCode.isEmpty ? 'en' : locale.languageCode;
  }

  String _inferDateLocale() {
    final locale = WidgetsBinding.instance.platformDispatcher.locale;
    final country = locale.countryCode;
    if (country == null || country.isEmpty) {
      return locale.languageCode.isEmpty ? 'en-US' : locale.languageCode;
    }
    return '${locale.languageCode}-$country';
  }

  // -------------------------------------------------------------------------
  // Provider reactions (prefill from saved state; never clobber edits)
  // -------------------------------------------------------------------------

  void _onPrefsChanged(
    AsyncValue<AppPrefs>? previous,
    AsyncValue<AppPrefs> next,
  ) {
    if (next.isLoading || _dateFormatTouched) return;
    final saved = next.value?.dateFormat;
    if (saved != null && saved != _dateFormat) {
      setState(() => _dateFormat = saved);
    }
  }

  void _onVoiceSettingsChanged(
    AsyncValue<VoiceSettings?>? previous,
    AsyncValue<VoiceSettings?> next,
  ) {
    if (next.isLoading || _languageTouched) return;
    final saved = next.value?.preferredLanguage;
    if (saved != null && saved.isNotEmpty && saved != _language) {
      setState(() => _language = saved);
    }
  }

  // -------------------------------------------------------------------------
  // Step navigation
  // -------------------------------------------------------------------------

  void _goToStep(int next) {
    setState(() => _currentStep = next);
  }

  void _onStepContinue() {
    if (_currentStep >= _stepsLength - 1) {
      _getStarted();
    } else {
      _goToStep(_currentStep + 1);
    }
  }

  void _onStepCancel() {
    if (_currentStep > 0) _goToStep(_currentStep - 1);
  }

  static const int _stepsLength = 4;

  /// True when the "Next" button for [index] may advance.
  bool _canContinue(int index) => switch (index) {
        0 => _accountReady,
        _ => true,
      };

  // -------------------------------------------------------------------------
  // Account (via the shared AuthFlow)
  // -------------------------------------------------------------------------

  void _onAuthSuccess(AuthSession session) {
    setState(() {
      _accountReady = true;
      _accountEmail = session.email;
    });
  }

  Widget _buildAccountStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'The app talks to your gateway with a per-user API key. '
          'Sign in to an existing account or create one.',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 16),
        AuthFlow(onSuccess: _onAuthSuccess),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Language & region step
  // -------------------------------------------------------------------------

  Widget _buildRegionStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InputDecorator(
          decoration: const InputDecoration(
            labelText: 'Language',
            helperText: 'Spoken language for voice conversations',
            border: OutlineInputBorder(),
          ),
          child: DropdownButton<String>(
            key: const Key('ob-language'),
            value: _language,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final (code, name) in languageOptions(_language))
                DropdownMenuItem(value: code, child: Text(name)),
            ],
            onChanged: (value) {
              if (value != null) {
                setState(() {
                  _language = value;
                  _languageTouched = true;
                });
              }
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
            key: const Key('ob-date-format'),
            value: _dateFormat,
            isExpanded: true,
            isDense: true,
            underline: const SizedBox.shrink(),
            items: [
              for (final (code, label) in dateFormatOptions(_dateFormat))
                DropdownMenuItem(value: code, child: Text(label)),
            ],
            onChanged: (value) {
              if (value != null) {
                setState(() {
                  _dateFormat = value;
                  _dateFormatTouched = true;
                });
              }
            },
          ),
        ),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Voice & models step
  // -------------------------------------------------------------------------

  bool get _isDesktop =>
      !kIsWeb && (Platform.isLinux || Platform.isMacOS || Platform.isWindows);

  /// Prompts for download consent on mobile; desktop is auto-allowed. The size
  /// is shown up front so consent is informed.
  Future<bool> _requestDownloadConsent() async {
    if (_isDesktop) return true;
    final allowed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Download voice models?'),
        content: const Text(
          'Whisper tiny (~75 MB) enables on-device speech-to-text and '
          'Supertonic 3 (~145 MB) adds on-device text-to-speech. You can '
          'also download them later from Voice settings.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Not now'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Download'),
          ),
        ],
      ),
    );
    return allowed ?? false;
  }

  Future<void> _downloadModels() async {
    if (_downloading) return;
    if (!await _requestDownloadConsent()) return;
    setState(() => _downloading = true);
    try {
      await ref.read(voiceEngineStatusProvider.notifier).downloadAllModels();
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  /// Re-downloads only the Supertonic 3 model (targeted retry after a failed
  /// attempt) — Whisper is left untouched.
  Future<void> _retrySupertonicDownload() async {
    if (_downloading) return;
    if (!await _requestDownloadConsent()) return;
    setState(() => _downloading = true);
    try {
      await ref
          .read(voiceEngineStatusProvider.notifier)
          .downloadModel(EngineConfig.supertonic3Id);
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  Widget _buildVoiceStep() {
    final theme = Theme.of(context);
    final statuses = ref.watch(voiceEngineStatusProvider);
    final progress = ref.watch(modelDownloadProgressProvider).value;
    final stt =
        statuses[EngineConfig.whisperTinyId] ?? VoiceEngineStatus.notStarted;
    final supertonic = EngineConfig.supertonic3DownloadAvailable
        ? statuses[EngineConfig.supertonic3Id] ?? VoiceEngineStatus.notStarted
        : VoiceEngineStatus.unavailable;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Chat works without models; Whisper adds on-device speech input '
          'and Supertonic speech output. Download Whisper to recognise '
          'speech offline.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 16),
        _ModelRow(
          label: 'Whisper tiny',
          size: '~75 MB',
          status: stt,
          progress: progress,
          onAction: _downloading ? null : _downloadModels,
        ),
        const SizedBox(height: 8),
        _ModelRow(
          label: 'Supertonic 3',
          status: supertonic,
          progress: progress,
          // Without a retry action a failed Supertonic download would render
          // a permanently disabled Retry button.
          onAction: _downloading ? null : _retrySupertonicDownload,
        ),
        const SizedBox(height: 16),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => _goToStep(_currentStep + 1),
            child: const Text('Do it later'),
          ),
        ),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Finish step
  // -------------------------------------------------------------------------

  String get _modelsSummary {
    final stt = ref
            .read(voiceEngineStatusProvider)[EngineConfig.whisperTinyId] ??
        VoiceEngineStatus.notStarted;
    final sttLabel = switch (stt) {
      VoiceEngineStatus.ready => 'ready',
      VoiceEngineStatus.downloading => 'downloading…',
      VoiceEngineStatus.failed => 'failed',
      VoiceEngineStatus.unavailable => 'unavailable',
      VoiceEngineStatus.notStarted => 'not downloaded',
    };
    final supertonic = EngineConfig.supertonic3DownloadAvailable
        ? 'available'
        : 'unavailable';
    return 'Whisper tiny: $sttLabel · Supertonic: $supertonic';
  }

  Future<void> _getStarted() async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      // 1) Voice settings first (language is stored here, never in prefs).
      final current =
          ref.read(voiceSettingsProvider).value ?? const VoiceSettings();
      await ref
          .read(voiceSettingsProvider.notifier)
          .save(current.copyWith(preferredLanguage: _language));
      // 2) Prefs: date format + onboarding complete.
      await ref.read(appPrefsProvider.notifier).save(AppPrefs(
            dateFormat: _dateFormat,
            onboardingComplete: true,
          ));
      // 3) Backend settings LAST — only this flips the gate to "configured".
      //    The host and environment are derived from compile-time defaults
      //    (--dart-define HOST_FQDN / PUBLIC_BACKEND_URL); the onboarding
      //    flow no longer collects them interactively, so only the build-time
      //    defaults are persisted (mcpSecret/filesSecret/storageUrl are not).
      await ref.read(settingsProvider.notifier).save(BackendSettings(
            host: BackendConfig.defaultHost,
            environment: BackendConfig.defaultEnvironment,
          ));
      if (mounted) setState(() => _saving = false);
    } catch (e) {
      // Never wipe credentials, never leave onboarding: surface the failure
      // and let the user retry (writes are idempotent plain overwrites).
      if (!mounted) return;
      setState(() {
        _saving = false;
        _saveError = '$e';
      });
    }
  }

  Widget _buildFinishStep() {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Review your setup', style: theme.textTheme.titleMedium),
        const SizedBox(height: 12),
        _SummaryRow(label: 'Account email', value: _accountEmail ?? '—'),
        _SummaryRow(label: 'Language', value: _language),
        _SummaryRow(label: 'Date format', value: _dateFormat),
        _SummaryRow(label: 'Models', value: _modelsSummary),
        if (_saveError != null) ...[
          const SizedBox(height: 16),
          Material(
            color: scheme.errorContainer,
            borderRadius: BorderRadius.circular(AppRadii.lg),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Icon(Icons.error_outline, color: scheme.onErrorContainer),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Could not save your setup: $_saveError',
                      style: TextStyle(color: scheme.onErrorContainer),
                    ),
                  ),
                  TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: scheme.onErrorContainer,
                    ),
                    onPressed: _saving ? null : _getStarted,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Stepper assembly
  // -------------------------------------------------------------------------

  StepState _stepState(int index) =>
      index < _currentStep ? StepState.complete : StepState.indexed;

  Widget _controlsBuilder(
    BuildContext context,
    ControlsDetails details,
    int stepCount,
  ) {
    final isLast = details.stepIndex == stepCount - 1;
    final canContinue =
        isLast ? !_saving : _canContinue(details.stepIndex);
    return Row(
      children: [
        FilledButton(
          onPressed: canContinue ? details.onStepContinue : null,
          child: Text(isLast ? 'Get started' : 'Next'),
        ),
        if (details.stepIndex > 0) ...[
          const SizedBox(width: 8),
          TextButton(
            onPressed: details.onStepCancel,
            child: const Text('Back'),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(appPrefsProvider, _onPrefsChanged);
    ref.listen(voiceSettingsProvider, _onVoiceSettingsChanged);

    final steps = <Step>[
      Step(
        title: const Text('Account'),
        subtitle: const Text('Sign in or create your account'),
        isActive: _currentStep >= 0,
        state: _stepState(0),
        content: _buildAccountStep(),
      ),
      Step(
        title: const Text('Language & region'),
        subtitle: const Text('Preferred language and date format'),
        isActive: _currentStep >= 1,
        state: _stepState(1),
        content: _buildRegionStep(),
      ),
      Step(
        title: const Text('Voice & models'),
        subtitle: const Text('On-device model download'),
        isActive: _currentStep >= 2,
        state: _stepState(2),
        content: _buildVoiceStep(),
      ),
      Step(
        title: const Text('Finish'),
        subtitle: const Text('Review and get started'),
        isActive: _currentStep >= 3,
        state: _stepState(3),
        content: _buildFinishStep(),
      ),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('AI Assistant')),
      body: SafeArea(
        child: Stepper(
          type: StepperType.vertical,
          currentStep: _currentStep,
          onStepContinue: _onStepContinue,
          onStepCancel: _onStepCancel,
          controlsBuilder: (context, details) =>
              _controlsBuilder(context, details, steps.length),
          steps: steps,
        ),
      ),
    );
  }
}

/// Model status row: status icon, label, size/detail and optional action.
class _ModelRow extends StatelessWidget {
  const _ModelRow({
    required this.label,
    required this.status,
    this.size,
    this.progress,
    this.onAction,
  });

  final String label;
  final VoiceEngineStatus status;
  final String? size;
  final ModelDownloadProgress? progress;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final downloading = status == VoiceEngineStatus.downloading;
    final needsAction =
        status == VoiceEngineStatus.failed ||
        status == VoiceEngineStatus.notStarted;
    final actionLabel =
        status == VoiceEngineStatus.failed ? 'Retry' : 'Download';
    final percent = progress?.percent;

    final (icon, color, subtitle) = switch (status) {
      VoiceEngineStatus.ready => (
          Icons.check_circle,
          Colors.green.shade600,
          'ready',
        ),
      VoiceEngineStatus.downloading => (
          Icons.downloading,
          scheme.primary,
          percent == null
              ? 'downloading…'
              : 'downloading ${(percent * 100).round()}%',
        ),
      VoiceEngineStatus.failed => (
          Icons.error_outline,
          scheme.error,
          'download failed',
        ),
      VoiceEngineStatus.notStarted => (
          Icons.download_outlined,
          scheme.onSurfaceVariant,
          size == null ? 'not downloaded' : 'not downloaded · $size',
        ),
      VoiceEngineStatus.unavailable => (
          Icons.block,
          scheme.onSurfaceVariant,
          'unavailable',
        ),
    };

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: scheme.outline),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: theme.textTheme.labelLarge),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: theme.textTheme.bodySmall?.copyWith(color: color),
                ),
              ],
            ),
          ),
          if (downloading) ...[
            const SizedBox(width: 8),
            SizedBox(
              width: 90,
              child: LinearProgressIndicator(
                value: percent,
                minHeight: 4,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ] else if (needsAction) ...[
            TextButton(
              onPressed: onAction,
              child: Text(actionLabel),
            ),
          ],
        ],
      ),
    );
  }
}

/// Read-only label/value pair for the Finish summary.
class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(value, style: theme.textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}