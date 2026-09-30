import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/account_deleted_state.dart';
import '../../../app/theme.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../chat/data/chat_client.dart';
import '../../settings/data/settings_providers.dart';
import '../data/agent_config.dart';
import '../data/plugin_catalog_providers.dart';
import '../data/plugin_credentials_providers.dart';
import '../data/plugin_credentials_store.dart';
import '../data/plugin_dto.dart';
import 'agent_editor_screen.dart';

class PluginsScreen extends StatelessWidget {
  const PluginsScreen({super.key});

  @override
  Widget build(BuildContext context) => _PluginPage(
    title: 'Plugins',
    builder: (catalog, configuration) =>
        _PluginList(catalog: catalog, configuration: configuration),
  );
}

class _PluginPage extends ConsumerStatefulWidget {
  const _PluginPage({required this.title, required this.builder});

  final String title;
  final Widget Function(PluginCatalog, PluginAccountConfiguration) builder;

  @override
  ConsumerState<_PluginPage> createState() => _PluginPageState();
}

class _PluginPageState extends ConsumerState<_PluginPage> {
  /// Last successfully loaded data, so a background refresh (e.g. an agent
  /// selection bumping the credentials epoch) never unmounts the list into a
  /// spinner — the transition stays a quiet in-place update. The catalog is
  /// account-agnostic; the configuration is discarded when the signed-in
  /// account changes so a new account never briefly sees another's data.
  PluginCatalog? _catalog;
  PluginAccountConfiguration? _config;
  Object? _configKey;

  @override
  Widget build(BuildContext context) {
    final access = ref.watch(pluginAccessProvider);
    Widget body;
    switch (access) {
      case PluginAccess.loading:
        body = const Center(child: CircularProgressIndicator());
      case PluginAccess.signedOut:
        body = const Center(
          child: Text('Sign in from Settings to configure plugins.'),
        );
      case PluginAccess.reauthenticate:
        body = const Center(
          child: Text(
            'Sign in again from Settings to configure plugins for this account.',
          ),
        );
      case PluginAccess.error:
        body = _RetryNotice(
          message: 'Could not load account settings.',
          onRetry: () {
            ref.invalidate(settingsProvider);
            ref.invalidate(authCredentialsProvider);
          },
        );
      case PluginAccess.ready:
        final catalog = ref.watch(pluginCatalogProvider);
        final configuration = ref.watch(pluginCredentialsProvider);
        if (catalog.hasError || configuration.hasError) {
          final terminal =
              isAccountDeletedError(catalog.error) ||
              isAccountDeletedError(configuration.error);
          body = _RetryNotice(
            message: terminal ? accountDeletedNotice : 'Could not load plugins. Check your connection or sign in again from Settings.',
            onRetry: () {
              ref.invalidate(pluginCatalogProvider);
              ref.invalidate(pluginCredentialsProvider);
            },
          );
        } else {
          final authKey = ref.watch(authCredentialsProvider).value;
          if (!identical(_configKey, authKey)) {
            // Account changed: never reuse another account's configuration.
            _configKey = authKey;
            _config = null;
          }
          final catalogValue = catalog.value ?? _catalog;
          final configValue = configuration.value ?? _config;
          if (catalogValue == null || configValue == null) {
            // Genuinely nothing loaded yet (first load).
            body = const Center(child: CircularProgressIndicator());
          } else {
            _catalog = catalogValue;
            _config = configValue;
            body = KeyedSubtree(
              key: ObjectKey(authKey),
              child: widget.builder(catalogValue, configValue),
            );
          }
        }
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      // Bottom safe area so the gesture bar never overlaps the last row of a
      // subsection's scrollable, matching the settings About footer handling.
      body: SafeArea(top: false, child: body),
    );
  }
}

class _RetryNotice extends StatelessWidget {
  const _RetryNotice({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    ),
  );
}

