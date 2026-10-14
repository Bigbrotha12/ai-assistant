import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/engine_config.dart';
import '../data/engine_manager.dart';
import '../data/engine_manager_provider.dart';
import '../data/engine_registry.dart';
import '../data/voice_runtime_policy_provider.dart';
import '../data/stt_engine.dart';
import '../data/voice_settings.dart';
import './voice_settings_providers.dart';

/// Configuration screen for the voice conversation feature: engine selection,
/// VAD sensitivity and preferred language. Follows the visual patterns of
/// [SettingsScreen] (ListView form, outlined fields, Save button row).
class VoiceSettingsScreen extends ConsumerStatefulWidget {
  const VoiceSettingsScreen({super.key});

  @override
  ConsumerState<VoiceSettingsScreen> createState() =>
      _VoiceSettingsScreenState();
}

class _VoiceSettingsScreenState extends ConsumerState<VoiceSettingsScreen> {
  late String _sttEngine;
  late String _ttsEngine;
  late double _vadSensitivity;
  late String _language;
  late double _minTurnSeconds;
  late bool _visionEnabled;

  @override
  void initState() {
    super.initState();
    _applyDefaults();
    final saved = ref.read(voiceSettingsProvider).value;
    if (saved != null) {
      _apply(saved);
    }
  }

  void _applyDefaults() {
    final defaults = VoiceSettings.defaults;
    _sttEngine = defaults.sttEngine;
    _ttsEngine = defaults.ttsEngine;
    _vadSensitivity = defaults.vadSensitivity;
    _language = defaults.preferredLanguage;
    _minTurnSeconds = defaults.minTurnSeconds;
    _visionEnabled = defaults.visionEnabled;
  }

  void _apply(VoiceSettings settings) {
    _sttEngine = settings.sttEngine;
    _ttsEngine = settings.ttsEngine;
    _vadSensitivity = settings.vadSensitivity;
    _language = settings.preferredLanguage;
    _minTurnSeconds = settings.minTurnSeconds;
    _visionEnabled = settings.visionEnabled;
  }

  /// Repopulates the form from the persisted provider (fires after a save,
  /// reset or external change). Fields are always non-blank because the
  /// provider falls back to in-code defaults.
  void _onSettingsChanged(
    AsyncValue<VoiceSettings?>? previous,
    AsyncValue<VoiceSettings?> next,
  ) {
    final saved = next.value;
    if (saved == null) {
      _applyDefaults();
    } else {
      _apply(saved);
    }
    setState(() {});
  }

  /// Registered engine ids when the registry has been initialised, otherwise a
  /// static fallback list. The current selection is always kept in the list so
  /// the dropdown value never runs ahead of its items.
  List<String> _sttOptions() {
    final registered = EngineRegistry.instance.sttEngineIds.toList();
    final ids = registered.isEmpty ? [EngineConfig.whisperTinyId] : registered;
    return ids.contains(_sttEngine) ? ids : [...ids, _sttEngine];
  }

  List<String> _ttsOptions() {
    final registered = EngineRegistry.instance.ttsEngineIds.toList();
    final ids = registered.isEmpty ? [EngineConfig.supertonic3Id] : registered;
    return ids.contains(_ttsEngine) ? ids : [...ids, _ttsEngine];
  }

  /// Language options for [engineId]: the registered engine's curated
  /// [SttEngine.supportedLanguages], falling back to the English-only base
  /// list when the engine id is unknown/not registered (or declares none).
  List<({String code, String label})> _sttLanguagesFor(String engineId) {
    final supported = EngineRegistry.instance
        .getSttEngine(engineId)
        ?.supportedLanguages;
    return (supported == null || supported.isEmpty)
        ? kBaseSttSupportedLanguages
        : supported;
  }

  /// The "Preferred language" field: options come from the selected engine's
  /// curated list; the value is resolved against it so a persisted code the
  /// engine does not support renders (and saves) as the fallback.
  Widget _languageField() {
    final languages = _sttLanguagesFor(_sttEngine);
    final languageValue = resolveSttLanguage(_language, languages);
    return InputDecorator(
      decoration: const InputDecoration(
        labelText: 'Preferred language',
        helperText: 'Language spoken during voice conversations',
        border: OutlineInputBorder(),
      ),
      child: DropdownButton<String>(
        value: languageValue,
        isExpanded: true,
        isDense: true,
        underline: const SizedBox.shrink(),
        items: [
          for (final lang in languages)
            DropdownMenuItem(value: lang.code, child: Text(lang.label)),
        ],
        onChanged: (value) {
          if (value != null) setState(() => _language = value);
        },
      ),
    );
  }

