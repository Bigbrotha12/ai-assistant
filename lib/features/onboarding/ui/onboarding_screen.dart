import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/account_deleted_state.dart';
import '../../auth/data/auth_client.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../../core/backend_settings.dart';
import '../../../core/config.dart';
import '../../settings/data/prefs_options.dart';
import '../../settings/data/prefs_providers.dart';
import '../../settings/data/prefs_store.dart';
import '../../settings/data/settings_providers.dart';
import '../../../app/theme.dart';
import '../../../app/widgets/app_logo.dart';
import '../../auth/ui/auth_flow.dart';
import '../../voice/data/engine_config.dart';
import '../../voice/data/engine_manager.dart';
import '../../voice/data/engine_manager_provider.dart';
import '../../voice/data/model_downloader.dart';
import '../../voice/data/voice_settings.dart';
import '../../voice/ui/voice_settings_providers.dart';
import '../../../app/widgets/app_buttons.dart';
import '../../../app/widgets/step_dots.dart';

/// Onboarding flow (plan §3.5): a dot-stepped flow that walks the user through
/// Account → Language & region → Voice & models → Finish, then persists
/// everything in the §3.6 order (voice settings, prefs, backend settings last —
/// the backend settings are derived from compile-time defaults since the
/// Backend step was removed: --dart-define values carry the host).
///
/// **Layout:** one step per card in a [PageView], a [StepDots] indicator under
/// the app bar, and a single full-width CTA in a sticky action bar. This
/// replaced Material's `Stepper`, which renders each step's controls *inline
/// inside its own body* — step 1's buttons ended up flush against step 2's
/// header, and the bare `Row` of buttons carried no surrounding padding and so
/// bled into whatever sat beside it. Card-per-step removes both failure modes
/// and guarantees exactly one primary action per step.
///
/// All form state — controllers, per-step selections — is hoisted on this
/// screen and disposed here (no `ref` in `dispose`, Riverpod v3 convention).
/// Back/Next preserve state because the controllers and selections live on
/// the state, not inside the steps.
///
/// The gate mounts `const OnboardingScreen()` with no arguments; this widget
/// keeps that exact contract.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key, this.accountDeleted = false});

  final bool accountDeleted;

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  // -------------------------------------------------------------------------
  // Hoisted step state
  // -------------------------------------------------------------------------

  /// Drives the [PageView] of step cards and the [StepDots] indicator. The
  /// visible page is the source of truth for the current index; this only
  /// animates between pages.
  final PageController _pageController = PageController();

  /// Lets the sticky CTA drive auth when the Account step hides [AuthFlow]'s
  /// own submit button (two stacked filled buttons read as competing
  /// primaries).
  final GlobalKey<AuthFlowState> _authKey = GlobalKey<AuthFlowState>();

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
    _pageController.dispose();
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

  /// Animates to [next] and mirrors it into [_currentStep].
  ///
  /// [_currentStep] is only used for the action bar's enabled/label state,
  /// which must flip the instant the button is tapped rather than waiting for
  /// the page animation to settle.
  void _goToStep(int next) {
    final target = next.clamp(0, _stepsLength - 1);
    if (target == _currentStep) return;
    setState(() => _currentStep = target);
    _pageController.animateToPage(
      target,
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
    );
  }

  void _onStepContinue() {
    if (_currentStep == _accountStepIndex) {
      // Already authenticated (a stored key): there is nothing to submit, so
      // the CTA just advances. Otherwise it drives the form, and
      // [_onAuthSuccess] advances once the key is persisted.
      if (_accountReady) {
        _goToStep(_accountStepIndex + 1);
      } else {
        _authKey.currentState?.submit();
      }
      return;
    }
    if (_currentStep >= _stepsLength - 1) {
      _getStarted();
    } else {
      _goToStep(_currentStep + 1);
    }
  }

  void _onStepCancel() {
    if (_currentStep > 0) _goToStep(_currentStep - 1);
  }

  /// Dots are tappable, but only *backwards* (or to the current step). Jumping
  /// forward past a step whose validation has not run — e.g. skipping the
  /// account sign-in — would let the user reach Finish unauthenticated.
  void _onDotTapped(int index) {
    if (index <= _currentStep) _goToStep(index);
  }

  static const int _accountStepIndex = 0;
  static const int _stepsLength = 4;

  // -------------------------------------------------------------------------
  // Account (via the shared AuthFlow)
  // -------------------------------------------------------------------------

  void _onAuthSuccess(AuthSession session) {
    setState(() {
      _accountReady = true;
      _accountEmail = session.email;
    });
    // The CTA drove this submit, so success is what advances the flow.
    if (_currentStep == _accountStepIndex) _goToStep(_accountStepIndex + 1);
  }

  Widget _buildDeletedAccountStep() {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      key: const Key('account-deleted-notice'),
      color: scheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.person_off_outlined, color: scheme.onErrorContainer),
            const SizedBox(height: 12),
            Text(
              accountDeletedNotice,
              style: theme.textTheme.titleMedium?.copyWith(
                color: scheme.onErrorContainer,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'This account can no longer be used. Start a new account to '
              'continue.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onErrorContainer,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _startNewAccount() async {
    final terminalState = ref.read(accountDeletedProvider.notifier);
    await terminalState.resetForNewAccount();
    if (!mounted) return;
    try {
      await ref
          .read(authCredentialsProvider.notifier)
          .clear(preserveAccountDeleted: true);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not clear the deleted account. Try again.'),
          ),
        );
      }
      return;
    }
    if (!mounted) return;
    _goToStep(_accountStepIndex);
  }

  Widget _buildAccountStep() {
    if (widget.accountDeleted) return _buildDeletedAccountStep();
    return AuthFlow(
      key: _authKey,
      // The sticky action bar owns the primary button, so the form renders
      // without one and [_onStepContinue] drives submit instead.
      showSubmit: false,
      onSuccess: _onAuthSuccess,
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
        const SizedBox(height: AppSpacing.lg),
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
          'and Supertonic speech output. You can download these later from '
          'Voice settings.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        _ModelRow(
          label: 'Whisper tiny',
          size: '~75 MB',
          status: stt,
          progress: progress,
          onAction: _downloading ? null : _downloadModels,
        ),
        const SizedBox(height: AppSpacing.sm),
        _ModelRow(
          label: 'Supertonic 3',
          status: supertonic,
          progress: progress,
          // Without a retry action a failed Supertonic download would render
          // a permanently disabled Retry button.
          onAction: _downloading ? null : _retrySupertonicDownload,
        ),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Finish step
  // -------------------------------------------------------------------------

  String get _modelsSummary {
    final stt =
        ref.read(voiceEngineStatusProvider)[EngineConfig.whisperTinyId] ??
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
          ref.read(voiceSettingsProvider).value ?? VoiceSettings.defaults;
      await ref
          .read(voiceSettingsProvider.notifier)
          .save(current.copyWith(preferredLanguage: _language));
      // 2) Prefs: date format + onboarding complete.
      await ref
          .read(appPrefsProvider.notifier)
          .save(AppPrefs(dateFormat: _dateFormat, onboardingComplete: true));
      // 3) Backend settings LAST — only this flips the gate to "configured".
      //    The host and environment are derived from compile-time defaults
      //    (--dart-define HOST_FQDN / PUBLIC_BACKEND_URL); the onboarding
      //    flow no longer collects them interactively, so only the build-time
      //    defaults are persisted (mcpSecret/filesSecret/storageUrl are not).
      await ref
          .read(settingsProvider.notifier)
          .save(
            BackendSettings(
              host: BackendConfig.defaultHost,
              environment: BackendConfig.defaultEnvironment,
            ),
          );
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
        const SizedBox(height: AppSpacing.md),
        _SummaryRow(label: 'Account email', value: _accountEmail ?? '—'),
        _SummaryRow(label: 'Language', value: _language),
        _SummaryRow(label: 'Date format', value: _dateFormat),
        _SummaryRow(label: 'Models', value: _modelsSummary),
        if (_saveError != null) ...[
          const SizedBox(height: AppSpacing.lg),
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
  // Card-per-step assembly
  // -------------------------------------------------------------------------

  /// Per-step heading copy. Kept beside the step builders so the card header
  /// and the dot indicator can never drift out of sync with the content.
  List<({String title, String subtitle})> get _stepMeta => [
        (
          title: widget.accountDeleted ? 'Account deleted' : 'Sign in',
          subtitle: widget.accountDeleted
              ? 'This account is no longer available.'
              : 'The app talks to your gateway with a per-user API key.',
        ),
        (
          title: 'Language & region',
          subtitle: 'Set the spoken language and how dates are shown.',
        ),
        (
          title: 'Voice & models',
          subtitle: 'Download the on-device models for offline speech.',
        ),
        (
          title: 'Review & finish',
          subtitle: 'Check your setup, then start using the app.',
        ),
      ];

  /// The step card bodies, in order.
  List<Widget> get _stepBodies => [
        _buildAccountStep(),
        _buildRegionStep(),
        _buildVoiceStep(),
        _buildFinishStep(),
      ];

  /// The sticky bar under the card: one full-width primary action, plus Back
  /// when there is somewhere to go back to.
  ///
  /// Every edge here is inset by [AppSpacing.lg] and separated from the card by
  /// a hairline, so nothing is flush against the screen or the card above it.
  Widget _buildActionBar(int step) {
    if (widget.accountDeleted) {
      return FilledButton.icon(
        key: const Key('account-deleted-new-account'),
        style: AppButtons.cta,
        onPressed: _startNewAccount,
        icon: const Icon(Icons.person_add_alt_1),
        label: const Text('Create a new account'),
      );
    }
    final isLast = step == _stepsLength - 1;
    // Gating differs by role, so it is spelled out rather than funnelled
    // through one predicate:
    //  - Account: the CTA *is* the submit, and [AuthFlow] owns validation
    //    (empty fields show an inline error). Disabling it would hide that.
    //  - Finish: gated on the save not already being in flight, so a double
    //    tap cannot start two write sequences.
    //  - Middle steps: nothing to validate, always live.
    final submitting =
        step == _accountStepIndex &&
            (_authKey.currentState?.isSubmitting ?? false);
    final enabled = isLast ? !_saving : true;
    return Row(
      children: [
        if (step > 0) ...[
          TextButton(
            onPressed: _onStepCancel,
            style: AppButtons.text,
            child: const Text('Back'),
          ),
          const SizedBox(width: AppSpacing.sm),
        ],
        Expanded(
          child: FilledButton(
            key: const Key('onboarding-primary'),
            style: AppButtons.cta,
            onPressed: enabled && !submitting ? _onStepContinue : null,
            child: Text(
              // Step 0's CTA submits the form rather than advancing, so it is
              // labelled for what it does — unless a stored key already made
              // the account ready, in which case it does advance.
              step == _accountStepIndex && !_accountReady
                  ? 'Sign in'
                  : isLast
                      ? 'Get started'
                      : 'Next',
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(appPrefsProvider, _onPrefsChanged);
    ref.listen(voiceSettingsProvider, _onVoiceSettingsChanged);

    // A deleted account pins the flow to the first card until cleared.
    final step = widget.accountDeleted ? _accountStepIndex : _currentStep;
    final meta = _stepMeta;
    final bodies = _stepBodies;

    return Scaffold(
      appBar: AppBar(title: const BrandAppBarTitle()),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
              child: StepDots(
                controller: _pageController,
                count: _stepsLength,
                index: step,
                onDotTapped: _onDotTapped,
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.lg,
                  0,
                  AppSpacing.lg,
                  AppSpacing.lg,
                ),
                child: PageView.builder(
                  controller: _pageController,
                  itemCount: _stepsLength,
                  // Swiping is disabled: these cards host a keyboard, a
                  // SegmentedButton and dropdowns, and a horizontal drag
                  // competes with all three (and can dismiss the keyboard
                  // mid-edit). Next/Back and the dots drive navigation.
                  physics: const NeverScrollableScrollPhysics(),
                  itemBuilder: (context, index) => _StepCard(
                    eyebrow: 'Step ${index + 1} of $_stepsLength',
                    title: meta[index].title,
                    subtitle: meta[index].subtitle,
                    child: bodies[index],
                  ),
                ),
              ),
            ),
            // Hairline + inset padding: the action bar never touches the card
            // above it or the screen edges.
            DecoratedBox(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(
                    color: Theme.of(context).colorScheme.outline,
                  ),
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: _buildActionBar(step),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One step's card: eyebrow, heading, sub-heading, then the step's own body.
///
/// The body is scrollable because the Account step's form (plus the soft
/// keyboard) can exceed the available height on a small phone; the card
/// borders stay pinned so the layout never breaks.
///
/// Keeps itself alive once visited ([AutomaticKeepAliveClientMixin]). A
/// [PageView] disposes off-screen pages by default, which would tear down the
/// Account step's `AuthFlow` — and with it the text the user already typed —
/// the moment they advanced. Hoisting the controllers to the screen is the
/// alternative, but they belong to the form that owns them; keeping the page
/// alive is both smaller and truer to the widget that owns the state.
class _StepCard extends StatefulWidget {
  const _StepCard({
    required this.eyebrow,
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final String eyebrow;
  final String title;
  final String subtitle;
  final Widget child;

  @override
  State<_StepCard> createState() => _StepCardState();
}

class _StepCardState extends State<_StepCard>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.eyebrow.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(widget.title, style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs),
            Text(
              widget.subtitle,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.xl),
            Expanded(
              child: SingleChildScrollView(child: widget.child),
            ),
          ],
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
    final actionLabel = status == VoiceEngineStatus.failed
        ? 'Retry'
        : 'Download';
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
            TextButton(onPressed: onAction, child: Text(actionLabel)),
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
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}