class _PluginList extends ConsumerWidget {
  const _PluginList({required this.catalog, required this.configuration});
  final PluginCatalog catalog;
  final PluginAccountConfiguration configuration;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Keep the scoped handle alive for this screen: the selection write's
    // `_invalidate()` (which bumps the credentials epoch and refreshes the
    // list) only fires while that provider's ref is mounted. Without this
    // subscription the autoDispose handle dies during the write's async gap,
    // the epoch never advances, and selecting an agent would update storage
    // while the UI kept showing the previous selection.
    ref.watch(scopedPluginCredentialsProvider);
    final modelIds = catalog.models.map((model) => model.id).toSet();
    final selected = configuration.selectedModel;
    final selectedAgent = configuration.selectedAgent;
    final templates = ref.watch(agentTemplatesProvider);
    final readyAgents = _readyAgents(catalog, templates.value);
    final customAgents =
        configuration.plugins.entries
            .where(
              (e) =>
                  e.value.agent != null &&
                  e.value.agent!.kind == AgentKind.custom,
            )
            .toList()
          ..sort((a, b) => a.key.compareTo(b.key));
    return RadioGroup<String>(
      groupValue: selectedAgent,
      onChanged: (id) => _selectAgent(context, ref, id),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Choose the model, agents, and tools for your account.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          Text('Models', style: Theme.of(context).textTheme.titleMedium),
          if (modelIds.isEmpty)
            const Text(
              'No models available. Ask your administrator to install a model plugin.',
            ),
          if (selected != null && !modelIds.contains(selected))
            const Text(
              'Your selected model was removed or is unavailable. Select another model.',
            ),
          for (final plugin in catalog.plugins.where(
            (plugin) => modelIds.contains(plugin.id),
          ))
            _tile(
              context,
              plugin,
              selected == plugin.id
                  ? 'Selected for this account'
                  : plugin.inference!.defaultModel,
            ),
          const SizedBox(height: 16),
          Text('Agents', style: Theme.of(context).textTheme.titleMedium),
          Text(
            'The selected agent defines how the assistant behaves.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          Text('Ready-made', style: Theme.of(context).textTheme.titleSmall),
          if (templates.isLoading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('Loading agents…'),
            )
          else if (templates.hasError)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'Could not load agents. Refresh the catalog and retry.',
              ),
            )
          else if (readyAgents.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'No ready-made agents yet. Ask your administrator to add one.',
              ),
            )
          else
            for (final agent in readyAgents)
              _readyAgentTile(context, ref, agent, selectedAgent == agent.id),
          const SizedBox(height: 12),
          Text('Custom-made', style: Theme.of(context).textTheme.titleSmall),
          if (customAgents.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('You have not created any custom agents yet.'),
            )
          else
            for (final entry in customAgents)
              _customAgentTile(
                context,
                ref,
                entry.key,
                entry.value.agent!,
                selectedAgent == entry.key,
              ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => _openNewAgentEditor(context),
            icon: const Icon(Icons.add),
            label: const Text('Create agent'),
          ),
          const SizedBox(height: 12),
          const SizedBox(height: 12),
          Text('Tools', style: Theme.of(context).textTheme.titleMedium),
          Text(
            'Add the tools you want to use, or review the ones you have '
            'already set up.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            key: const Key('configured-tools'),
            onPressed: () => _openConfiguredTools(context),
            icon: const Icon(Icons.tune),
            label: const Text('Configured tools'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            key: const Key('tool-marketplace'),
            onPressed: () => _openToolMarketplace(context),
            icon: const Icon(Icons.storefront_outlined),
            label: const Text('Tool marketplace'),
          ),
          TextButton.icon(
            key: const Key('refresh-catalog'),
            onPressed: () => ref.invalidate(pluginCatalogProvider),
            icon: const Icon(Icons.refresh),
            label: const Text('Refresh catalog'),
          ),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Widget _readyAgentTile(
    BuildContext context,
    WidgetRef ref,
    _ReadyAgent agent,
    bool isSelected,
  ) => _AgentRow(
    key: ValueKey('ready-${agent.id}'),
    id: agent.id,
    name: agent.name,
    selected: isSelected,
    description: agent.description,
    skillCount: agent.skillCount,
    mcpCount: agent.mcpCount,
    toolCount: agent.toolCount,
    model: agent.model,
    // The whole row selects exclusively; the trailing button (installed agent
    // plugins only) opens the read-only details page.
    onTap: () => _selectAgent(context, ref, agent.id),
    trailing: agent.hasDetail
        ? IconButton(
            key: ValueKey('ready-details-${agent.id}'),
            tooltip: 'Agent details',
            icon: const Icon(Icons.info_outline),
            onPressed: () => _openAgentEditor(context, agent.id),
          )
        : null,
  );

  Widget _customAgentTile(
    BuildContext context,
    WidgetRef ref,
    String pluginId,
    AgentConfig agent,
    bool isSelected,
  ) => _AgentRow(
    key: ValueKey('custom-$pluginId'),
    id: pluginId,
    name: agent.name.isNotEmpty ? agent.name : pluginId,
    selected: isSelected,
    description: agent.description,
    skillCount: agent.skills.length,
    mcpCount: agent.mcpServers.length,
    toolCount: agent.tools.length,
    model: agent.modelRef,
    // Tapping the row selects it; the pencil opens its definition for editing.
    onTap: () => _selectAgent(context, ref, pluginId),
    trailing: IconButton(
      key: ValueKey('custom-edit-$pluginId'),
      tooltip: 'Edit agent',
      icon: const Icon(Icons.edit_outlined),
      onPressed: () => _openEditAgentEditor(context, pluginId, agent),
    ),
  );

  Future<void> _selectAgent(
    BuildContext context,
    WidgetRef ref,
    String? id,
  ) async {
    try {
      await ref.read(scopedPluginCredentialsProvider).selectAgent(id);
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not select the agent.')),
      );
    }
  }

  void _openAgentEditor(BuildContext context, String agentId) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _PluginPage(
          title: 'Agent details',
          builder: (catalog, configuration) {
            for (final agent in catalog.agents) {
              if (agent.id == agentId) {
                return _AgentEditor(key: ValueKey(agent.id), agent: agent);
              }
            }
            return const Center(
              child: Text(
                'This agent is no longer available. Return to Agents and refresh the catalog.',
              ),
            );
          },
        ),
      ),
    );
  }

  void _openNewAgentEditor(BuildContext context) {
    Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => const AgentEditorScreen()));
  }

  void _openEditAgentEditor(
    BuildContext context,
    String pluginId,
    AgentConfig agent,
  ) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AgentEditorScreen(existing: agent),
      ),
    );
  }

  void _openConfiguredTools(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _PluginPage(
          title: 'Configured tools',
          builder: (catalog, configuration) =>
              _ConfiguredTools(catalog: catalog, configuration: configuration),
        ),
      ),
    );
  }

  void _openToolMarketplace(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _PluginPage(
          title: 'Tool marketplace',
          builder: (catalog, configuration) =>
              _ToolMarketplace(catalog: catalog, configuration: configuration),
        ),
      ),
    );
  }

  Widget _tile(BuildContext context, PluginDto plugin, String subtitle) =>
      ListTile(
        key: ValueKey('plugin-${plugin.id}'),
        title: Text(plugin.name),
        subtitle: Text(
          !plugin.isSupported
              ? 'Unsupported plugin version'
              : !plugin.installed
              ? 'Not installed by administrator'
              : subtitle,
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: !plugin.installed || !plugin.isSupported
            ? null
            : () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => _PluginPage(
                    title: 'Configure plugin',
                    builder: (catalog, configuration) {
                      final current = catalog.installedPlugin(plugin.id);
                      if (current == null ||
                          current.type == 'model' &&
                              !catalog.models.any(
                                (model) => model.id == current.id,
                              )) {
                        return const Center(
                          child: Text(
                            'This plugin was removed or is unavailable. Return to Plugins and refresh the catalog.',
                          ),
                        );
                      }
                      return _PluginEditor(
                        key: ValueKey(current.id),
                        plugin: current,
                        configuration: configuration,
                      );
                    },
                  ),
                ),
              ),
      );
}