  Future<void> _save() async {
    final settings = VoiceSettings(
      sttEngine: _sttEngine,
      ttsEngine: _ttsEngine,
      vadSensitivity: _vadSensitivity,
      // Re-resolve at persist time so an engine switch can never save a
      // language code the selected engine does not support.
      preferredLanguage: resolveSttLanguage(
        _language,
        _sttLanguagesFor(_sttEngine),
      ),
      minTurnSeconds: _minTurnSeconds,
      visionEnabled: _visionEnabled,
    );
    try {
      await ref.read(voiceSettingsProvider.notifier).save(settings);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not save voice settings')),
      );
      return;
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Voice settings saved')));
  }

  Future<void> _reset() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Reset voice settings'),
        content: const Text('Restore default engine and language settings?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Reset'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await ref.read(voiceSettingsProvider.notifier).reset();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not reset voice settings')),
      );
      return;
    }
    _applyDefaults();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(voiceSettingsProvider, _onSettingsChanged);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Voice Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          InputDecorator(
            decoration: const InputDecoration(
              labelText: 'STT Engine',
              helperText:
                  'Speech-to-text model used for on-device '
                  'transcription',
              border: OutlineInputBorder(),
            ),
            child: DropdownButton<String>(
              value: _sttEngine,
              isExpanded: true,
              isDense: true,
              underline: const SizedBox.shrink(),
              items: [
                for (final id in _sttOptions())
                  DropdownMenuItem(value: id, child: Text(id)),
              ],
              onChanged: (value) {
                if (value == null) return;
                setState(() {
                  _sttEngine = value;
                  // The persisted language may not be offered by the
                  // newly-selected engine — fall back deterministically at
                  // switch time so Save never persists an unsupported code.
                  _language = resolveSttLanguage(
                    _language,
                    _sttLanguagesFor(value),
                  );
                });
              },
            ),
          ),
          const SizedBox(height: 16),
          InputDecorator(
            decoration: const InputDecoration(
              labelText: 'TTS Engine',
              helperText: 'Text-to-speech model used for spoken replies',
              border: OutlineInputBorder(),
            ),
            child: DropdownButton<String>(
              value: _ttsEngine,
              isExpanded: true,
              isDense: true,
              underline: const SizedBox.shrink(),
              items: [
                for (final id in _ttsOptions())
                  DropdownMenuItem(value: id, child: Text(id)),
              ],
              onChanged: (value) {
                if (value != null) setState(() => _ttsEngine = value);
              },
            ),
          ),
          const SizedBox(height: 24),
          Text('VAD sensitivity', style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            'Adjusts how readily speech is detected; easing it also delays '
            'when silence ends an utterance.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Slider(
            value: _vadSensitivity,
            min: 0,
            max: 1,
            divisions: 20,
            label: _vadSensitivity.toStringAsFixed(2),
            onChanged: (value) => setState(() => _vadSensitivity = value),
          ),
          const SizedBox(height: 16),
          _languageField(),
          const SizedBox(height: 24),
          Text('Vision', style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          SwitchListTile(
            title: const Text('Describe images automatically'),
            subtitle: Text(
              'Use a vision model to describe attached images for the AI',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            value: _visionEnabled,
            onChanged: (value) => setState(() => _visionEnabled = value),
          ),
          const SizedBox(height: 16),
          Text('Min silence (seconds)', style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            'How long silence must last before the turn ends. '
            'Shorter values end turns faster but may cut off speech.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Slider(
            value: _minTurnSeconds,
            min: 0.1,
            max: 3.0,
            divisions: 28,
            label: _minTurnSeconds.toStringAsFixed(1),
            onChanged: (value) => setState(() => _minTurnSeconds = value),
          ),
          const SizedBox(height: 24),
          const _ModelsSection(),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _save,
                  child: const Text('Save'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton(
                  onPressed: _reset,
                  child: const Text('Reset'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// On-device model download status section: per-model readiness chips plus a
/// download/retry action and live progress. Mirrors the voice screen's engine
/// status bar so users can manage models from settings without starting a
/// conversation.
class _ModelsSection extends ConsumerStatefulWidget {
  const _ModelsSection();

  @override
  ConsumerState<_ModelsSection> createState() => _ModelsSectionState();
}

class _ModelsSectionState extends ConsumerState<_ModelsSection> {
  bool _busy = false;

  Future<void> _downloadAll() async {
    if (_busy || !ref.read(voiceRuntimeDecisionProvider).allowModelDownload) {
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(voiceEngineStatusProvider.notifier).downloadAllModels();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Confirms, then deletes [modelId]'s downloaded files so the model can be
  /// re-downloaded (e.g. to exercise the download UI again).
  Future<void> _confirmRemoveModel(
    BuildContext context,
    String modelId,
    String label,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Remove $label model?'),
        content: Text(
          'This deletes the downloaded $label model files from this device. '
          'You can download them again later.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await ref.read(voiceEngineStatusProvider.notifier).deleteModel(modelId);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statuses = ref.watch(voiceEngineStatusProvider);
    final progress = ref.watch(modelDownloadProgressProvider).value;
    final decision = ref.watch(voiceRuntimeDecisionProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('On-device models', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _ModelStatusChip(
                label: 'Whisper',
                status:
                    statuses[EngineConfig.whisperTinyId] ??
                    VoiceEngineStatus.notStarted,
                progress: progress?[EngineConfig.whisperTinyId],
                onAction: _busy || !decision.allowModelDownload
                    ? null
                    : _downloadAll,
                onRemove: _busy
                    ? null
                    : () => _confirmRemoveModel(
                        context,
                        EngineConfig.whisperTinyId,
                        'Whisper',
                      ),
              ),
            ),
            const SizedBox(width: 12),
            if (statuses[EngineConfig.supertonic3Id] !=
                VoiceEngineStatus.unavailable) ...[
              Expanded(
                child: _ModelStatusChip(
                  label: 'Supertonic 3',
                  status:
                      statuses[EngineConfig.supertonic3Id] ??
                      VoiceEngineStatus.notStarted,
                  progress: progress?[EngineConfig.supertonic3Id],
                  onAction: _busy || !decision.allowModelDownload
                      ? null
                      : _downloadAll,
                  onRemove: _busy
                      ? null
                      : () => _confirmRemoveModel(
                          context,
                          EngineConfig.supertonic3Id,
                          'Supertonic 3',
                        ),
                ),
              ),
            ],
          ],
        ),
        if (!decision.allowModelDownload && decision.downloadNotice != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              decision.downloadNotice!,
              style: theme.textTheme.bodySmall,
            ),
          ),
        if (_busy) ...[
          const SizedBox(height: 8),
          const LinearProgressIndicator(minHeight: 2),
        ],
      ],
    );
  }
}

/// Single model readiness chip: status icon, label, and download/retry action.
class _ModelStatusChip extends StatelessWidget {
  const _ModelStatusChip({
    required this.label,
    required this.status,
    required this.progress,
    required this.onAction,
    this.onRemove,
  });

  final String label;
  final VoiceEngineStatus status;

  /// Overall progress (0.0–1.0) for THIS model only; null when the model is
  /// not currently downloading.
  final double? progress;
  final VoidCallback? onAction;

  /// Shown when the model is ready: deletes its files so it can be
  /// re-downloaded.
  final VoidCallback? onRemove;

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
    final percent = progress;

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
        'not downloaded',
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
        color: scheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: color, size: 18),
              const SizedBox(width: 6),
              Expanded(child: Text(label, style: theme.textTheme.labelLarge)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(color: color),
          ),
          if (needsAction) ...[
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: onAction,
                icon: const Icon(Icons.download, size: 18),
                label: Text(actionLabel),
              ),
            ),
          ] else if (downloading) ...[
            const SizedBox(height: 8),
            LinearProgressIndicator(value: percent, minHeight: 4),
          ] else if (status == VoiceEngineStatus.ready && onRemove != null) ...[
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: ValueKey('remove-model-$label'),
                onPressed: onRemove,
                icon: const Icon(Icons.delete_outline, size: 16),
                label: const Text('Remove'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