/// A server-provided agent as shown in the "Ready-made" list.
///
/// Merges the two server sources — gateway agent templates (`/v1/agents`) and
/// installed agent plugins (`/v1/plugins`) — which overlap for installed
/// plugins, so an agent is never listed twice.
class _ReadyAgent {
  const _ReadyAgent({
    required this.id,
    required this.name,
    required this.description,
    this.skillCount = 0,
    this.mcpCount = 0,
    this.toolCount = 0,
    this.model,
    this.hasDetail = false,
  });

  final String id;
  final String name;
  final String description;
  final int skillCount;
  final int mcpCount;
  final int toolCount;
  final String? model;

  /// True for an installed agent plugin, which has a read-only details page.
  final bool hasDetail;
}

/// Merges [catalog]'s installed agent plugins with the fetched [templates],
/// keyed by id so the overlap between the two sources yields one row. Template
/// data wins for the fields it carries (it is the list the gateway actually
/// resolves a selection against, and it adds MCP/skill counts); plugin-only
/// agents fall back to their `AgentDto`.
List<_ReadyAgent> _readyAgents(
  PluginCatalog catalog,
  List<Map<String, dynamic>>? templates,
) {
  final byId = <String, _ReadyAgent>{};
  for (final agent in catalog.agents) {
    byId[agent.id] = _ReadyAgent(
      id: agent.id,
      name: agent.name,
      description: agent.description,
      skillCount: agent.skillCount,
      toolCount: agent.toolGrants.length,
      model: agent.defaultModel,
      hasDetail: true,
    );
  }
  for (final template in templates ?? const <Map<String, dynamic>>[]) {
    final id = template['id'];
    if (id is! String || id.isEmpty) continue;
    final existing = byId[id];
    byId[id] = _ReadyAgent(
      id: id,
      name: template['name'] as String? ?? existing?.name ?? id,
      description:
          template['description'] as String? ?? existing?.description ?? '',
      skillCount: template['skillCount'] as int? ?? existing?.skillCount ?? 0,
      mcpCount:
          (template['mcpNames'] as List?)?.length ?? existing?.mcpCount ?? 0,
      toolCount:
          (template['toolGrants'] as List?)?.length ?? existing?.toolCount ?? 0,
      model: template['defaultModel'] as String? ?? existing?.model,
      hasDetail: existing?.hasDetail ?? false,
    );
  }
  final list = byId.values.toList()..sort((a, b) => a.id.compareTo(b.id));
  return list;
}

/// One selectable agent row. A leading radio makes the account's single
/// selected agent obvious and exclusive; tapping the row selects it, while an
/// optional [trailing] action opens the details or editor without changing the
/// selection.
///
/// Modern/minimal: name and actions on the first line, the description at full
/// width underneath, and capability counts as compact pills on a wrapping line
/// below that. The previous design squeezed the chips (skills / MCP / tools /
/// model) into the ListTile's `trailing` slot, which overflowed once an agent
/// had more than a couple of tools. Here the description owns the whole row and
/// the pills wrap, so a long model id can never starve anything else.
class _AgentRow extends StatelessWidget {
  const _AgentRow({
    super.key,
    required this.id,
    required this.name,
    this.description,
    this.selected = false,
    this.skillCount = 0,
    this.mcpCount = 0,
    this.toolCount = 0,
    this.model,
    this.onTap,
    this.trailing,
  });

  /// Selection value for the enclosing [RadioGroup].
  final String id;
  final String name;

  /// Shown unless [selected] (which replaces it with the selected line).
  final String? description;
  final bool selected;
  final int skillCount;
  final int mcpCount;
  final int toolCount;

  /// Model reference; rendered as a pill, shortened to its last path segment.
  final String? model;

  /// Selects this agent (the row tap; the radio handles itself via the group).
  final VoidCallback? onTap;

  /// Optional action (details / edit) pinned to the row's end.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final hasCounts =
        skillCount > 0 ||
        mcpCount > 0 ||
        toolCount > 0 ||
        (model?.isNotEmpty ?? false);
    return Material(
      color: selected
          ? scheme.primaryContainer.withValues(alpha: 0.45)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(AppRadii.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.sm,
            vertical: AppSpacing.md,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Radio<String>(value: id),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      selected
                          ? 'Selected for this account'
                          : (description?.isNotEmpty ?? false)
                          ? description!
                          : 'No description',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: selected
                            ? scheme.primary
                            : scheme.onSurfaceVariant,
                        fontWeight: selected ? FontWeight.w600 : null,
                      ),
                    ),
                    if (hasCounts) ...[
                      const SizedBox(height: AppSpacing.sm),
                      Wrap(
                        spacing: AppSpacing.sm,
                        runSpacing: AppSpacing.sm,
                        children: [
                          if (skillCount > 0) _Pill(text: '$skillCount skills'),
                          if (mcpCount > 0) _Pill(text: '$mcpCount MCP'),
                          if (toolCount > 0) _Pill(text: '$toolCount tools'),
                          if (model?.isNotEmpty ?? false)
                            _Pill(text: _shortModel(model!), dim: true),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: AppSpacing.xs),
                trailing!,
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// Keeps model ids readable: `provider/model-id` → `model-id`.
  static String _shortModel(String model) =>
      model.contains('/') ? model.substring(model.lastIndexOf('/') + 1) : model;
}

/// Keeps model ids readable: `provider/model-id` → `model-id`.
String _shortModelName(String model) =>
    model.contains('/') ? model.substring(model.lastIndexOf('/') + 1) : model;

/// Shows only enough of the stored key to tell WHICH one is in use — the
/// `sk-...` prefix and the last 4 chars — never the full secret.
String _maskKey(String key) {
  final k = key.trim();
  if (k.isEmpty) return '';
  if (k.length <= 8) return '••••••••';
  return '${k.substring(0, 6)}••••${k.substring(k.length - 4)}';
}

/// Compact count/label pill. Width is capped so a long model id or a big count
/// can never push a neighbor off its line — the Wrap handles the rest.
class _Pill extends StatelessWidget {
  const _Pill({required this.text, this.dim = false});

  final String text;

  /// Muted colour for model/technical pills; count pills use the primary hue.
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 180),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm,
          vertical: 2,
        ),
        decoration: BoxDecoration(
          color: scheme.surfaceContainer,
          borderRadius: BorderRadius.circular(AppRadii.lg),
        ),
        child: Text(
          text,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.labelSmall
              ?.copyWith(color: dim ? scheme.onSurfaceVariant : scheme.primary),
        ),
      ),
    );
  }
}

class _PluginEditor extends ConsumerStatefulWidget {
  const _PluginEditor({
    super.key,
    required this.plugin,
    required this.configuration,
  });
  final PluginDto plugin;
  final PluginAccountConfiguration configuration;

  @override
  ConsumerState<_PluginEditor> createState() => _PluginEditorState();
}

class _PluginEditorState extends ConsumerState<_PluginEditor> {
  final _keyController = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _keyController.clear();
    _keyController.dispose();
    super.dispose();
  }

  Future<void> _write(
    Future<void> Function(ScopedPluginCredentials) operation,
  ) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await operation(ref.read(scopedPluginCredentialsProvider));
      if (!mounted) return;
      _keyController.clear();
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _error = 'Could not save. Check your account and try again.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(scopedPluginCredentialsProvider);
    final plugin = widget.plugin;
    final saved = widget.configuration.plugins[plugin.id];
    final hasKey = saved?.credentials['apiKey']?.isNotEmpty ?? false;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(plugin.name, style: Theme.of(context).textTheme.headlineSmall),
        Text(plugin.description),
        const SizedBox(height: 16),
        if (plugin.type == 'model') ...[
          Text('Active model', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          // Full-width row: model name left, status right. No fill/tint so it
          // reads as a quiet status line rather than a highlighted chip.
          Container(
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: Theme.of(context).colorScheme.outlineVariant,
                ),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _shortModelName(plugin.inference!.defaultModel),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyLarge
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                if (widget.configuration.selectedModel == plugin.id)
                  Text(
                    'Active',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                else
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => _write(
                            (store) => store.setSelectedModel(plugin.id),
                          ),
                    child: const Text('Select'),
                  ),
              ],
            ),
          ),
        ] else
          SwitchListTile(
            title: const Text('Enable for this account'),
            value: saved?.enabled ?? false,
            onChanged: _busy
                ? null
                : (value) =>
                      _write((store) => store.setEnabled(plugin.id, value)),
          ),
        if (plugin.credentials case final credentials?) ...[
          const SizedBox(height: 16),
          if (hasKey) ...[
            Text(
              'Saved API key',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainer,
                      borderRadius: BorderRadius.circular(AppRadii.lg),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.key,
                          size: 16,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _maskKey(saved!.credentials['apiKey']!),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.labelLarge
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                IconButton(
                  key: const Key('remove-saved-key'),
                  tooltip: 'Remove saved API key',
                  icon: const Icon(Icons.delete_outline),
                  onPressed: _busy
                      ? null
                      : () => _write(
                          (store) => store.setCredentials(
                            plugin.id,
                            {...saved.credentials}..remove('apiKey'),
                          ),
                        ),
                ),
                const SizedBox(width: 4),
              ],
            ),
          ] else ...[
            Text(
              'No API key saved for this account.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('plugin-api-key'),
              controller: _keyController,
              enabled: !_busy,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.visiblePassword,
              decoration: InputDecoration(
                labelText: credentials.label,
                helperText: credentials.required
                    ? 'Required for this plugin'
                    : 'Optional',
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy || _keyController.text.trim().isEmpty
                  ? null
                  : () {
                      final fields = {
                        ...?saved?.credentials,
                        'apiKey': _keyController.text,
                      };
                      _write((store) async {
                        await store.setCredentials(plugin.id, fields);
                        if (plugin.type == 'model') {
                          // Re-read a fresh handle: setCredentials bumps the
                          // epoch, so the same handle would trip its own
                          // stale-guard and fail the selection write.
                          await ref
                              .read(scopedPluginCredentialsProvider)
                              .setSelectedModel(plugin.id);
                        }
                      });
                    },
              child: const Text('Save API key'),
            ),
          ],
        ],
        if (_busy) const LinearProgressIndicator(),
        if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
      ],
    );
  }
}

class _AgentEditor extends StatelessWidget {
  const _AgentEditor({super.key, required this.agent});

  final AgentDto agent;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(agent.name, style: Theme.of(context).textTheme.headlineSmall),
        Text(agent.description),
        const SizedBox(height: 16),
        if (agent.defaultModel case final model?) Text('Default model: $model'),
        if (agent.toolGrants.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            'Grants access to:',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          for (final grant in agent.toolGrants)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  if (grant.required)
                    Icon(
                      Icons.lock,
                      size: 16,
                      color: Theme.of(context).colorScheme.error,
                    ),
                  const SizedBox(width: 4),
                  Text(grant.pluginId),
                ],
              ),
            ),
        ],
        if (agent.skillCount > 0) ...[
          const SizedBox(height: 12),
          Text('Includes ${agent.skillCount} skill bundle(s)'),
        ],
        if (agent.temperature != null || agent.maxTokens != null) ...[
          const SizedBox(height: 12),
          Text('Settings:'),
          if (agent.temperature != null)
            Text('Temperature: ${agent.temperature}'),
          if (agent.maxTokens != null) Text('Max tokens: ${agent.maxTokens}'),
          Text('Vision: ${agent.visionCapable ? 'Yes' : 'No'}'),
        ],
        const SizedBox(height: 40),
      ],
    );
  }
}

/// Tools the account has set up (a saved key and/or enabled), with their
/// readiness. A tool the administrator has not installed never appears here.
class _ConfiguredTools extends ConsumerWidget {
  const _ConfiguredTools({required this.catalog, required this.configuration});

  final PluginCatalog catalog;
  final PluginAccountConfiguration configuration;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Keep the scoped handle alive so saving a key or toggling a tool refreshes
    // this page (and the list behind it) rather than silently writing storage.
    ref.watch(scopedPluginCredentialsProvider);
    final tools =
        catalog.plugins
            .where(
              (plugin) =>
                  plugin.type == 'tool' &&
                  plugin.installed &&
                  plugin.isSupported,
            )
            .where((plugin) => _hasConfiguration(plugin, configuration))
            .toList()
          ..sort((a, b) => a.name.compareTo(b.name));
    if (tools.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No tools set up yet. Open the Tool marketplace to add one.',
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final tool in tools)
          _ToolRow(
            key: ValueKey('configured-${tool.id}'),
            tool: tool,
            status: _toolStatus(tool, configuration),
            onTap: () => _openToolEditor(context, tool.id),
          ),
        const SizedBox(height: 40),
      ],
    );
  }
}

/// The administrator-curated tool catalog: searchable and grouped by category.
/// Tapping a tool opens its configuration; a configured tool reads "Ready" in
/// green.
class _ToolMarketplace extends ConsumerStatefulWidget {
  const _ToolMarketplace({required this.catalog, required this.configuration});

  final PluginCatalog catalog;
  final PluginAccountConfiguration configuration;

  @override
  ConsumerState<_ToolMarketplace> createState() => _ToolMarketplaceState();
}

class _ToolMarketplaceState extends ConsumerState<_ToolMarketplace> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(scopedPluginCredentialsProvider);
    final tools =
        widget.catalog.plugins
            .where(
              (plugin) =>
                  plugin.type == 'tool' &&
                  plugin.installed &&
                  plugin.isSupported,
            )
            .toList()
          ..sort((a, b) => a.name.compareTo(b.name));
    final query = _query.trim().toLowerCase();
    final matches = query.isEmpty
        ? tools
        : tools
              .where(
                (tool) =>
                    tool.name.toLowerCase().contains(query) ||
                    tool.description.toLowerCase().contains(query),
              )
              .toList();
    final grouped = <String, List<PluginDto>>{};
    for (final tool in matches) {
      grouped.putIfAbsent(_categoryOf(tool), () => []).add(tool);
    }
    final categories = grouped.keys.toList()
      ..sort((a, b) {
        if (a == _defaultCategory) return -1;
        if (b == _defaultCategory) return 1;
        return a.compareTo(b);
      });

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'Tools your administrator has made available. Add one to use it.',
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        // Keep the chrome light for a handful of tools; the filter box only
        // earns its space once the catalog is long.
        if (tools.length > 8) ...[
          TextField(
            key: const Key('tool-search'),
            controller: _search,
            decoration: const InputDecoration(
              hintText: 'Search tools',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
            onChanged: (value) => setState(() => _query = value),
          ),
          const SizedBox(height: 8),
        ],
        if (tools.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text(
              'No tools are available yet. Ask your administrator to add some.',
            ),
          )
        else if (matches.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text('No tools match your search.'),
          )
        else
          for (final category in categories) ...[
            Padding(
              padding: const EdgeInsets.only(top: 16, bottom: 4),
              child: Text(
                category,
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            for (final tool in grouped[category]!)
              _ToolRow(
                key: ValueKey('market-${tool.id}'),
                tool: tool,
                status: _toolStatus(tool, widget.configuration),
                onTap: () => _openToolEditor(context, tool.id),
              ),
          ],
        const SizedBox(height: 40),
      ],
    );
  }
}

/// A single tool row: name, description, and a status pill — "Ready" in green
/// when the account has it configured, "Add" when available, "Needs setup"
/// when a key or the enable toggle is still missing.
class _ToolRow extends StatelessWidget {
  const _ToolRow({
    super.key,
    required this.tool,
    required this.status,
    this.onTap,
  });

  final PluginDto tool;
  final _ToolStatus status;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (label, color) = switch (status) {
      _ToolStatus.ready => ('Ready', AppColors.accent),
      _ToolStatus.needsSetup => ('Needs setup', scheme.error),
      _ToolStatus.available => ('Add', scheme.primary),
    };
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
      title: Text(tool.name),
      subtitle: Text(
        tool.description,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _StatusPill(text: label, color: color),
          const SizedBox(width: 4),
          Icon(Icons.chevron_right, size: 20, color: scheme.onSurfaceVariant),
        ],
      ),
      onTap: onTap,
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// Readiness of a tool for this account.
enum _ToolStatus {
  /// Enabled and (when required) holding a key: it can actually run.
  ready,

  /// Some configuration exists but it is not usable yet (enabled without a
  /// required key, or a key saved while disabled).
  needsSetup,

  /// No account configuration yet.
  available,
}

/// Bucket for tools without a category. Everything ships as "General" for now;
/// administrators refine the taxonomy over time as more categories appear.
const _defaultCategory = 'General';

String _categoryOf(PluginDto tool) {
  final category = tool.category?.trim();
  return (category == null || category.isEmpty) ? _defaultCategory : category;
}

bool _hasConfiguration(
  PluginDto tool,
  PluginAccountConfiguration configuration,
) {
  final entry = configuration.plugins[tool.id];
  if (entry == null) return false;
  final hasKey = entry.credentials['apiKey']?.trim().isNotEmpty ?? false;
  return hasKey || entry.enabled;
}

_ToolStatus _toolStatus(
  PluginDto tool,
  PluginAccountConfiguration configuration,
) {
  final entry = configuration.plugins[tool.id];
  final hasKey = entry?.credentials['apiKey']?.trim().isNotEmpty ?? false;
  final enabled = entry?.enabled ?? false;
  final requiresKey = tool.credentials?.required ?? false;
  if (enabled && (!requiresKey || hasKey)) return _ToolStatus.ready;
  if (hasKey || enabled) return _ToolStatus.needsSetup;
  return _ToolStatus.available;
}

/// Opens the tool's setup page (key + enablement).
void _openToolEditor(BuildContext context, String pluginId) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => _PluginPage(
        title: 'Tool setup',
        builder: (catalog, configuration) {
          final current = catalog.installedPlugin(pluginId);
          if (current == null || current.type != 'tool') {
            return const Center(
              child: Text(
                'This tool is no longer available. Return and refresh the catalog.',
              ),
            );
          }
          return _PluginEditor(
            key: ValueKey(current.id),
            plugin: current,
            configuration: configuration,
          );
        },
      ),
    ),
  );
}
